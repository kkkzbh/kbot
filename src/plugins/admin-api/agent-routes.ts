import { z } from 'zod';
import type { Logger } from 'koishi';
import {
  agentComputerConfigPutSchema,
  agentMcpServerPutSchema,
  agentMcpToolPutSchema,
  agentSkillContentPutSchema,
  agentSkillConfigPutSchema,
  agentSkillGithubImportSchema,
  agentSkillModePutSchema,
  agentSkillsSettingsPutSchema,
} from '../../admin/contracts/agent.js';
import { AdminHttpError } from '../shared/internal-access-policy.js';
import type { ChatLunaAgentAdminService } from './chatluna-agent-admin.js';

type KoaContext = any;
type AgentApiHandler = (koaCtx: KoaContext) => Promise<unknown> | unknown;
type AgentRouteRegister = (
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  path: string,
  handler: AgentApiHandler,
  options?: { mutation?: boolean },
) => void;

const pathNameSchema = z.string().trim().min(1).max(512);
const computerBackendSchema = z.enum(['local', 'e2b', 'open-terminal']);

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AdminHttpError(
      400,
      'bad_request',
      '请求数据不符合 Agent Admin API contract。',
      result.error.flatten(),
    );
  }
  return result.data;
}

function safeDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(
      /\b(?:api[_ -]?key|token|secret|password|credential|cookie|authorization)\s*[:=]\s*[^\s,;]+/giu,
      '[credential redacted]',
    )
    .slice(0, 500);
}

function operationFailureDetails(error: unknown, operation: string): {
  status: number;
  code: 'bad_request' | 'upstream_error' | 'service_unavailable' | 'internal_error';
  details: Record<string, unknown>;
} {
  const record = error && typeof error === 'object' && !Array.isArray(error)
    ? error as Record<string, unknown>
    : {};
  const candidateStatus = Number(record.status ?? record.statusCode);
  const upstreamStatus = Number.isInteger(candidateStatus)
    && candidateStatus >= 400
    && candidateStatus <= 599
    ? candidateStatus
    : null;
  const providerCode = typeof record.code === 'string'
    && /^[A-Za-z0-9._:-]{1,120}$/.test(record.code)
    && !/(?:secret|token|password|credential|cookie|authorization)/i.test(record.code)
    ? record.code
    : null;
  const stage = typeof record.stage === 'string'
    && /^[A-Za-z0-9._:-]{1,120}$/.test(record.stage)
    ? record.stage
    : 'runtime';
  const status = upstreamStatus && upstreamStatus < 500
    ? upstreamStatus
    : upstreamStatus === 503
      ? 503
      : upstreamStatus
        ? 502
        : 500;
  const code = status < 500
    ? 'bad_request'
    : status === 503
      ? 'service_unavailable'
      : status === 502
        ? 'upstream_error'
        : 'internal_error';
  return {
    status,
    code,
    details: {
      operation,
      stage,
      ...(upstreamStatus ? { upstreamStatus } : {}),
      ...(providerCode ? { providerCode } : {}),
    },
  };
}

async function agentOperation<T>(
  operation: string,
  logger: Logger,
  callback: () => Promise<T>,
): Promise<T> {
  try {
    return await callback();
  } catch (error) {
    if (error instanceof AdminHttpError) throw error;
    const diagnostic = safeDiagnostic(error);
    const failure = operationFailureDetails(error, operation);
    logger.error(
      'Agent Admin operation failed: operation=%s stage=%s upstreamStatus=%s providerCode=%s type=%s diagnostic=%s',
      operation,
      failure.details.stage,
      failure.details.upstreamStatus ?? 'none',
      failure.details.providerCode ?? 'none',
      error instanceof Error ? error.name : typeof error,
      diagnostic,
    );
    throw new AdminHttpError(
      failure.status,
      failure.code,
      `${operation}失败：${diagnostic}`,
      failure.details,
    );
  }
}

export function registerAgentAdminRoutes(
  register: AgentRouteRegister,
  agent: ChatLunaAgentAdminService,
  logger: Logger,
): void {
  const run = <T>(operation: string, callback: () => Promise<T>) => (
    agentOperation(operation, logger, callback)
  );

  register('get', '/agent', () => run('读取 Agent 状态', () => agent.getState()));

  register('put', '/agent/mcp/server', async (koaCtx) => {
    const input = parse(agentMcpServerPutSchema, koaCtx.request.body);
    await run('保存 MCP Server', () => agent.saveMcpServer(input));
    return { success: true };
  }, { mutation: true });
  register('delete', '/agent/mcp/servers/:name', async (koaCtx) => {
    const name = parse(pathNameSchema, koaCtx.params.name);
    await run('删除 MCP Server', () => agent.removeMcpServer(name));
    return { success: true };
  }, { mutation: true });
  register('put', '/agent/mcp/tools/:name', async (koaCtx) => {
    const name = parse(pathNameSchema, koaCtx.params.name);
    const input = parse(agentMcpToolPutSchema, koaCtx.request.body);
    await run('保存 MCP Tool', () => agent.saveMcpTool(name, input));
    return { success: true };
  }, { mutation: true });
  register('post', '/agent/mcp/servers/:name/reconnect', async (koaCtx) => {
    const name = parse(pathNameSchema, koaCtx.params.name);
    await run('重连 MCP Server', () => agent.reconnectMcpServer(name));
    return { success: true };
  }, { mutation: true });
  register('post', '/agent/mcp/reload', async () => {
    await run('重载 MCP', () => agent.reloadMcp());
    return { success: true };
  }, { mutation: true });

  register('put', '/agent/skills/settings', async (koaCtx) => {
    const input = parse(agentSkillsSettingsPutSchema, koaCtx.request.body);
    await run('保存 Skills 设置', () => agent.saveSkillsSettings(input));
    return { success: true };
  }, { mutation: true });
  register('put', '/agent/skills/:id/mode', async (koaCtx) => {
    const id = parse(pathNameSchema, koaCtx.params.id);
    const input = parse(agentSkillModePutSchema, koaCtx.request.body);
    await run('更新 Skill 模式', () => agent.setSkillMode(id, input.mode));
    return { success: true };
  }, { mutation: true });
  register('put', '/agent/skills/:id/config', async (koaCtx) => {
    const id = parse(pathNameSchema, koaCtx.params.id);
    const input = parse(agentSkillConfigPutSchema, koaCtx.request.body);
    await run('保存 Skill 权限', () => agent.saveSkillConfig(id, input));
    return { success: true };
  }, { mutation: true });
  register('get', '/agent/skills/:id/content', async (koaCtx) => {
    const id = parse(pathNameSchema, koaCtx.params.id);
    return await run('读取 Skill 内容', () => agent.getSkillContent(id));
  });
  register('put', '/agent/skills/:id/content', async (koaCtx) => {
    const id = parse(pathNameSchema, koaCtx.params.id);
    const input = parse(agentSkillContentPutSchema, koaCtx.request.body);
    await run('保存 Skill 内容', () => agent.saveSkillContent(id, input.content));
    return { success: true };
  }, { mutation: true });
  register('delete', '/agent/skills/:id', async (koaCtx) => {
    const id = parse(pathNameSchema, koaCtx.params.id);
    await run('删除 Skill', () => agent.removeSkill(id));
    return { success: true };
  }, { mutation: true });
  register('post', '/agent/skills/import/github', async (koaCtx) => {
    const input = parse(agentSkillGithubImportSchema, koaCtx.request.body);
    return await run('从 GitHub 导入 Skill', () => agent.importSkillFromGithub(input));
  }, { mutation: true });
  register('post', '/agent/skills/reload', async () => {
    await run('重载 Skills', () => agent.reloadSkills());
    return { success: true };
  }, { mutation: true });

  register('put', '/agent/plugins/computer', async (koaCtx) => {
    const input = parse(agentComputerConfigPutSchema, koaCtx.request.body);
    await run('保存 Computer 配置', () => agent.saveComputerConfig(input));
    return { success: true };
  }, { mutation: true });
  register('post', '/agent/plugins/computer/backends/:type/probe', async (koaCtx) => {
    const type = parse(computerBackendSchema, koaCtx.params.type);
    return await run('探测 Computer Backend', () => agent.probeComputerBackend(type));
  }, { mutation: true });
}
