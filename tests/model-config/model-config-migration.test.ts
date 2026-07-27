import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  buildModelConfigMigrationPlan,
  parseModelConfigCutoverArgs,
  runModelConfigCutover,
  type ModelConfigCutoverOptions,
} from '../../src/tools/model-config-cutover.js';
import {
  modelConfigDocumentSchema,
  ModelConfigService,
  type ModelBinding,
} from '../../src/plugins/model-config/index.js';

const API_KEY = 'cutover-super-secret';
const GENERIC_API_KEY = 'generic-openai-only-secret';
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface Fixture {
  root: string;
  database: string;
  envBase: string;
  envOverride: string;
  agentDataRoot: string;
  legacyAgentRoot: string;
  agentConfig: string;
  agentMarkdown: string;
  agentSkill: string;
  legacyAgentConfig: string;
  legacyAgentMarkdown: string;
  legacyAgentSkill: string;
  archiveRoot: string;
  archiveConversation: string;
  configOut: string;
  kekOut: string;
  backupDir: string;
  report: string;
  systemctl: string;
  markdownAgentId: string;
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'qqbot-model-config-cutover-'));
  tempDirectories.push(root);
  const database = join(root, 'koishi.db');
  const envBase = join(root, '.env.server');
  const envOverride = join(root, '.env.runtime');
  const agentDataRoot = join(root, 'data/chatluna');
  const legacyAgentRoot = join(root, 'old-app/data/chatluna/agent');
  const legacyAgentDir = join(legacyAgentRoot, 'agents');
  const legacySkillDir = join(
    legacyAgentRoot,
    'skills/sub-agent-creator',
  );
  const agentConfig = join(agentDataRoot, 'agents/config.json');
  const agentMarkdown = join(agentDataRoot, 'agents/reviewer.md');
  const agentSkill = join(
    agentDataRoot,
    'skills/sub-agent-creator/SKILL.md',
  );
  const legacyAgentConfig = join(legacyAgentRoot, 'config.json');
  const legacyAgentMarkdown = join(legacyAgentDir, 'reviewer.md');
  const legacyAgentSkill = join(legacySkillDir, 'SKILL.md');
  const archiveRoot = join(root, 'archives');
  const archivePath = join(archiveRoot, 'archive-one');
  const archiveConversation = join(archivePath, 'conversation.json');
  const configOut = join(root, 'runtime/model-config.json');
  const kekOut = join(root, 'shared/model-config.kek');
  const backupDir = join(root, 'backup');
  const report = join(backupDir, 'applied.json');
  const systemctl = join(root, 'systemctl');

  mkdirSync(legacyAgentDir, { recursive: true });
  mkdirSync(legacySkillDir, { recursive: true });
  mkdirSync(archivePath, { recursive: true });
  writeFileSync(envBase, `
CHATLUNA_ACTIVE_TAB=openai
CHATLUNA_PLATFORM=openai
CHATLUNA_BASE_URL=https://models.example.test/v1/
CHATLUNA_API_KEY=${API_KEY}
CHATLUNA_DEFAULT_MODEL=openai/gpt-main
CHATLUNA_OPENAI_BASE_URL=https://models.example.test/v1
CHATLUNA_OPENAI_API_KEY=${API_KEY}
CHATLUNA_OPENAI_DEFAULT_MODEL=openai/gpt-main
CHATLUNA_MAX_CONTEXT_RATIO=0.35
MEMORY_EXTRACT_BASE_URL=https://models.example.test/v1/chat/completions
MEMORY_EXTRACT_API_KEY=${API_KEY}
MEMORY_EXTRACT_MODEL=gpt-main
MEMORY_EXTRACT_TIMEOUT_MS=90000
MEMORY_EXTRACT_REQUEST_MODE=chat_completions
MEMORY_EXTRACT_STRUCTURED_OUTPUT_PROTOCOL=native_chat_json_schema
MEMORY_EMBED_BASE_URL=https://embedding.example.test/v1
CHAT_NATURAL_TRIGGER_DECISION_ENABLED=true
CHAT_NATURAL_TRIGGER_DECISION_BASE_URL=https://decision.example.test/v1
STICKER_INDEXER_API_KEY=
TASK_AUTOMATION_CHAT_REPLY_MODEL=openai/gpt-main
TASK_AUTOMATION_DELIVERY_MODEL=openai/gpt-main
TASK_AUTOMATION_INTENT_BASE_URL=https://models.example.test/v1
TASK_AUTOMATION_INTENT_API_KEY=${API_KEY}
TASK_AUTOMATION_INTENT_MODEL=gpt-main
UNRELATED_BASE=keep-me
`.trimStart(), 'utf8');
  writeFileSync(envOverride, `
CHATLUNA_OPENAI_BASE_URL=https://models.example.test/v1/
UNRELATED_OVERRIDE=keep-me-too
`.trimStart(), 'utf8');

  const markdownAgentId = createHash('sha1')
    .update(agentMarkdown)
    .digest('hex')
    .slice(0, 16);
  const legacyMarkdownAgentId = createHash('sha1')
    .update(legacyAgentMarkdown)
    .digest('hex')
    .slice(0, 16);
  writeFileSync(legacyAgentConfig, `${JSON.stringify({
    version: 4,
    subAgent: {
      dirs: [],
      items: {
        [legacyMarkdownAgentId]: {
          enabled: true,
          model: 'openai/gpt-main',
        },
      },
      builtin: {},
      presetAgents: {
        'Research Agent': {
          name: 'Research Agent',
          enabled: true,
          model: 'openai/gpt-main',
          permissions: {
            tools: {
              mode: 'allow',
              allow: ['web_search', 'browser_open', 'file_read'],
              deny: [],
            },
          },
        },
      },
    },
    tool: {
      items: {
        web_search: {
          enabled: true,
          main: true,
          authority: 0,
        },
        browser_open: {
          enabled: false,
          main: false,
          authority: 0,
        },
        file_read: {
          enabled: true,
          main: true,
          authority: 0,
        },
      },
      registry: {},
    },
  }, null, 2)}\n`, 'utf8');
  writeFileSync(legacyAgentMarkdown, `---
name: reviewer
description: Reviews changes
model: openai/gpt-main
---
Review the requested changes.
`, 'utf8');
  writeFileSync(legacyAgentSkill, `---
name: sub-agent-creator
description: Creates sub-agents
---
Web research agents may need \`web_search\`, \`browser_open\`,
\`browser_read_text\`, and \`browser_summarize\`.

\`\`\`yaml
permissions:
  tools:
    mode: allow
    allow: [web_search, browser_open, browser_read_text, browser_summarize]
\`\`\`
`, 'utf8');
  writeFileSync(archiveConversation, `${JSON.stringify({
    id: 'conversation-archive',
    model: 'openai/gpt-main',
    preset: 'sakiko',
  }, null, 2)}\n`, 'utf8');
  writeFileSync(systemctl, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" != "show" || "$3" != "--property=ActiveState" || "$4" != "--value" ]]; then
  exit 2
fi
printf 'inactive\\n'
`, { encoding: 'utf8', mode: 0o700 });

  const sqlite = new DatabaseSync(database);
  try {
    sqlite.exec(`
      create table chatluna_conversation (
        id text primary key,
        model text null
      );
      create table chathub_room (
        roomId integer primary key,
        model text null
      );
      create table automation_job (
        id integer primary key,
        sourceRoomId integer not null,
        sourceConversationId text null,
        status text not null
      );
      create table affinity_config (
        id integer primary key,
        key text not null,
        value text null
      );
      create table chatluna_archive (
        id text primary key,
        path text not null,
        state text not null
      );
    `);
    sqlite.prepare(
      'insert into chatluna_conversation(id, model) values (?, ?)',
    ).run('conversation-one', 'openai/gpt-main');
    sqlite.prepare(
      'insert into chathub_room(roomId, model) values (?, ?)',
    ).run(7, 'openai/gpt-main');
    sqlite.prepare(
      'insert into automation_job(id, sourceRoomId, sourceConversationId, status) values (?, ?, ?, ?)',
    ).run(11, 999, 'conversation-one', 'active');
    sqlite.prepare(
      'insert into affinity_config(id, key, value) values (?, ?, ?)',
    ).run(1, 'analysisModel', JSON.stringify({
      baseUrl: '',
      apiKey: '',
      model: '',
      requestMode: 'chat_completions',
      structuredOutputProtocol: 'chat_reply_v1',
      timeoutMs: 5_000,
    }));
    sqlite.prepare(
      'insert into chatluna_archive(id, path, state) values (?, ?, ?)',
    ).run('archive-one', archivePath, 'ready');
  } finally {
    sqlite.close();
  }

  return {
    root,
    database,
    envBase,
    envOverride,
    agentDataRoot,
    legacyAgentRoot,
    agentConfig,
    agentMarkdown,
    agentSkill,
    legacyAgentConfig,
    legacyAgentMarkdown,
    legacyAgentSkill,
    archiveRoot,
    archiveConversation,
    configOut,
    kekOut,
    backupDir,
    report,
    systemctl,
    markdownAgentId,
  };
}

function options(
  fixture: Fixture,
  command: 'preflight' | 'apply',
): ModelConfigCutoverOptions {
  return {
    command,
    database: fixture.database,
    envFiles: [fixture.envBase, fixture.envOverride],
    agentDataRoot: fixture.agentDataRoot,
    legacyAgentRoot: fixture.legacyAgentRoot,
    agentDirs: [],
    modelMaps: [],
    modelMapFile: null,
    archiveRoot: fixture.archiveRoot,
    configOut: fixture.configOut,
    kekOut: fixture.kekOut,
    backupDir: command === 'apply' ? fixture.backupDir : null,
    report: command === 'apply' ? fixture.report : null,
    systemctl: fixture.systemctl,
    confirmServiceStopped: command === 'apply',
    now: () => new Date('2026-07-26T12:34:56.000Z'),
  };
}

function binding(
  bindings: ModelBinding[],
  workload: string,
): ModelBinding {
  const result = bindings.find((item) => item.workload === workload);
  if (!result) throw new Error(`Missing binding: ${workload}`);
  return result;
}

function sqliteValue(databasePath: string, sql: string): unknown {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (database.prepare(sql).get() as { value?: unknown } | undefined)?.value;
  } finally {
    database.close();
  }
}

describe('model config cutover', () => {
  it('builds its self-contained entrypoint beside the context cutover tools', () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-model-config-builder-'));
    tempDirectories.push(root);
    const output = join(root, 'tools');
    mkdirSync(output, { recursive: true });
    writeFileSync(
      join(output, 'context-preset-cutover.mjs'),
      'export const contextCutover = true;\n',
      'utf8',
    );

    const result = spawnSync(process.execPath, [
      resolve(process.cwd(), 'scripts/build-model-config-cutover-tool.mjs'),
      '--out-dir',
      output,
    ], { encoding: 'utf8' });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(output, 'context-preset-cutover.mjs'))).toBe(true);
    expect(existsSync(join(output, 'model-config-cutover.mjs'))).toBe(true);
    expect(existsSync(join(output, 'model-auth-connection-cutover.mjs'))).toBe(true);
    expect(statSync(join(output, 'model-config-cutover.mjs')).mode & 0o777).toBe(0o700);
    expect(statSync(join(output, 'model-auth-connection-cutover.mjs')).mode & 0o777).toBe(0o700);
  });

  it('preflights all legacy owners without writing or exposing credentials', async () => {
    const fixture = createFixture();
    const before = {
      envBase: readFileSync(fixture.envBase, 'utf8'),
      envOverride: readFileSync(fixture.envOverride, 'utf8'),
      agentConfig: readFileSync(fixture.legacyAgentConfig, 'utf8'),
      agentMarkdown: readFileSync(fixture.legacyAgentMarkdown, 'utf8'),
      agentSkill: readFileSync(fixture.legacyAgentSkill, 'utf8'),
      archive: readFileSync(fixture.archiveConversation, 'utf8'),
      databaseModel: sqliteValue(
        fixture.database,
        "select model as value from chatluna_conversation where id = 'conversation-one'",
      ),
    };

    const plan = await buildModelConfigMigrationPlan(options(fixture, 'preflight'));
    const serialized = JSON.stringify(plan.report);

    expect(plan.report).toMatchObject({
      command: 'preflight',
      dryRun: true,
      applied: false,
      summary: {
        connectionCount: 1,
        modelCount: 1,
        databaseChangeCount: 2,
        affinityDeleteCount: 1,
        automationReferenceCount: 1,
        agentFileChangeCount: 3,
        archiveChangeCount: 1,
      },
    });
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain('cipherText');
    expect(plan.report.connections[0]).toMatchObject({
      adapter: 'openaiCompatible',
      baseUrl: 'https://models.example.test/v1',
      auth: {
        kind: 'apiKey',
        credentialState: 'configured',
      },
    });
    expect(plan.report.contextBudget).toEqual({
      legacyMaxContextRatio: 0.35,
      nominalChatContextSize: 128_000,
      effectiveChatContextSize: 44_800,
    });
    expect(plan.report.automationReferences).toEqual([{
      jobId: '11',
      sourceRoomId: '999',
      sourceConversationId: 'conversation-one',
      conversationModel: 'openai/gpt-main',
      canonicalModel: expect.stringMatching(/^qqbot-[a-z0-9-]+\/[a-z0-9._-]+$/u),
    }]);
    const legacyMarkdownAgentId = createHash('sha1')
      .update(fixture.legacyAgentMarkdown)
      .digest('hex')
      .slice(0, 16);
    expect(plan.report.agentIdMappings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'markdown',
        oldAgentId: legacyMarkdownAgentId,
        canonicalAgentId: fixture.markdownAgentId,
      }),
      expect.objectContaining({
        source: 'preset',
        oldAgentId: 'preset:Research Agent',
        canonicalAgentId: 'preset:research-agent',
      }),
    ]));
    expect(plan.draft.models.every((model) =>
      model.modelType !== 'chat' || model.contextSize === 44_800)).toBe(true);
    expect(binding(plan.draft.bindings, 'memory.extract').mode).toBe('dedicated');
    expect(binding(plan.draft.bindings, 'memory.embedding').mode).toBe('disabled');
    expect(binding(plan.draft.bindings, 'chatluna.defaultEmbedding').mode).toBe('disabled');
    expect(binding(plan.draft.bindings, 'affinity.analysis').mode).toBe('inheritMain');
    expect(binding(plan.draft.bindings, 'naturalTrigger.decision').mode).toBe('disabled');
    expect(
      binding(plan.draft.bindings, 'agent.subagent.preset:research-agent').mode,
    ).toBe('dedicated');
    expect(
      binding(plan.draft.bindings, `agent.subagent.${fixture.markdownAgentId}`).mode,
    ).toBe('dedicated');
    expect(plan.report.modelMappings).toContainEqual({
      legacyModel: 'openai/gpt-main',
      canonicalModel: expect.stringMatching(/^qqbot-[a-z0-9-]+\/[a-z0-9._-]+$/u),
      sources: expect.arrayContaining([
        'chatluna_conversation:conversation-one',
        'chathub_room:7',
        'agent-json:preset:research-agent',
        `agent-json:${fixture.markdownAgentId}`,
        `agent-markdown:${fixture.markdownAgentId}`,
        'archive:archive-one',
        'legacy-env:TASK_AUTOMATION_CHAT_REPLY_MODEL',
        'legacy-env:TASK_AUTOMATION_DELIVERY_MODEL',
      ]),
    });

    expect(readFileSync(fixture.envBase, 'utf8')).toBe(before.envBase);
    expect(readFileSync(fixture.envOverride, 'utf8')).toBe(before.envOverride);
    expect(readFileSync(fixture.legacyAgentConfig, 'utf8')).toBe(before.agentConfig);
    expect(readFileSync(fixture.legacyAgentMarkdown, 'utf8')).toBe(before.agentMarkdown);
    expect(readFileSync(fixture.legacyAgentSkill, 'utf8')).toBe(before.agentSkill);
    expect(existsSync(fixture.agentConfig)).toBe(false);
    expect(existsSync(fixture.agentMarkdown)).toBe(false);
    expect(existsSync(fixture.agentSkill)).toBe(false);
    expect(readFileSync(fixture.archiveConversation, 'utf8')).toBe(before.archive);
    expect(sqliteValue(
      fixture.database,
      "select model as value from chatluna_conversation where id = 'conversation-one'",
    )).toBe(before.databaseModel);
    expect(existsSync(fixture.configOut)).toBe(false);
    expect(existsSync(fixture.kekOut)).toBe(false);
    expect(existsSync(fixture.backupDir)).toBe(false);
  });

  it('names migrated connections by provider authentication instead of workload', async () => {
    const fixture = createFixture();
    writeFileSync(
      fixture.envOverride,
      `${readFileSync(fixture.envOverride, 'utf8')}
MEMORY_EXTRACT_BASE_URL=https://api.siliconflow.cn/v1
MEMORY_EXTRACT_API_KEY=extract-credential
MEMORY_EXTRACT_MODEL=Qwen/Qwen3.5-35B-A3B
MEMORY_EMBED_BASE_URL=https://api.siliconflow.cn/v1
MEMORY_EMBED_API_KEY=embedding-credential
MEMORY_EMBED_MODEL=Qwen/Qwen3-Embedding-8B
STICKER_INDEXER_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
STICKER_INDEXER_API_KEY=sticker-credential
STICKER_INDEXER_MODEL=doubao-vision
`,
      'utf8',
    );

    const plan = await buildModelConfigMigrationPlan(options(fixture, 'preflight'));
    const connectionNames = plan.draft.connections.map((connection) => connection.displayName);

    expect(connectionNames).toEqual(expect.arrayContaining([
      'SiliconFlow',
      'Volcengine Ark API Key',
    ]));
    expect(connectionNames).not.toEqual(expect.arrayContaining([
      'Memory extraction',
      'Memory embedding',
      'Sticker indexer',
    ]));
    expect(binding(plan.draft.bindings, 'memory.extract')).toEqual(expect.objectContaining({
      mode: 'dedicated',
      connectionId: 'siliconflow',
    }));
    expect(binding(plan.draft.bindings, 'memory.embedding')).toEqual(expect.objectContaining({
      mode: 'dedicated',
      connectionId: 'siliconflow',
    }));
    expect(binding(plan.draft.bindings, 'sticker.index')).toEqual(expect.objectContaining({
      mode: 'dedicated',
      connectionId: 'volcengine-ark-api-key',
    }));
  });

  it('applies staged artifacts and all SQLite changes through the canonical contract', async () => {
    const fixture = createFixture();
    const report = await runModelConfigCutover(options(fixture, 'apply'));
    const canonicalModel = report.modelMappings.find(
      (mapping) => mapping.legacyModel === 'openai/gpt-main',
    )?.canonicalModel;
    if (!canonicalModel) throw new Error('Missing canonical model mapping.');

    expect(report).toMatchObject({
      command: 'apply',
      dryRun: false,
      applied: true,
    });
    expect(JSON.stringify(report)).not.toContain(API_KEY);
    const documentText = readFileSync(fixture.configOut, 'utf8');
    const document = modelConfigDocumentSchema.parse(JSON.parse(documentText));
    expect(document).toMatchObject({
      schemaVersion: 2,
      savedRevision: 1,
      appliedRevision: 0,
      migration: {
        completedAt: '2026-07-26T12:34:56.000Z',
        sourceVersion: 'legacy-model-config-v1',
        reportHash: report.reportHash,
      },
    });
    expect(documentText).not.toContain(API_KEY);
    expect(document.secrets).toHaveLength(1);
    expect(statSync(fixture.configOut).mode & 0o777).toBe(0o600);
    expect(statSync(fixture.kekOut).mode & 0o777).toBe(0o600);

    for (const path of [fixture.envBase, fixture.envOverride]) {
      const content = readFileSync(path, 'utf8');
      expect(content).not.toMatch(/^CHATLUNA_(?:ACTIVE_TAB|PLATFORM|BASE_URL|API_KEY|DEFAULT_MODEL)=/mu);
      expect(content).not.toContain('MEMORY_EXTRACT_MODEL=');
      expect(content).not.toContain('CHAT_NATURAL_TRIGGER_DECISION_BASE_URL=');
      expect(content).not.toContain('TASK_AUTOMATION_CHAT_REPLY_MODEL=');
      expect(content).not.toContain('TASK_AUTOMATION_DELIVERY_MODEL=');
      expect(content).not.toContain('TASK_AUTOMATION_INTENT_BASE_URL=');
      expect(content).not.toContain('TASK_AUTOMATION_INTENT_API_KEY=');
      expect(content).not.toContain('TASK_AUTOMATION_INTENT_MODEL=');
    }
    expect(readFileSync(fixture.envBase, 'utf8')).toContain('UNRELATED_BASE=keep-me');
    expect(readFileSync(fixture.envOverride, 'utf8')).toContain(
      'UNRELATED_OVERRIDE=keep-me-too',
    );

    expect(sqliteValue(
      fixture.database,
      "select model as value from chatluna_conversation where id = 'conversation-one'",
    )).toBe(canonicalModel);
    expect(sqliteValue(
      fixture.database,
      'select model as value from chathub_room where roomId = 7',
    )).toBe(canonicalModel);
    expect(sqliteValue(
      fixture.database,
      "select count(*) as value from affinity_config where key = 'analysisModel'",
    )).toBe(0);

    const agentConfig = JSON.parse(readFileSync(fixture.agentConfig, 'utf8')) as {
      subAgent: {
        items: Record<string, Record<string, unknown>>;
        presetAgents: Record<string, {
          permissions?: {
            tools?: {
              allow?: string[];
            };
          };
        }>;
      };
      tool: {
        items: Record<string, Record<string, unknown>>;
      };
    };
    expect(Object.keys(agentConfig.subAgent.items)).toEqual([fixture.markdownAgentId]);
    expect(agentConfig.subAgent.items[fixture.markdownAgentId]).not.toHaveProperty('model');
    expect(Object.keys(agentConfig.subAgent.presetAgents)).toEqual([
      'preset:research-agent',
    ]);
    expect(
      agentConfig.subAgent.presetAgents['preset:research-agent'],
    ).not.toHaveProperty('model');
    expect(
      agentConfig.subAgent.presetAgents['preset:research-agent']
        .permissions?.tools?.allow,
    ).toEqual(['web_run', 'file_read']);
    expect(Object.keys(agentConfig.tool.items)).toEqual([
      'file_read',
      'web_run',
    ]);
    expect(agentConfig.tool.items.web_run).toMatchObject({
      enabled: true,
      main: true,
      authority: 0,
    });
    const agentSkill = readFileSync(fixture.agentSkill, 'utf8');
    expect(agentSkill).toContain('Web research agents may need `web_run`.');
    expect(agentSkill).toContain('allow: [web_run]');
    expect(agentSkill).not.toMatch(
      /\b(?:web_search|web_browser|web_fetch|web_post|browser_[a-z0-9_]+)\b/u,
    );
    const markdown = readFileSync(fixture.agentMarkdown, 'utf8');
    const frontmatter = YAML.parse(
      markdown.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? '',
    ) as Record<string, unknown>;
    expect(frontmatter).not.toHaveProperty('model');
    expect(JSON.parse(readFileSync(fixture.archiveConversation, 'utf8'))).toMatchObject({
      model: canonicalModel,
    });

    expect(existsSync(join(fixture.backupDir, 'koishi.db'))).toBe(true);
    expect(existsSync(join(fixture.backupDir, 'preflight-report.json'))).toBe(true);
    expect(existsSync(join(fixture.backupDir, 'archives'))).toBe(true);
    expect(existsSync(join(fixture.backupDir, 'agent-data'))).toBe(true);
    expect(statSync(fixture.backupDir).mode & 0o777).toBe(0o700);
    expect(readFileSync(fixture.report, 'utf8')).not.toContain(API_KEY);
  });

  it('aborts preflight when one legacy model string resolves to conflicting connections', async () => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.database);
    try {
      database.prepare(
        "update affinity_config set value = ? where key = 'analysisModel'",
      ).run(JSON.stringify({
        baseUrl: 'https://affinity.example.test/v1',
        apiKey: 'different-secret',
        model: 'openai/gpt-main',
        requestMode: 'chat_completions',
        structuredOutputProtocol: 'native_chat_json_schema',
        timeoutMs: 5_000,
      }));
    } finally {
      database.close();
    }

    await expect(
      buildModelConfigMigrationPlan(options(fixture, 'preflight')),
    ).rejects.toThrow(/Legacy model openai\/gpt-main resolves to multiple canonical model identities: .*sources: .*profile:affinity:analysis/u);
    expect(existsSync(fixture.configOut)).toBe(false);
    expect(existsSync(fixture.kekOut)).toBe(false);
    expect(existsSync(fixture.backupDir)).toBe(false);
  });

  it('normalizes mapped legacy generic profile models before conflict checks', async () => {
    const fixture = createFixture();
    writeFileSync(fixture.envBase, `${readFileSync(fixture.envBase, 'utf8')}
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_API_KEY=${GENERIC_API_KEY}
OPENAI_MODEL=deepseek/deepseek-chat
`, 'utf8');
    const database = new DatabaseSync(fixture.database);
    try {
      database.prepare(
        'insert into chatluna_conversation(id, model) values (?, ?)',
      ).run('conversation-deepseek', 'deepseek/deepseek-chat');
    } finally {
      database.close();
    }

    const opts = options(fixture, 'preflight');
    opts.modelMaps = [{
      legacyModel: 'deepseek/deepseek-chat',
      profileSourceId: 'legacy:openai-generic',
    }];

    const plan = await buildModelConfigMigrationPlan(opts);
    expect(plan.report.modelMappings).toContainEqual({
      legacyModel: 'deepseek/deepseek-chat',
      canonicalModel: 'qqbot-deepseek-api-key/deepseek-chat',
      sources: expect.arrayContaining([
        'chatluna_conversation:conversation-deepseek',
        'profile:legacy:openai-generic',
      ]),
    });
  });

  it('rejects unknown active tabs before constructing any migration artifact', async () => {
    const fixture = createFixture();
    writeFileSync(
      fixture.envOverride,
      'CHATLUNA_ACTIVE_TAB=unknown-provider\n',
      'utf8',
    );

    await expect(
      buildModelConfigMigrationPlan(options(fixture, 'preflight')),
    ).rejects.toThrow('Unknown CHATLUNA_ACTIVE_TAB: unknown-provider');
    expect(existsSync(fixture.configOut)).toBe(false);
    expect(existsSync(fixture.kekOut)).toBe(false);
  });

  it('requires an explicit mapping for an unknown persisted database model', async () => {
    const fixture = createFixture();
    const database = new DatabaseSync(fixture.database);
    try {
      database.prepare(
        "update chatluna_conversation set model = ? where id = 'conversation-one'",
      ).run('openai/historical-model');
    } finally {
      database.close();
    }

    await expect(
      buildModelConfigMigrationPlan(options(fixture, 'preflight')),
    ).rejects.toThrow(
      'chatluna_conversation(conversation-one) references unknown or ambiguous model openai/historical-model; add --model-map.',
    );
  });

  it('requires an explicit mapping for an unknown recoverable archive model', async () => {
    const fixture = createFixture();
    const archive = JSON.parse(
      readFileSync(fixture.archiveConversation, 'utf8'),
    ) as Record<string, unknown>;
    archive.model = 'openai/archive-only-model';
    writeFileSync(
      fixture.archiveConversation,
      `${JSON.stringify(archive, null, 2)}\n`,
      'utf8',
    );

    await expect(
      buildModelConfigMigrationPlan(options(fixture, 'preflight')),
    ).rejects.toThrow(
      'archive(archive-one) references unknown or ambiguous model openai/archive-only-model; add --model-map.',
    );
  });

  it('loads, reports, and backs up an explicit model mapping file', async () => {
    const fixture = createFixture();
    const mappingFile = join(fixture.root, 'model-config-mapping.json');
    writeFileSync(
      mappingFile,
      `${JSON.stringify({
        'openai/historical-model': 'main:openai',
      }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    const database = new DatabaseSync(fixture.database);
    try {
      database.prepare(
        "update chatluna_conversation set model = ? where id = 'conversation-one'",
      ).run('openai/historical-model');
    } finally {
      database.close();
    }
    const applyOptions = options(fixture, 'apply');
    applyOptions.modelMapFile = mappingFile;

    const report = await runModelConfigCutover(applyOptions);

    expect(report.explicitModelMaps).toEqual([{
      legacyModel: 'openai/historical-model',
      profileSourceId: 'main:openai',
    }]);
    expect(report.modelMappings).toContainEqual(expect.objectContaining({
      legacyModel: 'openai/historical-model',
    }));
    expect(
      readdirSync(join(fixture.backupDir, 'files')).some((name) =>
        name.endsWith('-model-config-mapping.json')),
    ).toBe(true);
    expect(readFileSync(mappingFile, 'utf8')).toContain('main:openai');
  });

  it('rejects missing map targets and duplicate legacy map inputs', async () => {
    const fixture = createFixture();
    const missingTarget = options(fixture, 'preflight');
    missingTarget.modelMaps = [{
      legacyModel: 'openai/historical-model',
      profileSourceId: 'main:missing',
    }];
    await expect(
      buildModelConfigMigrationPlan(missingTarget),
    ).rejects.toThrow(
      'Explicit model map openai/historical-model targets unavailable profile main:missing.',
    );

    expect(() => parseModelConfigCutoverArgs([
      'preflight',
      '--env-file', fixture.envBase,
      '--model-map', 'openai/historical-model=main:openai',
      '--model-map', 'openai/historical-model=main:codex',
    ])).toThrow(
      'Duplicate --model-map legacy model: openai/historical-model',
    );
  });

  it('preserves a credential that exists only in the complete generic OPENAI profile', async () => {
    const fixture = createFixture();
    writeFileSync(
      fixture.envOverride,
      `${readFileSync(fixture.envOverride, 'utf8')}
OPENAI_BASE_URL=https://api.deepseek.com/v1/chat/completions
OPENAI_API_KEY=${GENERIC_API_KEY}
OPENAI_MODEL=deepseek-chat
`,
      'utf8',
    );
    const database = new DatabaseSync(fixture.database);
    try {
      database.prepare(
        "update chatluna_conversation set model = ? where id = 'conversation-one'",
      ).run('deepseek/deepseek-chat');
    } finally {
      database.close();
    }
    const applyOptions = options(fixture, 'apply');
    applyOptions.modelMaps = [{
      legacyModel: 'deepseek/deepseek-chat',
      profileSourceId: 'legacy:openai-generic',
    }];

    const report = await runModelConfigCutover(applyOptions);
    const genericConnection = report.connections.find((connection) =>
      connection.sources.includes('legacy:openai-generic'));
    if (!genericConnection) throw new Error('Missing generic OpenAI connection.');

    expect(JSON.stringify(report)).not.toContain(GENERIC_API_KEY);
    expect(genericConnection).toMatchObject({
      adapter: 'openaiCompatible',
      baseUrl: 'https://api.deepseek.com/v1',
      auth: {
        kind: 'apiKey',
        credentialState: 'configured',
      },
    });
    const service = new ModelConfigService({
      configPath: fixture.configOut,
      kekPath: fixture.kekOut,
    });
    await service.loadAndApply(() => {});
    expect(
      service.getConnectionRuntime(genericConnection.id).connection.apiKey,
    ).toBe(GENERIC_API_KEY);
    expect(readFileSync(fixture.envOverride, 'utf8')).not.toContain('OPENAI_API_KEY=');
  });

  it('rejects an invalid legacy context ratio', async () => {
    const fixture = createFixture();
    writeFileSync(
      fixture.envOverride,
      `${readFileSync(fixture.envOverride, 'utf8')}CHATLUNA_MAX_CONTEXT_RATIO=1.2\n`,
      'utf8',
    );
    await expect(
      buildModelConfigMigrationPlan(options(fixture, 'preflight')),
    ).rejects.toThrow(
      'CHATLUNA_MAX_CONTEXT_RATIO must be greater than 0 and at most 1.',
    );
  });
});
