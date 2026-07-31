import { describe, expect, it } from 'vitest';
import {
  buildAgentToolOverride,
  canAddAgentToolOverride,
  createAgentPolicyScopeOptions,
  createAgentToolOverrideDraft,
  hasAgentToolOverride,
} from '../apps/admin-web/src/pages/agent-tool-policy.js';

describe('Agent Tools policy draft state', () => {
  it('deduplicates canonical scopes while preserving the preferred label', () => {
    expect(createAgentPolicyScopeOptions(
      [
        { scopeKind: 'global_default', scopeId: 'global-default', title: '全局默认' },
        { scopeKind: 'private_default', scopeId: 'private-default', title: '私聊默认' },
      ],
      [
        { scopeKind: 'global_default', scopeId: 'global-default', roomName: '全局默认' },
        { scopeKind: 'private_default', scopeId: 'private-default', roomName: '所有私聊' },
      ],
    )).toEqual([
      {
        key: 'global_default\u0000global-default',
        scopeKind: 'global_default',
        scopeId: 'global-default',
        label: '全局默认',
      },
      {
        key: 'private_default\u0000private-default',
        scopeKind: 'private_default',
        scopeId: 'private-default',
        label: '私聊默认',
      },
    ]);
  });

  it('requires both tool and scope before creating an override', () => {
    const draft = createAgentToolOverrideDraft();
    const scope = { scopeKind: 'global_default' as const, scopeId: 'global' };

    expect(draft).not.toHaveProperty('scopeKind');
    expect(draft).not.toHaveProperty('scopeId');
    expect(canAddAgentToolOverride(draft, scope)).toBe(false);
    expect(() => buildAgentToolOverride(draft, scope))
      .toThrow('添加工具覆盖前必须选择工具');

    draft.toolName = 'web_run';
    expect(canAddAgentToolOverride(draft, null)).toBe(false);
    expect(() => buildAgentToolOverride(draft, null))
      .toThrow('添加工具覆盖前必须选择范围');

    expect(canAddAgentToolOverride(draft, scope)).toBe(true);
    expect(buildAgentToolOverride(draft, scope)).toEqual({
      toolName: 'web_run',
      routeProfile: 'agent',
      enabled: true,
      scopeKind: 'global_default',
      scopeId: 'global',
    });
    expect(hasAgentToolOverride([buildAgentToolOverride(draft, scope)], draft, scope)).toBe(true);
    expect(hasAgentToolOverride(
      [buildAgentToolOverride(draft, scope)],
      { ...draft, routeProfile: 'automation' },
      scope,
    )).toBe(false);
  });
});
