import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Script } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';

interface StatefulProbeSequence {
  id: string;
  turns: Array<{ id: string; prompt: string; category: string; mustInclude?: string }>;
  thresholds: {
    casualStickerRate: { minExclusive: number; maxExclusive: number };
    seriousStickerRate: { equals: number };
    informationalStickerRate: { equals: number };
    explicitStickerRate: { equals: number };
    maxStickersPerTurn: number;
  };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const shared = require('../scripts/lib/probe-local-bot-shared.cjs') as {
  DEFAULT_PROBE_GROUP_ID: string;
  LIVE_ACCEPTANCE_GROUP_ID: string;
  PROBE_LOCK_FILE: string;
  TEMP_PROBE_GROUP_PREFIX: string;
  TEMP_PROBE_USER_PREFIX: string;
  classifyDeliveredTypedMedia: (
    orchestrations: unknown[],
    captures: unknown[],
  ) => { voice: boolean; sticker: boolean; image: boolean; ambiguous: boolean };
  evaluateTurnTerminal: (
    orchestrations: unknown[],
    captures: unknown[],
    deliveryCompletions: unknown[],
  ) => { terminal: boolean; status: string | null; at: number | null };
  evaluateVisualDeliveryExpectation: (
    mode: 'allowed' | 'discouraged' | 'required',
    media: { voice: boolean; sticker: boolean; image: boolean; ambiguous: boolean },
  ) => { ok: boolean; reason: string | null };
  isOwnedTemporaryProbeGroupId: (value: unknown) => boolean;
  isOwnedTemporaryProbeUserId: (value: unknown) => boolean;
  isCaptureAfterOrchestration: (capture: unknown, orchestration: unknown) => boolean;
  isSuccessfulDeliveryCapture: (capture: unknown) => boolean;
  latestTerminalOrchestration: (orchestrations: unknown[]) => unknown;
  normalizeVisibleContent: (content: unknown) => string;
  resolveOwnedProbeTurnCapture: (input: {
    channelId: unknown;
    fakeChannelId: string;
    fakeUserId: string;
    options: unknown;
    activeTurnCapture: unknown;
    turnCapturesByMessageId: Map<number, unknown>;
  }) => unknown;
  serializePayload: (content: unknown) => unknown;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const visibleOutput = require('../scripts/lib/probe-visible-output.cjs') as {
  INTERNAL_METADATA_TOKENS: readonly string[];
  findInternalMetadataLeak: (value: unknown) => string | null;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const probeCorpus = require('../scripts/lib/chat-reply-probe-corpus.cjs') as {
  evaluateStatefulStickerRates: (
    rates: { casual: number; explicit: number; serious: number; informational: number },
    thresholds: StatefulProbeSequence['thresholds'],
  ) => { warnings: string[]; verdict: 'passed' | 'passed_with_warnings' };
  loadProbeManifest: (path: string) => {
    schemaVersion: number;
    presetId: string;
    expectedModelId: string;
    expectedTransportModel: string;
    expectedReasoningEffort: string;
    cases: Array<{ id: string; prompt: string; dimensions: string[] }>;
    statefulSequences: StatefulProbeSequence[];
  };
  selectProbeCases: (
    manifest: { cases: Array<{ id: string }> },
    ids?: string,
  ) => Array<{ id: string }>;
  selectProbeSequences: (
    manifest: { statefulSequences: StatefulProbeSequence[] },
    ids?: string,
  ) => StatefulProbeSequence[];
};

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-probe-test-'));
  tempDirs.push(dir);
  return dir;
}

async function cleanupTempDirs() {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

function sqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8' }).trim();
}

const OWNERSHIP_TOKEN = '6ba7b810-9dad-4f45-8d18-4d90a8f92784';
const OWNED_USER_ID = `${shared.TEMP_PROBE_USER_PREFIX}000000101`;
const OWNED_GROUP_ID = `${shared.TEMP_PROBE_GROUP_PREFIX}000000101`;

function createOwnershipJournal(
  dir: string,
  overrides: Record<string, unknown> = {},
): string {
  const ownershipDir = join(dir, 'probe-ownership');
  mkdirSync(ownershipDir, { recursive: true });
  const token = String(overrides.token ?? OWNERSHIP_TOKEN);
  const path = join(ownershipDir, `${token}.json`);
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 1,
    owner: 'qqbot-probe',
    token,
    userId: OWNED_USER_ID,
    groupId: OWNED_GROUP_ID,
    phase: 'installed',
    createdAt: '2026-08-04T00:00:00.000Z',
    bindingKey: `shared:onebot:2219854433:${OWNED_GROUP_ID}:preset:sakiko`,
    conversationId: 'probe-conversation',
    previousBinding: {
      bindingKey: `shared:onebot:2219854433:${OWNED_GROUP_ID}:preset:sakiko`,
      activeConversationId: 'previous-conversation',
      lastConversationId: null,
      updatedAt: 100,
    },
    ...overrides,
  })}\n`);
  return path;
}

afterEach(async () => {
  await cleanupTempDirs();
});

describe('probe-local-bot.sh', () => {
  it('documents group-only probing in controlled temporary identities', () => {
    const output = execFileSync('bash', [resolve(process.cwd(), 'scripts/probe-local-bot.sh'), '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(output).toContain('This probe is group-only');
    expect(output).toContain('prefix 880000');
    expect(output).toContain('prefix 890000');
    expect(output).toContain('$qqbot-group-probe');
    expect(output).toContain('PROBE_TRIGGER_PREFIX');
    expect(output).toContain('PROBE_ASSERT_FAILURES');
    expect(output).toContain('PROBE_PRESET_ID');
    expect(output).toContain('--sequence');
    expect(output).not.toContain('PROBE_TAB');
    expect(output).not.toContain('PROBE_ROOM_MODEL');
  });

  it('resolves isolated probes from canonical main.chat and contains every owned-channel send', () => {
    const content = readFileSync(resolve(process.cwd(), 'scripts/probe-local-bot.sh'), 'utf8');

    expect(content).not.toContain('send_private_msg');
    expect(content).not.toContain('/trace/api/traces');
    expect(content).not.toContain('finalReplyPreview');
    expect(content).toContain('visibleMessages');
    expect(content).toContain('payloadCaptures');
    expect(content).toContain('deliveryCompletions');
    expect(content).toContain('Another group probe is already running');
    expect(content).toContain('flock -n 9');
    expect(content).not.toContain('kill -0');
    expect(shared.PROBE_LOCK_FILE).toMatch(/^\.tmp\/probe-runtime\//u);
    expect(content).toContain('originalInput');
    expect(content).toContain('dispatchedInput');
    expect(content).toContain('this.app.modelConfig');
    expect(content).toContain('getRedactedRuntimeSnapshot');
    expect(content).toContain("binding.workload === 'main.chat'");
    expect(content).toContain("'qqbot-' + model.connectionId + '/' + model.id");
    expect(content).toContain('modelSource: resolvedModelSource');
    expect(content).toContain('transportModel: resolvedModelProfile.transportModel');
    expect(content).toContain('turnCapturesByMessageId');
    expect(content).toContain('resolveOwnedProbeTurnCapture');
    expect(content).toContain('isolated probe outbound did not belong to the active turn');
    expect(content).not.toContain('directGroupCaptureAllowed');
    expect(content).toContain('Failed to clean owned probe state');
    expect(content).toContain('QQBOT_PROBE_OWNERSHIP_JOURNAL');
    expect(content).toContain("additional_kwargs: ownershipMarkerJson");
    expect(content).toContain("writeOwnershipJournal({ phase: 'installed' })");
    expect(content).toContain("writeOwnershipJournal({ phase: 'runtime-restored' })");
    expect(content).toContain('evaluateTurnTerminal');
    expect(content).toContain("runtimeModule.ReplyRuntime");
    expect(content).toContain('ReplyRuntime.prototype.finishRun');
    expect(content).not.toContain('Date.now() - stableSince >= 6000');
    expect(content).toContain('firstErrorSignature');
    expect(content).toContain("db.create('chatluna_conversation'");
    expect(content).toContain("db.upsert('chatluna_binding'");
    expect(content).toContain("PROBE_ASSERT_FAILURES");
    expect(content).toContain('(saki|祥)');
    expect(content).not.toContain('main-chat-tabs');
    expect(content).not.toContain('buildMainChatRuntimeEnvPatch');
    expect(content).not.toContain('envRestoreEntries');
  });

  it('rejects a symbolic-link lock before opening it', () => {
    const dir = createTempDir();
    const scriptsDir = join(dir, 'scripts');
    const libraryDir = join(scriptsDir, 'lib');
    const runtimeDir = join(dir, '.tmp', 'probe-runtime');
    const lockPath = join(dir, shared.PROBE_LOCK_FILE);
    const targetPath = join(dir, 'must-not-be-truncated.txt');
    mkdirSync(libraryDir, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    cpSync(resolve(process.cwd(), 'scripts/probe-local-bot.sh'), join(scriptsDir, 'probe-local-bot.sh'));
    cpSync(
      resolve(process.cwd(), 'scripts/lib/probe-local-bot-shared.cjs'),
      join(libraryDir, 'probe-local-bot-shared.cjs'),
    );
    writeFileSync(targetPath, 'preserve-me');
    symlinkSync(targetPath, lockPath);

    const result = spawnSync('bash', [join(scriptsDir, 'probe-local-bot.sh'), 'saki test'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_USER_ID: OWNED_USER_ID,
        FAKE_GROUP_ID: OWNED_GROUP_ID,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('lock file must not be a symbolic link');
    expect(readFileSync(targetPath, 'utf8')).toBe('preserve-me');
  });

  it('keeps the inspector runtime function syntactically valid after helper injection', () => {
    const shell = readFileSync(resolve(process.cwd(), 'scripts/probe-local-bot.sh'), 'utf8');
    const marker = 'functionDeclaration: `async function(input';
    const markerIndex = shell.indexOf(marker);
    const bodyStart = shell.indexOf('`', markerIndex) + 1;
    const bodyEnd = shell.indexOf('`,\n      arguments:', bodyStart);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    let source = shell.slice(bodyStart, bodyEnd);
    const replacements: Record<string, string> = {
      latestTerminalOrchestrationSource: shared.latestTerminalOrchestration.toString(),
      isSuccessfulDeliveryCaptureSource: shared.isSuccessfulDeliveryCapture.toString(),
      isCaptureAfterOrchestrationSource: shared.isCaptureAfterOrchestration.toString(),
      evaluateTurnTerminalSource: shared.evaluateTurnTerminal.toString(),
      normalizeVisibleContentSource: shared.normalizeVisibleContent.toString(),
      resolveOwnedProbeTurnCaptureSource: shared.resolveOwnedProbeTurnCapture.toString(),
      serializePayloadSource: shared.serializePayload.toString(),
    };
    for (const [name, implementation] of Object.entries(replacements)) {
      source = source.replace(`\${${name}}`, implementation);
    }
    expect(() => new Script(`(${source})`, { filename: 'probe-local-bot.runtime.cjs' })).not.toThrow();
  });

  it('rejects the real acceptance group and uncontrolled identities before runtime access', () => {
    const script = resolve(process.cwd(), 'scripts/probe-local-bot.sh');
    const live = spawnSync('bash', [script, 'saki test'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_USER_ID: OWNED_USER_ID,
        FAKE_GROUP_ID: shared.LIVE_ACCEPTANCE_GROUP_ID,
      },
    });
    expect(live.status).toBe(2);
    expect(live.stderr).toContain('cannot be used by probe-local-bot.sh');

    const uncontrolled = spawnSync('bash', [script, 'saki test'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_USER_ID: '9177543201',
        FAKE_GROUP_ID: OWNED_GROUP_ID,
      },
    });
    expect(uncontrolled.status).toBe(2);
    expect(uncontrolled.stderr).toContain('controlled temporary namespace');
  });

  it('requires every probe to use its isolated owned conversation', () => {
    const result = spawnSync(
      'bash',
      [resolve(process.cwd(), 'scripts/probe-local-bot.sh'), 'saki test'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          PROBE_ISOLATED_ROOM: '0',
        },
      },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('only operates owned temporary conversations');
  });

  it.each(['PROBE_TAB', 'PROBE_ROOM_MODEL'])('rejects the removed %s override before probing', (key) => {
    const result = spawnSync(
      'bash',
      [resolve(process.cwd(), 'scripts/probe-local-bot.sh'), 'saki test'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          [key]: 'legacy-override',
        },
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'PROBE_TAB and PROBE_ROOM_MODEL are no longer supported',
    );
  });

  it('keeps automated full probes off the production acceptance group', () => {
    const result = spawnSync(
      'bash',
      [resolve(process.cwd(), 'scripts/smoke-chat-replies.sh')],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          FAKE_GROUP_ID: shared.LIVE_ACCEPTANCE_GROUP_ID,
          FAKE_USER_ID: OWNED_USER_ID,
          PROBE_MODE: 'stateful',
        },
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('controlled temporary');
  });

  it('fails explicitly when a selected voice acceptance case is not enabled', () => {
    const result = spawnSync(
      'bash',
      [resolve(process.cwd(), 'scripts/smoke-chat-replies.sh')],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          FAKE_GROUP_ID: OWNED_GROUP_ID,
          FAKE_USER_ID: OWNED_USER_ID,
          PROBE_MODE: 'cases',
          PROBE_CASE_IDS: 'explicit-voice',
          QQBOT_RUN_VOICE_SMOKE: '0',
          QQ_VOICE_OUTPUT_ENABLED: 'false',
        },
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('explicit-voice requires voice output');
  });
});

describe('chat reply probe corpus', () => {
  it('shares stable triggered prompts across direct and full-pipeline probes', () => {
    const manifest = probeCorpus.loadProbeManifest(
      resolve(process.cwd(), 'scripts/chat-reply-probe-cases.json'),
    );
    const caseIds = manifest.cases.map((probeCase) => probeCase.id);
    const dimensions = new Set(manifest.cases.flatMap((probeCase) => probeCase.dimensions));

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.presetId).toBe('sakiko');
    expect(manifest.expectedModelId).toBe('gpt-5.6-luna');
    expect(manifest.expectedTransportModel).toBe('gpt-5.6-luna');
    expect(manifest.expectedReasoningEffort).toBe('medium');
    expect(new Set(caseIds).size).toBe(caseIds.length);
    expect(caseIds).toEqual([
      'human-casual-chat',
      'no-speaker-labels',
      'bounded-short-reply',
      'search-with-progress',
      'explicit-voice',
      'voice-informational-negative',
      'explicit-sticker',
      'sticker-informational-negative',
      'serious-no-sticker',
      'casual-sticker-celebration',
      'casual-sticker-surprise',
      'casual-sticker-teasing',
      'casual-sticker-playful',
    ]);
    expect(manifest.cases.every((probeCase) => probeCase.prompt.startsWith('saki '))).toBe(true);
    expect(dimensions).toEqual(new Set([
      'human_chat',
      'no_speaker_labels',
      'bounded_length',
      'search',
      'progress',
      'voice',
      'explicit_request',
      'informational_negative',
      'sticker',
      'serious',
      'sticker_negative',
      'casual_opportunity',
    ]));
    expect(
      manifest.cases.filter((probeCase) => probeCase.dimensions.includes('casual_opportunity')),
    ).toHaveLength(4);
  });

  it('defines a same-conversation cooldown sequence with aggregate behavior gates', () => {
    const manifest = probeCorpus.loadProbeManifest(
      resolve(process.cwd(), 'scripts/chat-reply-probe-cases.json'),
    );
    const [sequence] = probeCorpus.selectProbeSequences(manifest, 'modality-cooldown');
    const categoryCount = (category: string) => (
      sequence.turns.filter((turn) => turn.category === category).length
    );

    expect(sequence.id).toBe('modality-cooldown');
    expect(sequence.turns).toHaveLength(30);
    expect(new Set(sequence.turns.map((turn) => turn.id)).size).toBe(sequence.turns.length);
    expect(sequence.turns.every((turn) => turn.prompt.startsWith('saki '))).toBe(true);
    expect(categoryCount('casual_opportunity')).toBe(9);
    expect(categoryCount('explicit_sticker')).toBe(4);
    expect(categoryCount('serious_negative')).toBe(4);
    expect(categoryCount('informational_negative')).toBe(4);
    expect(sequence.turns.find((turn) => turn.id === 'context-recall')).toMatchObject({
      mustInclude: '银羽-Q7M4',
    });
    expect(sequence.thresholds).toEqual({
      casualStickerRate: { minExclusive: 0, maxExclusive: 0.7 },
      seriousStickerRate: { equals: 0 },
      informationalStickerRate: { equals: 0 },
      explicitStickerRate: { equals: 1 },
      maxStickersPerTurn: 1,
    });
    expect(() => probeCorpus.selectProbeSequences(manifest, 'missing-sequence'))
      .toThrow('unknown probe sequence id');

    const softMiss = probeCorpus.evaluateStatefulStickerRates({
      casual: 0,
      explicit: 0.5,
      serious: 0,
      informational: 0,
    }, sequence.thresholds);
    expect(softMiss.warnings).toHaveLength(1);
    expect(softMiss.verdict).toBe('passed_with_warnings');

    const offTarget = probeCorpus.evaluateStatefulStickerRates({
      casual: 0.2,
      explicit: 1,
      serious: 0.25,
      informational: 0.25,
    }, sequence.thresholds);
    expect(offTarget.warnings).toHaveLength(2);
    expect(offTarget.verdict).toBe('passed_with_warnings');
  });

  it('selects the same ordered case IDs for either runner', () => {
    const manifest = probeCorpus.loadProbeManifest(
      resolve(process.cwd(), 'scripts/chat-reply-probe-cases.json'),
    );

    expect(probeCorpus.selectProbeCases(manifest, 'serious-no-sticker,human-casual-chat'))
      .toEqual([
        expect.objectContaining({ id: 'serious-no-sticker' }),
        expect.objectContaining({ id: 'human-casual-chat' }),
      ]);
    expect(() => probeCorpus.selectProbeCases(manifest, 'missing-case')).toThrow('unknown probe case id');
  });

  it('documents the read-only direct runner controls', () => {
    const output = execFileSync('bash', [resolve(process.cwd(), 'scripts/probe-direct-model.sh'), '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(output).toContain('never creates');
    expect(output).toContain('PROBE_CASE_IDS');
    expect(output).toContain('PROBE_REPETITIONS');
    expect(output).toContain('PROBE_REASONING_EFFORT');

    const fullPipelineOutput = execFileSync(
      'bash',
      [resolve(process.cwd(), 'scripts/smoke-chat-replies.sh'), '--help'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(fullPipelineOutput).toContain('full QQBot pipeline');
    expect(fullPipelineOutput).toContain('PROBE_CASE_IDS');
    expect(fullPipelineOutput).toContain('PROBE_MODE');
    expect(fullPipelineOutput).toContain('PROBE_SEQUENCE_IDS');
    expect(fullPipelineOutput).toContain('PROBE_REPETITIONS');
    expect(fullPipelineOutput).toContain('non-production temporary group');
  });
});

describe('probe-local-bot shared helpers', () => {
  it('hard-fails every current terminal reply implementation token', () => {
    const currentTokens = [
      'qqbot_submit_reply',
      'CHAT_REPLY_V1',
      'AgentTerminalContractError',
      'terminal contract',
      'terminalTool',
      'qqbot_final_response_contract',
      'lc_direct_tool_output',
      'qqbot-internal',
    ];
    for (const token of currentTokens) {
      expect(visibleOutput.INTERNAL_METADATA_TOKENS).toContain(token);
      expect(visibleOutput.findInternalMetadataLeak(`正常开头 ${token} 正常结尾`)).toBe(token);
      expect(visibleOutput.findInternalMetadataLeak(token.toLowerCase())).toBe(token);
    }
    expect(visibleOutput.findInternalMetadataLeak('我搜一下，马上回来。')).toBeNull();
  });

  it('recognizes only the controlled temporary identity namespaces', () => {
    expect(shared.isOwnedTemporaryProbeGroupId(OWNED_GROUP_ID)).toBe(true);
    expect(shared.isOwnedTemporaryProbeUserId(OWNED_USER_ID)).toBe(true);
    expect(shared.isOwnedTemporaryProbeGroupId(shared.LIVE_ACCEPTANCE_GROUP_ID)).toBe(false);
    expect(shared.isOwnedTemporaryProbeUserId('9177543201')).toBe(false);
  });

  it('attributes sessionless owned-channel sends to the active turn without claiming other channels', () => {
    const activeTurn = { messageId: 101 };
    const exactTurn = { messageId: 102 };
    const captures = new Map([[102, exactTurn]]);
    const base = {
      fakeChannelId: OWNED_GROUP_ID,
      fakeUserId: OWNED_USER_ID,
      activeTurnCapture: activeTurn,
      turnCapturesByMessageId: captures,
    };

    expect(shared.resolveOwnedProbeTurnCapture({
      ...base,
      channelId: OWNED_GROUP_ID,
      options: undefined,
    })).toBe(activeTurn);
    expect(shared.resolveOwnedProbeTurnCapture({
      ...base,
      channelId: OWNED_GROUP_ID,
      options: {
        session: {
          channelId: OWNED_GROUP_ID,
          userId: OWNED_USER_ID,
          messageId: 102,
        },
      },
    })).toBe(exactTurn);
    expect(shared.resolveOwnedProbeTurnCapture({
      ...base,
      channelId: '123456789',
      options: undefined,
    })).toBeNull();
    expect(shared.resolveOwnedProbeTurnCapture({
      ...base,
      channelId: OWNED_GROUP_ID,
      options: {
        session: {
          channelId: OWNED_GROUP_ID,
          userId: '890000999999999',
          messageId: 102,
        },
      },
    })).toBeNull();
  });

  it('waits for ready plus successful final delivery instead of stopping at progress', () => {
    const progress = [{ at: 100, ordinal: 1, delivered: true, receipt: ['progress'], payload: '我查一下。' }];
    expect(shared.evaluateTurnTerminal([], progress, [])).toEqual({
      terminal: false,
      status: null,
      at: null,
    });

    const orchestrations = [{
      at: 200,
      ordinal: 2,
      result: { status: 'ready', actions: [{ kind: 'message', parts: [{ kind: 'text', content: '找到了' }] }] },
    }];
    expect(shared.evaluateTurnTerminal(orchestrations, progress, [])).toEqual({
      terminal: false,
      status: 'awaiting_delivery',
      at: 200,
    });
    expect(shared.evaluateTurnTerminal(orchestrations, [
      ...progress,
      { at: 300, ordinal: 3, delivered: true, receipt: ['final'], payload: '找到了' },
    ], [{
      at: 400,
      ordinal: 4,
      plannedUnitCount: 1,
      committedUnitCount: 1,
      completed: true,
    }])).toEqual({ terminal: true, status: 'delivered', at: 200 });
  });

  it('keeps an owned turn active until every final action is delivered', () => {
    const orchestrations = [{
      at: 200,
      ordinal: 2,
      result: {
        status: 'ready',
        actions: [
          { kind: 'message', parts: [{ kind: 'text', content: '结论' }] },
          { kind: 'message', parts: [{ kind: 'text', content: '来源' }] },
        ],
      },
    }];
    const firstDelivery = {
      at: 300,
      ordinal: 3,
      delivered: true,
      receipt: ['first'],
      payload: '结论',
    };
    expect(shared.evaluateTurnTerminal(orchestrations, [firstDelivery], [])).toEqual({
      terminal: false,
      status: 'awaiting_delivery',
      at: 200,
    });
    expect(shared.evaluateTurnTerminal(orchestrations, [
      firstDelivery,
      {
        at: 400,
        ordinal: 4,
        delivered: true,
        receipt: ['second'],
        payload: '来源',
      },
    ], [{
      at: 500,
      ordinal: 5,
      plannedUnitCount: 2,
      committedUnitCount: 2,
      completed: true,
    }])).toEqual({ terminal: true, status: 'delivered', at: 200 });
  });

  it('accepts no-reply and error terminals that do not create a delivery run', () => {
    const noReply = [{
      at: 100,
      ordinal: 1,
      result: { status: 'no_reply', actions: [{ kind: 'no_reply' }] },
    }];
    expect(shared.evaluateTurnTerminal(noReply, [], [])).toEqual({
      terminal: true,
      status: 'no_reply',
      at: 100,
    });

    const error = [{ at: 100, ordinal: 1, result: { status: 'error' } }];
    expect(shared.evaluateTurnTerminal(error, [], [])).toEqual({
      terminal: true,
      status: 'error',
      at: 100,
    });
  });

  it('fails a completed runtime transaction that did not commit every planned unit', () => {
    const ready = [{
      at: 100,
      ordinal: 1,
      result: { status: 'ready', actions: [{ kind: 'message', parts: [{ kind: 'text', content: '回复' }] }] },
    }];
    expect(shared.evaluateTurnTerminal(ready, [], [{
      at: 200,
      ordinal: 2,
      plannedUnitCount: 1,
      committedUnitCount: 0,
      completed: false,
    }])).toEqual({ terminal: true, status: 'incomplete_delivery', at: 100 });
  });

  it('counts media only when typed action and successful matching receipt agree', () => {
    const imageCapture = [{
      at: 200,
      ordinal: 2,
      delivered: true,
      receipt: ['sent'],
      payload: { type: 'image', attrs: { src: 'data:image/png;base64,a' } },
    }];
    const toolImage = [{ at: 100, ordinal: 1, result: { status: 'ready', actions: [{ kind: 'image', assetRef: 'tool:1' }] } }];
    expect(shared.classifyDeliveredTypedMedia(toolImage, imageCapture)).toEqual({
      voice: false,
      sticker: false,
      image: true,
      ambiguous: false,
    });

    const sticker = [{ at: 100, ordinal: 1, result: { status: 'ready', actions: [{ kind: 'sticker', intent: '开心' }] } }];
    expect(shared.classifyDeliveredTypedMedia(sticker, imageCapture)).toEqual({
      voice: false,
      sticker: true,
      image: false,
      ambiguous: false,
    });
    expect(shared.classifyDeliveredTypedMedia(sticker, [{
      ...imageCapture[0],
      delivered: false,
      receipt: null,
    }])).toEqual({ voice: false, sticker: false, image: false, ambiguous: false });

    const deceptiveTextCapture = [{
      at: 200,
      ordinal: 2,
      delivered: true,
      receipt: ['sent'],
      payload: {
        type: 'text',
        attrs: { content: '<image src="https://example.com/not-an-element.png" />' },
        children: [],
      },
    }];
    expect(shared.classifyDeliveredTypedMedia(sticker, deceptiveTextCapture)).toEqual({
      voice: false,
      sticker: false,
      image: false,
      ambiguous: false,
    });

    const mixed = [{
      at: 100,
      ordinal: 1,
      result: {
        status: 'ready',
        actions: [{ kind: 'sticker', intent: '开心' }, { kind: 'image', assetRef: 'tool:1' }],
      },
    }];
    expect(shared.classifyDeliveredTypedMedia(mixed, imageCapture)).toEqual({
      voice: false,
      sticker: false,
      image: false,
      ambiguous: true,
    });

    expect(shared.evaluateVisualDeliveryExpectation('discouraged', {
      voice: false,
      sticker: false,
      image: true,
      ambiguous: false,
    })).toEqual({ ok: false, reason: 'visual_discouraged' });
    expect(shared.evaluateVisualDeliveryExpectation('required', {
      voice: false,
      sticker: false,
      image: true,
      ambiguous: false,
    })).toEqual({ ok: false, reason: 'sticker_required' });
    expect(shared.evaluateVisualDeliveryExpectation('required', {
      voice: false,
      sticker: true,
      image: false,
      ambiguous: false,
    })).toEqual({ ok: true, reason: null });
  });

  it('renders normal text as visible text instead of element json', () => {
    const visible = shared.normalizeVisibleContent({
      type: 'text',
      attrs: { content: 'hello' },
      data: { content: 'hello' },
      children: [],
    });

    expect(visible).toBe('hello');
  });

  it('renders mentions and media placeholders for visible output', () => {
    const visible = shared.normalizeVisibleContent([
      { type: 'at', attrs: { id: '123456' }, children: [] },
      { type: 'text', attrs: { content: ' hi' }, children: [] },
      { type: 'image', attrs: { url: 'https://example.com/a.png' }, children: [] },
      { type: 'voice', attrs: {}, children: [] },
    ]);

    expect(visible).toBe('@123456 hi（图片）（语音）');
  });

  it('serializes payloads into plain json-safe values', () => {
    const payload = shared.serializePayload({
      type: 'text',
      attrs: { content: 'hello' },
      fn: () => 'ignored',
      children: [],
    }) as { type: string; attrs: { content: string }; fn?: unknown };

    expect(payload).toEqual({
      type: 'text',
      attrs: { content: 'hello' },
      children: [],
    });
    expect(payload.fn).toBeUndefined();
  });
});

describe('cleanup-probe-chat-state.sh', () => {
  it('restores the owned binding and removes only state at the probe user/group intersection', () => {
    const dir = createTempDir();
    const dbPath = join(dir, 'koishi.db');
    const journalPath = createOwnershipJournal(dir);
    const ownershipDir = join(dir, 'probe-ownership');
    const marker = JSON.stringify({
      qqbotProbe: {
        schemaVersion: 1,
        token: OWNERSHIP_TOKEN,
        userId: OWNED_USER_ID,
        groupId: OWNED_GROUP_ID,
      },
    });
    const bindingKey = `shared:onebot:2219854433:${OWNED_GROUP_ID}:preset:sakiko`;
    const tempContext = `onebot:bot:2219854433:group:${OWNED_GROUP_ID}`;
    const tempWorkOnlyContext = `${tempContext}:foreign-work-only`;
    const realContext = 'onebot:bot:2219854433:group:10002';
    writeFileSync(dbPath, '');
    execFileSync(
      'sqlite3',
      [
        dbPath,
        `
create table chathub_room (roomId integer primary key, roomName text, conversationId text, roomMasterId text, visibility text, preset text, model text, chatMode text, password text, autoUpdate integer, updatedTime integer);
create table chatluna_binding (bindingKey text primary key, activeConversationId text, lastConversationId text, updatedAt integer);
create table chatluna_conversation (id text primary key, bindingKey text, title text, createdBy text, additional_kwargs text, latestMessageId text, updatedAt integer);
create table chathub_room_member (userId text, roomId integer, roomPermission text, mute integer, primary key (userId, roomId));
create table chathub_room_group_member (groupId text, roomId integer, primary key (groupId, roomId));
create table chathub_user (userId text, defaultRoomId integer, groupId text, primary key (userId, groupId));
create table chatluna_message (id text primary key, parentId text, role text, conversationId text, content blob);
create table memory_v3_principal (id integer primary key, userKey text, platform text, userId text);
create table memory_v3_context (id integer primary key, contextKey text, platform text, channelType text, groupId text);
create table memory_v3_event (eventId text, streamId text, subjectKey text, sourceContextKey text, actorKey text);
create table memory_v3_payload (payloadId text, eventId text);
create table memory_v3_evidence (eventId text, contextKey text, excerptPayloadId text);
create table memory_v3_head (streamId text, payloadId text, subjectKey text, sourceContextKey text);
create table memory_v3_lexical_document (streamId text, eventId text);
create table memory_v3_lexical_term (streamId text);
create table memory_v3_work (subjectKey text, contextKey text);
create table memory_v3_cursor (subjectKey text, contextKey text);
create table memory_v3_suppression (subjectKey text, contextKey text);
create table memory_v3_audit (subjectKey text, contextKey text);
insert into chatluna_binding values ('${bindingKey}', 'probe-conversation', 'previous-conversation', 200);
insert into chatluna_conversation values ('probe-conversation', '${bindingKey}', 'qqbot-probe:${OWNERSHIP_TOKEN}', '${OWNED_USER_ID}', '${marker}', null, 0);
insert into chathub_room values (147, 'qqbot-probe:${OWNERSHIP_TOKEN}', 'legacy-probe-conversation', '${OWNED_USER_ID}', 'template_clone', '', '', '', '', 0, 0);
insert into chatluna_conversation values ('legacy-probe-conversation', null, 'qqbot-probe:${OWNERSHIP_TOKEN}', '${OWNED_USER_ID}', '${marker}', null, 0);
insert into chathub_room_member values ('${OWNED_USER_ID}', 147, 'owner', 0);
insert into chathub_room_group_member values ('${OWNED_GROUP_ID}', 147);
insert into chathub_user values ('${OWNED_USER_ID}', 147, '${OWNED_GROUP_ID}');
insert into chatluna_message values ('msg-1', null, 'human', 'probe-conversation', 'hello');
insert into chatluna_message values ('msg-2', null, 'human', 'legacy-probe-conversation', 'hello');
insert into memory_v3_principal values (1, 'onebot:user:${OWNED_USER_ID}', 'onebot', '${OWNED_USER_ID}');
insert into memory_v3_principal values (2, 'onebot:user:10001', 'onebot', '10001');
insert into memory_v3_context values (1, '${tempContext}', 'onebot', 'group', '${OWNED_GROUP_ID}');
insert into memory_v3_context values (2, '${realContext}', 'onebot', 'group', '10002');
insert into memory_v3_context values (3, '${tempWorkOnlyContext}', 'onebot', 'group', '${OWNED_GROUP_ID}');
insert into memory_v3_event values ('event-probe', 'stream-probe', 'onebot:user:${OWNED_USER_ID}', '${tempContext}', 'onebot:user:${OWNED_USER_ID}');
insert into memory_v3_event values ('event-group-probe', 'stream-group-probe', 'onebot:group:${OWNED_GROUP_ID}', '${tempContext}', 'onebot:user:${OWNED_USER_ID}');
insert into memory_v3_event values ('event-assistant-probe', 'stream-assistant-probe', 'onebot:bot:2219854433', '${tempContext}', 'onebot:user:${OWNED_USER_ID}');
insert into memory_v3_event values ('event-fake-real', 'stream-fake-real', 'onebot:user:${OWNED_USER_ID}', '${realContext}', 'onebot:user:${OWNED_USER_ID}');
insert into memory_v3_event values ('event-real-temp', 'stream-real-temp', 'onebot:user:10001', '${tempContext}', 'onebot:user:10001');
insert into memory_v3_payload values ('payload-probe', 'event-probe');
insert into memory_v3_payload values ('payload-group-probe', 'event-group-probe');
insert into memory_v3_payload values ('payload-assistant-probe', 'event-assistant-probe');
insert into memory_v3_payload values ('payload-fake-real', 'event-fake-real');
insert into memory_v3_payload values ('payload-real-temp', 'event-real-temp');
insert into memory_v3_evidence values ('event-probe', '${tempContext}', null);
insert into memory_v3_evidence values ('event-group-probe', '${tempContext}', null);
insert into memory_v3_evidence values ('event-assistant-probe', '${tempContext}', null);
insert into memory_v3_evidence values ('event-fake-real', '${realContext}', null);
insert into memory_v3_evidence values ('event-real-temp', '${tempContext}', null);
insert into memory_v3_head values ('stream-probe', 'payload-probe', 'onebot:user:${OWNED_USER_ID}', '${tempContext}');
insert into memory_v3_head values ('stream-group-probe', 'payload-group-probe', 'onebot:group:${OWNED_GROUP_ID}', '${tempContext}');
insert into memory_v3_head values ('stream-assistant-probe', 'payload-assistant-probe', 'onebot:bot:2219854433', '${tempContext}');
insert into memory_v3_head values ('stream-fake-real', 'payload-fake-real', 'onebot:user:${OWNED_USER_ID}', '${realContext}');
insert into memory_v3_head values ('stream-real-temp', 'payload-real-temp', 'onebot:user:10001', '${tempContext}');
insert into memory_v3_lexical_document values ('stream-probe', 'event-probe');
insert into memory_v3_lexical_document values ('stream-group-probe', 'event-group-probe');
insert into memory_v3_lexical_document values ('stream-assistant-probe', 'event-assistant-probe');
insert into memory_v3_lexical_document values ('stream-fake-real', 'event-fake-real');
insert into memory_v3_lexical_document values ('stream-real-temp', 'event-real-temp');
insert into memory_v3_lexical_term values ('stream-probe');
insert into memory_v3_lexical_term values ('stream-group-probe');
insert into memory_v3_lexical_term values ('stream-assistant-probe');
insert into memory_v3_lexical_term values ('stream-fake-real');
insert into memory_v3_lexical_term values ('stream-real-temp');
insert into memory_v3_work values ('onebot:user:${OWNED_USER_ID}', '${tempContext}');
insert into memory_v3_work values ('onebot:user:${OWNED_USER_ID}', '${realContext}');
insert into memory_v3_work values ('onebot:user:10001', '${tempWorkOnlyContext}');
insert into memory_v3_cursor values ('onebot:user:${OWNED_USER_ID}', '${tempContext}');
insert into memory_v3_suppression values ('onebot:user:${OWNED_USER_ID}', '${tempContext}');
insert into memory_v3_audit values ('onebot:user:${OWNED_USER_ID}', '${tempContext}');
        `,
      ],
      { encoding: 'utf8' },
    );

    execFileSync('bash', [resolve(process.cwd(), 'scripts/cleanup-probe-chat-state.sh'), journalPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        QQBOT_KOISHI_DB_PATH: dbPath,
        QQBOT_PROBE_OWNERSHIP_DIR: ownershipDir,
      },
    });

    expect(sqlite(dbPath, "select count(*) from chathub_room where roomId = 147;")).toBe('0');
    expect(sqlite(dbPath, `select activeConversationId || '|' || coalesce(lastConversationId, '') from chatluna_binding where bindingKey = '${bindingKey}';`)).toBe('previous-conversation|');
    expect(sqlite(dbPath, "select count(*) from chatluna_conversation where id in ('probe-conversation', 'legacy-probe-conversation');")).toBe('0');
    expect(sqlite(dbPath, "select count(*) from chatluna_message where conversationId in ('probe-conversation', 'legacy-probe-conversation');")).toBe('0');
    expect(sqlite(dbPath, "select count(*) from chathub_room_member where roomId = 147;")).toBe('0');
    expect(sqlite(dbPath, `select count(*) from chathub_user where userId = '${OWNED_USER_ID}' and groupId = '${OWNED_GROUP_ID}';`)).toBe('0');
    expect(sqlite(dbPath, "select count(*) from memory_v3_event where eventId in ('event-probe', 'event-group-probe', 'event-assistant-probe');")).toBe('0');
    expect(sqlite(dbPath, "select count(*) from memory_v3_event where eventId in ('event-fake-real', 'event-real-temp');")).toBe('2');
    expect(sqlite(dbPath, `select count(*) from memory_v3_principal where userKey = 'onebot:user:${OWNED_USER_ID}';`)).toBe('1');
    expect(sqlite(dbPath, `select count(*) from memory_v3_context where groupId = '${OWNED_GROUP_ID}';`)).toBe('2');
    expect(sqlite(dbPath, `select count(*) from memory_v3_context where contextKey = '${tempWorkOnlyContext}';`)).toBe('1');
    expect(sqlite(dbPath, `select count(*) from memory_v3_work where subjectKey = 'onebot:user:${OWNED_USER_ID}' and contextKey = '${tempContext}';`)).toBe('0');
    expect(sqlite(dbPath, `select count(*) from memory_v3_work where subjectKey = 'onebot:user:${OWNED_USER_ID}' and contextKey = '${realContext}';`)).toBe('1');
    expect(existsSync(journalPath)).toBe(false);
  });

  it('refuses to delete an owned room after a foreign member is attached', () => {
    const dir = createTempDir();
    const dbPath = join(dir, 'koishi.db');
    const journalPath = createOwnershipJournal(dir);
    const ownershipDir = join(dir, 'probe-ownership');
    const marker = JSON.stringify({
      qqbotProbe: {
        schemaVersion: 1,
        token: OWNERSHIP_TOKEN,
        userId: OWNED_USER_ID,
        groupId: OWNED_GROUP_ID,
      },
    });
    const bindingKey = `shared:onebot:2219854433:${OWNED_GROUP_ID}:preset:sakiko`;
    writeFileSync(dbPath, '');
    sqlite(dbPath, `
create table chathub_room (roomId integer primary key, roomName text, conversationId text, roomMasterId text);
create table chatluna_binding (bindingKey text primary key, activeConversationId text, lastConversationId text, updatedAt integer);
create table chatluna_conversation (id text primary key, bindingKey text, title text, createdBy text, additional_kwargs text, latestMessageId text, updatedAt integer);
create table chathub_room_member (userId text, roomId integer, primary key (userId, roomId));
create table chathub_user (userId text, defaultRoomId integer, groupId text, primary key (userId, groupId));
create table chatluna_message (id text primary key, conversationId text);
insert into chatluna_binding values ('${bindingKey}', 'probe-conversation', 'previous-conversation', 200);
insert into chatluna_conversation values ('probe-conversation', '${bindingKey}', 'probe', '${OWNED_USER_ID}', '${marker}', null, 0);
insert into chatluna_conversation values ('legacy-probe-conversation', null, 'legacy', '${OWNED_USER_ID}', '${marker}', null, 0);
insert into chathub_room values (147, 'qqbot-probe:${OWNERSHIP_TOKEN}', 'legacy-probe-conversation', '${OWNED_USER_ID}');
insert into chathub_room_member values ('${OWNED_USER_ID}', 147);
insert into chathub_room_member values ('10001', 147);
insert into chathub_user values ('${OWNED_USER_ID}', 147, '${OWNED_GROUP_ID}');
insert into chatluna_message values ('probe-message', 'probe-conversation');
insert into chatluna_message values ('legacy-message', 'legacy-probe-conversation');
    `);

    const result = spawnSync(
      'bash',
      [resolve(process.cwd(), 'scripts/cleanup-probe-chat-state.sh'), journalPath],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          QQBOT_KOISHI_DB_PATH: dbPath,
          QQBOT_PROBE_OWNERSHIP_DIR: ownershipDir,
        },
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('foreign user member');
    expect(sqlite(dbPath, 'select count(*) from chathub_room where roomId=147;')).toBe('1');
    expect(sqlite(dbPath, 'select count(*) from chatluna_message;')).toBe('2');
    expect(existsSync(journalPath)).toBe(true);
  });

  it('refuses cleanup when the conversation or binding ownership marker changed', () => {
    const dir = createTempDir();
    const dbPath = join(dir, 'koishi.db');
    const ownershipDir = join(dir, 'probe-ownership');
    const journalPath = createOwnershipJournal(dir);
    const bindingKey = `shared:onebot:2219854433:${OWNED_GROUP_ID}:preset:sakiko`;
    writeFileSync(dbPath, '');
    sqlite(dbPath, `
create table chatluna_binding (bindingKey text primary key, activeConversationId text, lastConversationId text, updatedAt integer);
create table chatluna_conversation (id text primary key, bindingKey text, title text, createdBy text, additional_kwargs text, latestMessageId text, updatedAt integer);
create table chatluna_message (id text primary key, conversationId text);
insert into chatluna_binding values ('${bindingKey}', 'probe-conversation', null, 200);
insert into chatluna_conversation values ('probe-conversation', '${bindingKey}', 'probe', '${OWNED_USER_ID}', '{"qqbotProbe":{"token":"somebody-else"}}', null, 0);
    `);

    expect(() => execFileSync('bash', [resolve(process.cwd(), 'scripts/cleanup-probe-chat-state.sh'), journalPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        QQBOT_KOISHI_DB_PATH: dbPath,
        QQBOT_PROBE_OWNERSHIP_DIR: ownershipDir,
      },
    })).toThrow();
    expect(sqlite(dbPath, `select activeConversationId from chatluna_binding where bindingKey = '${bindingKey}';`)).toBe('probe-conversation');
    expect(sqlite(dbPath, "select count(*) from chatluna_conversation where id = 'probe-conversation';")).toBe('1');
    expect(existsSync(journalPath)).toBe(true);
  });

  it('refuses cleanup when another conversation took over the probe binding', () => {
    const dir = createTempDir();
    const dbPath = join(dir, 'koishi.db');
    const ownershipDir = join(dir, 'probe-ownership');
    const journalPath = createOwnershipJournal(dir);
    const bindingKey = `shared:onebot:2219854433:${OWNED_GROUP_ID}:preset:sakiko`;
    const marker = JSON.stringify({
      qqbotProbe: {
        schemaVersion: 1,
        token: OWNERSHIP_TOKEN,
        userId: OWNED_USER_ID,
        groupId: OWNED_GROUP_ID,
      },
    });
    writeFileSync(dbPath, '');
    sqlite(dbPath, `
create table chatluna_binding (bindingKey text primary key, activeConversationId text, lastConversationId text, updatedAt integer);
create table chatluna_conversation (id text primary key, bindingKey text, title text, createdBy text, additional_kwargs text, latestMessageId text, updatedAt integer);
create table chatluna_message (id text primary key, conversationId text);
insert into chatluna_binding values ('${bindingKey}', 'foreign-conversation', null, 200);
insert into chatluna_conversation values ('probe-conversation', '${bindingKey}', 'probe', '${OWNED_USER_ID}', '${marker}', null, 0);
    `);

    const result = spawnSync('bash', [resolve(process.cwd(), 'scripts/cleanup-probe-chat-state.sh'), journalPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        QQBOT_KOISHI_DB_PATH: dbPath,
        QQBOT_PROBE_OWNERSHIP_DIR: ownershipDir,
      },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Active binding is no longer owned');
    expect(sqlite(dbPath, `select activeConversationId from chatluna_binding where bindingKey = '${bindingKey}';`)).toBe('foreign-conversation');
    expect(sqlite(dbPath, "select count(*) from chatluna_conversation where id = 'probe-conversation';")).toBe('1');
    expect(existsSync(journalPath)).toBe(true);
  });

  it('rolls back every deletion when an in-transaction ownership guard fails', () => {
    const dir = createTempDir();
    const dbPath = join(dir, 'koishi.db');
    const ownershipDir = join(dir, 'probe-ownership');
    const journalPath = createOwnershipJournal(dir);
    const bindingKey = `shared:onebot:2219854433:${OWNED_GROUP_ID}:preset:sakiko`;
    const marker = JSON.stringify({
      qqbotProbe: {
        schemaVersion: 1,
        token: OWNERSHIP_TOKEN,
        userId: OWNED_USER_ID,
        groupId: OWNED_GROUP_ID,
      },
    });
    writeFileSync(dbPath, '');
    sqlite(dbPath, `
create table chatluna_binding (bindingKey text primary key, activeConversationId text, lastConversationId text, updatedAt integer);
create table chatluna_conversation (id text primary key, bindingKey text, title text, createdBy text, additional_kwargs text, latestMessageId text, updatedAt integer);
create table chatluna_message (id text primary key, conversationId text);
insert into chatluna_binding values ('${bindingKey}', 'probe-conversation', 'previous-conversation', 200);
insert into chatluna_conversation values ('probe-conversation', '${bindingKey}', 'probe', '${OWNED_USER_ID}', '${marker}', null, 0);
insert into chatluna_message values ('probe-message', 'probe-conversation');
create trigger refuse_binding_restore before update on chatluna_binding
when old.bindingKey='${bindingKey}'
begin
  select raise(ignore);
end;
    `);

    const result = spawnSync(
      'bash',
      [resolve(process.cwd(), 'scripts/cleanup-probe-chat-state.sh'), journalPath],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          QQBOT_KOISHI_DB_PATH: dbPath,
          QQBOT_PROBE_OWNERSHIP_DIR: ownershipDir,
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('CHECK constraint failed');
    expect(sqlite(dbPath, `select activeConversationId from chatluna_binding where bindingKey='${bindingKey}';`)).toBe('probe-conversation');
    expect(sqlite(dbPath, "select count(*) from chatluna_conversation where id='probe-conversation';")).toBe('1');
    expect(sqlite(dbPath, "select count(*) from chatluna_message where id='probe-message';")).toBe('1');
    expect(existsSync(journalPath)).toBe(true);
  });

  it('finishes journal recovery after the binding was restored but owned rows remain', () => {
    const dir = createTempDir();
    const dbPath = join(dir, 'koishi.db');
    const ownershipDir = join(dir, 'probe-ownership');
    const journalPath = createOwnershipJournal(dir);
    const bindingKey = `shared:onebot:2219854433:${OWNED_GROUP_ID}:preset:sakiko`;
    const marker = JSON.stringify({
      qqbotProbe: {
        schemaVersion: 1,
        token: OWNERSHIP_TOKEN,
        userId: OWNED_USER_ID,
        groupId: OWNED_GROUP_ID,
      },
    });
    writeFileSync(dbPath, '');
    sqlite(dbPath, `
create table chatluna_binding (bindingKey text primary key, activeConversationId text, lastConversationId text, updatedAt integer);
create table chatluna_conversation (id text primary key, bindingKey text, title text, createdBy text, additional_kwargs text, latestMessageId text, updatedAt integer);
create table chatluna_message (id text primary key, conversationId text);
insert into chatluna_binding values ('${bindingKey}', 'previous-conversation', null, 100);
insert into chatluna_conversation values ('probe-conversation', '${bindingKey}', 'probe', '${OWNED_USER_ID}', '${marker}', null, 0);
insert into chatluna_message values ('message-1', 'probe-conversation');
    `);

    execFileSync('bash', [resolve(process.cwd(), 'scripts/cleanup-probe-chat-state.sh'), journalPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        QQBOT_KOISHI_DB_PATH: dbPath,
        QQBOT_PROBE_OWNERSHIP_DIR: ownershipDir,
      },
    });
    expect(sqlite(dbPath, `select activeConversationId from chatluna_binding where bindingKey = '${bindingKey}';`)).toBe('previous-conversation');
    expect(sqlite(dbPath, "select count(*) from chatluna_conversation where id = 'probe-conversation';")).toBe('0');
    expect(sqlite(dbPath, "select count(*) from chatluna_message where conversationId = 'probe-conversation';")).toBe('0');
    expect(existsSync(journalPath)).toBe(false);
  });

  it('refuses a journal for the live acceptance group', () => {
    const dir = createTempDir();
    const dbPath = join(dir, 'koishi.db');
    writeFileSync(dbPath, '');
    const ownershipDir = join(dir, 'probe-ownership');
    const journalPath = createOwnershipJournal(dir, {
      groupId: shared.LIVE_ACCEPTANCE_GROUP_ID,
      phase: 'reserved',
      bindingKey: null,
      conversationId: null,
      previousBinding: null,
    });
    const result = spawnSync('bash', [resolve(process.cwd(), 'scripts/cleanup-probe-chat-state.sh'), journalPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        QQBOT_KOISHI_DB_PATH: dbPath,
        QQBOT_PROBE_OWNERSHIP_DIR: ownershipDir,
      },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Refusing to clean the live acceptance group');
    expect(existsSync(journalPath)).toBe(true);
  });

  it('rejects a partial Memory V3 identity schema', () => {
    const dir = createTempDir();
    const dbPath = join(dir, 'koishi.db');
    const ownershipDir = join(dir, 'probe-ownership');
    const journalPath = createOwnershipJournal(dir, {
      phase: 'reserved',
      bindingKey: null,
      conversationId: null,
      previousBinding: null,
    });
    writeFileSync(dbPath, '');
    execFileSync(
      'sqlite3',
      [
        dbPath,
        `
create table chathub_user (userId text, defaultRoomId integer, groupId text, primary key (userId, groupId));
create table memory_v3_principal (id integer primary key, userKey text, platform text, userId text);
insert into memory_v3_principal values (1, 'onebot:user:${OWNED_USER_ID}', 'onebot', '${OWNED_USER_ID}');
        `,
      ],
      { encoding: 'utf8' },
    );

    expect(() => execFileSync(
      'bash',
      [resolve(process.cwd(), 'scripts/cleanup-probe-chat-state.sh'), journalPath],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          QQBOT_KOISHI_DB_PATH: dbPath,
          QQBOT_PROBE_OWNERSHIP_DIR: ownershipDir,
        },
      },
    )).toThrow();
    expect(sqlite(dbPath, 'select count(*) from memory_v3_principal;')).toBe('1');
  });
});
