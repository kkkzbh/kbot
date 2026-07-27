import { describe, expect, it } from 'vitest';
import {
  buildFeatureOverride,
  buildToolOverride,
  canAddFeatureOverride,
  canAddToolOverride,
  createFeatureOverrideDraft,
  createPolicyScopeOptions,
  createToolOverrideDraft,
  hasFeatureOverride,
  hasToolOverride,
} from '../apps/admin-web/src/pages/policy-page-state.js';

describe('admin policy page draft state', () => {
  it('deduplicates canonical scopes while preserving the preferred label', () => {
    expect(createPolicyScopeOptions(
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

  it('requires an explicitly selected scope for feature overrides', () => {
    const draft = createFeatureOverrideDraft();

    expect(draft).not.toHaveProperty('scopeKind');
    expect(draft).not.toHaveProperty('scopeId');
    expect(canAddFeatureOverride(null)).toBe(false);
    expect(() => buildFeatureOverride(draft, null))
      .toThrow('添加功能覆盖前必须选择范围');

    const scope = { scopeKind: 'group', scopeId: '123456' };
    expect(canAddFeatureOverride(scope)).toBe(true);
    expect(buildFeatureOverride(draft, scope)).toEqual({
      featureKey: 'QQBOT_REALTIME_MESSAGE_ENABLED',
      enabled: true,
      scopeKind: 'group',
      scopeId: '123456',
    });
    expect(hasFeatureOverride([buildFeatureOverride(draft, scope)], draft, scope)).toBe(true);
  });

  it('requires both tool and scope before creating a tool override', () => {
    const draft = createToolOverrideDraft();
    const scope = { scopeKind: 'global_default', scopeId: 'global' };

    expect(draft).not.toHaveProperty('scopeKind');
    expect(draft).not.toHaveProperty('scopeId');
    expect(canAddToolOverride(draft, scope)).toBe(false);
    expect(() => buildToolOverride(draft, scope))
      .toThrow('添加工具覆盖前必须选择工具');

    draft.toolName = 'web_run';
    expect(canAddToolOverride(draft, null)).toBe(false);
    expect(() => buildToolOverride(draft, null))
      .toThrow('添加工具覆盖前必须选择范围');

    expect(canAddToolOverride(draft, scope)).toBe(true);
    expect(buildToolOverride(draft, scope)).toEqual({
      toolName: 'web_run',
      routeProfile: 'agent',
      enabled: true,
      scopeKind: 'global_default',
      scopeId: 'global',
    });
    expect(hasToolOverride([buildToolOverride(draft, scope)], draft, scope)).toBe(true);
    expect(hasToolOverride(
      [buildToolOverride(draft, scope)],
      { ...draft, routeProfile: 'automation' },
      scope,
    )).toBe(false);
  });
});
