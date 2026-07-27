import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  modelConfigDocumentSchema,
  modelConfigDraftSchema,
} from '../../src/plugins/model-config/index.js';
import { createValidModelConfigDraft } from './fixtures.js';

interface ContractPlan {
  changed: boolean;
  document: Record<string, unknown>;
  report: {
    fromVersion: number;
    toVersion: number;
    removedBindings: number;
    savedRevision: number;
    appliedRevision: number;
  };
}

async function loadPlanner(): Promise<{
  buildModelConfigContractPlan(
    document: Record<string, unknown>,
    now?: Date,
  ): ContractPlan;
}> {
  return import(pathToFileURL(
    resolve(process.cwd(), 'deploy/model-config-contract.mjs'),
  ).href);
}

function createLegacyDocument(): Record<string, unknown> {
  const draft = createValidModelConfigDraft();
  return {
    schemaVersion: 1,
    savedRevision: 7,
    appliedRevision: 7,
    updatedAt: '2026-07-27T00:00:00.000Z',
    migration: null,
    ...draft,
    bindings: [
      ...draft.bindings,
      {
        workload: 'search.summary',
        mode: 'inheritInvocation',
      },
    ],
    secrets: [
      {
        secretRef: 'connection:primary:api-key',
        connectionId: 'primary',
        cipherText: 'cipher-text',
        meta: 'cipher-meta',
      },
      {
        secretRef: 'connection:repairable:api-key',
        connectionId: 'repairable',
        cipherText: 'repairable-cipher-text',
        meta: 'repairable-cipher-meta',
      },
    ],
  };
}

describe('model config contract migration', () => {
  it('upgrades v1, removes search.summary, and leaves apply pending', async () => {
    const planner = await loadPlanner();
    const plan = planner.buildModelConfigContractPlan(
      createLegacyDocument(),
      new Date('2026-07-27T01:02:03.000Z'),
    );

    expect(plan).toMatchObject({
      changed: true,
      report: {
        fromVersion: 1,
        toVersion: 2,
        removedBindings: 1,
        savedRevision: 8,
        appliedRevision: 7,
      },
    });
    const document = modelConfigDocumentSchema.parse(plan.document);
    expect(document.updatedAt).toBe('2026-07-27T01:02:03.000Z');
    expect(document.bindings.map((binding) => binding.workload))
      .not.toContain('search.summary');
  });

  it('leaves an already-current document unchanged', async () => {
    const planner = await loadPlanner();
    const first = planner.buildModelConfigContractPlan(createLegacyDocument());
    const second = planner.buildModelConfigContractPlan(first.document);

    expect(second.changed).toBe(false);
    expect(second.document).toBe(first.document);
    expect(second.report).toMatchObject({
      fromVersion: 2,
      toVersion: 2,
      removedBindings: 0,
    });
  });

  it('returns a schema issue for a removed workload without throwing', () => {
    const draft = createValidModelConfigDraft();
    const parse = () => modelConfigDraftSchema.safeParse({
      ...draft,
      bindings: [
        ...draft.bindings,
        {
          workload: 'search.summary',
          mode: 'inheritInvocation',
        },
      ],
    });

    expect(parse).not.toThrow();
    expect(parse().success).toBe(false);
  });
});
