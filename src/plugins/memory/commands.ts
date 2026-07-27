import type { Context, Session } from 'koishi';
import type {
  MemoryAddress,
  MemoryLedgerItem,
  MemoryV2AuditRecord,
} from '../../types/memory.js';
import type { ModelRuntimeClient } from '../model-config/index.js';
import type { MemoryRuntimeConfig } from './config.js';
import {
  resolveCurrentMemoryAudience,
  resolveExplicitMemoryAudiences,
} from './address.js';
import { buildMemoryReferenceBlock } from './format.js';
import type { MemoryStatusService } from './status.js';
import type { MemoryEmbeddingIdentity, MemoryStore } from './store.js';

function commandAddress(session: Session): MemoryAddress | null {
  const userId = session.userId?.trim();
  const botSelfId = session.bot?.selfId?.trim() || session.selfId?.trim();
  const platform = session.platform?.trim() || 'unknown';
  if (!userId || !botSelfId) return null;
  if (session.isDirect) {
    return {
      userKey: `${platform}:user:${userId}`,
      contextKey: `${platform}:bot:${botSelfId}:dm:${userId}`,
      channelType: 'direct',
      platform,
      botSelfId,
      userId,
      groupId: null,
      channelId: session.channelId?.trim() || null,
      rawContextId: session.channelId?.trim() || userId,
      conversationId: `command:${session.messageId ?? Date.now()}`,
      currentAudienceSubjectKeys: [`${platform}:user:${userId}`],
      observedAt: Date.now(),
    };
  }
  const groupKey = session.guildId?.trim() || session.channelId?.trim();
  if (!groupKey) return null;
  return {
    userKey: `${platform}:user:${userId}`,
    contextKey: `${platform}:bot:${botSelfId}:group:${groupKey}`,
    channelType: 'group',
    platform,
    botSelfId,
    userId,
    groupId: session.guildId?.trim() || null,
    channelId: session.channelId?.trim() || null,
    rawContextId: groupKey,
    conversationId: `command:${session.messageId ?? Date.now()}`,
    currentAudienceSubjectKeys: null,
    observedAt: Date.now(),
  };
}

function embeddingIdentity(modelRuntime: ModelRuntimeClient): MemoryEmbeddingIdentity | null {
  const binding = modelRuntime.resolve('memory.embedding');
  if (!binding.target) return null;
  return {
    canonicalModel: binding.target.canonicalModel,
    modelRevision: binding.revision,
  };
}

function maintenanceMessage(runtime: MemoryRuntimeConfig): string | null {
  return runtime.maintenance ? '记忆系统处于维护模式，此操作暂不可用。' : null;
}

function assertOperational(runtime: MemoryRuntimeConfig): string | undefined {
  return maintenanceMessage(runtime) ?? undefined;
}

function parseWhy(row: MemoryV2AuditRecord | null): string {
  if (!row?.detailJson) return '上一轮没有长期记忆召回记录。';
  const detail = JSON.parse(row.detailJson) as { selected?: Array<{ streamId: string; revision: number; reasonCode: string; score: number }> };
  if (!detail.selected?.length) return '上一轮没有实际注入长期记忆。';
  return [
    '上一轮使用的记忆引用：',
    ...detail.selected.map((item) => (
      `${item.streamId}@${item.revision} ${item.reasonCode} score=${item.score.toFixed(2)}`
    )),
  ].join('\n');
}

export function buildPrivateMemoryExport(
  subjectKey: string,
  rows: readonly MemoryLedgerItem[],
): string {
  return JSON.stringify({
    subjectKey,
    assertions: rows.map((row) => ({
      streamId: row.streamId,
      revision: row.revision,
      type: row.assertionType,
      state: row.state,
      content: row.content,
      audiencePolicy: row.audiencePolicy,
      audienceContextCount: row.audienceContextKeys.length,
      captureAudienceSizes: Object.values(row.audienceSnapshots)
        .map((subjectKeys) => subjectKeys.length)
        .sort((left, right) => left - right),
      evidenceCount: row.evidence.length,
    })),
  }, null, 2);
}

export function registerMemoryCommands(
  ctx: Context,
  store: MemoryStore,
  statusService: MemoryStatusService,
  runtime: MemoryRuntimeConfig,
  modelRuntime: ModelRuntimeClient,
): void {
  ctx.command('memory', '长期记忆管理');

  ctx.command('memory.status', '查看长期记忆状态').action(async () => {
    const snapshot = await statusService.getSnapshot();
    return [
      `memory v${snapshot.schemaVersion}: ${snapshot.enabled ? 'enabled' : 'disabled'}${snapshot.maintenance ? ' / maintenance' : ''}`,
      `read/write: ${snapshot.readEnabled ? 'on' : 'off'} / ${snapshot.writeEnabled ? 'on' : 'off'}`,
      `extract: ${snapshot.extractConfigured ? snapshot.extractModel : 'disabled'}`,
      `embedding: ${snapshot.embedConfigured ? snapshot.embedModel : 'disabled'}`,
      `ledger: active ${snapshot.counts.active}, review ${snapshot.counts.pendingReview}, stranded ${snapshot.counts.stranded}`,
      `work: pending ${snapshot.jobs.pending}, leased ${snapshot.jobs.leased}, dead ${snapshot.jobs.deadLetter}`,
    ].join('\n');
  });

  ctx.command('memory.show', '查看当前上下文可用的长期记忆').action(async ({ session }) => {
    if (!session) return '缺少会话。';
    if (runtime.maintenance) return assertOperational(runtime);
    const baseAddress = commandAddress(session);
    if (!baseAddress) return '无法识别当前会话。';
    const address = await resolveCurrentMemoryAudience(session, baseAddress);
    const rows = await store.listForContext(
      address,
      null,
      address.observedAt,
    );
    return buildMemoryReferenceBlock(rows.slice(0, 20), 1600) ?? '当前没有可展示的长期记忆。';
  });

  ctx.command('memory.pending', '查看待审核记忆').action(async ({ session }) => {
    if (!session?.isDirect) return '待审核记忆只能由记忆主体在私聊查看。';
    if (runtime.maintenance) return assertOperational(runtime);
    const address = commandAddress(session);
    if (!address) return '无法识别当前用户。';
    const rows = (await store.listForOwner(address, true)).filter((row) => row.state === 'pendingReview');
    if (!rows.length) return '当前没有待审核记忆。';
    return rows.slice(0, 20).map((row) => (
      `${row.streamId} ${row.assertionType}/${row.sensitivity}: ${row.content.slice(0, 80)}`
    )).join('\n');
  });

  ctx.command('memory.review <streamId:string> <decision:string>', '审核待确认记忆').action(async ({ session }, streamId, decision) => {
    if (!session?.isDirect) return '审核只能由记忆主体在私聊执行。';
    if (runtime.maintenance) return assertOperational(runtime);
    if (decision !== 'approve' && decision !== 'reject') return 'decision 必须是 approve 或 reject。';
    const address = commandAddress(session);
    if (!address || !streamId?.trim()) return '缺少记忆 streamId。';
    await store.review({
      streamId: streamId.trim(),
      actor: { userKey: address.userKey, isDirect: true },
      decision,
      embeddingIdentity: decision === 'approve' ? embeddingIdentity(modelRuntime) : null,
    });
    return decision === 'approve' ? '已批准该记忆。' : '已拒绝并清除该记忆内容。';
  });

  ctx.command('memory.promote <streamId:string> [contexts:text]', '授权记忆跨上下文使用').action(async ({ session }, streamId, contexts) => {
    if (!session?.isDirect) return '跨上下文授权只能由记忆主体在私聊执行。';
    if (runtime.maintenance) return assertOperational(runtime);
    const address = commandAddress(session);
    if (!address || !streamId?.trim()) return '缺少记忆 streamId。';
    const explicit = String(contexts ?? '').split(',').map((item) => item.trim()).filter(Boolean);
    const identity = embeddingIdentity(modelRuntime);
    if (!identity) return 'memory.embedding 尚未配置，无法更新记忆 revision。';
    const audienceSnapshots = explicit.length
      ? await resolveExplicitMemoryAudiences(session, address, explicit)
      : {};
    await store.promoteAudience({
      streamId: streamId.trim(),
      actor: { userKey: address.userKey, isDirect: true },
      audiencePolicy: explicit.length ? 'explicitContexts' : 'subjectAllContexts',
      audienceContextKeys: explicit,
      audienceSnapshots,
      embeddingIdentity: identity,
    });
    return '已记录记忆主体的跨上下文授权。';
  });

  ctx.command('memory.forget <streamId:string>', '忘记指定记忆').action(async ({ session }, streamId) => {
    if (!session) return '缺少会话。';
    if (runtime.maintenance) return assertOperational(runtime);
    const address = commandAddress(session);
    if (!address || !streamId?.trim()) return '用法：memory.forget <streamId>';
    const count = await store.forget({
      actor: { userKey: address.userKey, isDirect: Boolean(session.isDirect) },
      streamId: streamId.trim(),
    });
    return count ? '已清除记忆内容并建立删除屏障。' : '找不到这条记忆。';
  });

  ctx.command('memory.forget-this-group', '忘记当前群来源记忆').action(async ({ session }) => {
    if (!session) return '缺少会话。';
    if (runtime.maintenance) return assertOperational(runtime);
    const address = commandAddress(session);
    if (!address || address.channelType !== 'group') return '这个命令只能在群聊里使用。';
    const count = await store.forget({
      actor: { userKey: address.userKey, isDirect: false },
      contextKey: address.contextKey,
    });
    return `已清除当前群来源的 ${count} 条记忆并建立删除屏障。`;
  });

  ctx.command('memory.forget-all', '忘记当前用户所有长期记忆').action(async ({ session }) => {
    if (!session?.isDirect) return '全部删除只能由记忆主体在私聊执行。';
    if (runtime.maintenance) return assertOperational(runtime);
    const address = commandAddress(session);
    if (!address) return '无法识别当前用户。';
    const count = await store.forget({
      actor: { userKey: address.userKey, isDirect: true },
      all: true,
    });
    return `已清除 ${count} 条长期记忆并建立删除屏障。`;
  });

  ctx.command('memory.export', '导出当前用户长期记忆').action(async ({ session }) => {
    if (!session?.isDirect) return '导出只能由记忆主体在私聊执行。';
    if (runtime.maintenance) return assertOperational(runtime);
    const address = commandAddress(session);
    if (!address) return '无法识别当前用户。';
    const rows = await store.listForOwner(address, true);
    return buildPrivateMemoryExport(address.userKey, rows);
  });

  ctx.command('memory.pause', '暂停当前用户记忆写入').action(async ({ session }) => {
    if (!session) return '缺少会话。';
    if (runtime.maintenance) return assertOperational(runtime);
    const address = commandAddress(session);
    if (!address) return '无法识别当前用户。';
    await store.upsertAddress(address);
    await store.setUserFlags(address.userKey, { writeEnabled: false });
    return '已暂停你的长期记忆写入；已有记忆仍可用于召回。';
  });

  ctx.command('memory.resume', '恢复当前用户记忆写入').action(async ({ session }) => {
    if (!session) return '缺少会话。';
    if (runtime.maintenance) return assertOperational(runtime);
    const address = commandAddress(session);
    if (!address) return '无法识别当前用户。';
    await store.upsertAddress(address);
    await store.setUserFlags(address.userKey, { writeEnabled: true });
    return '已恢复你的长期记忆写入。';
  });

  ctx.command('memory.why', '查看召回来源').action(async ({ session }) => {
    if (!session) return '缺少会话。';
    if (runtime.maintenance) return assertOperational(runtime);
    const address = commandAddress(session);
    if (!address) return '无法识别当前用户。';
    return parseWhy(await store.getLatestRecallAudit(address.userKey, address.contextKey));
  });
}
