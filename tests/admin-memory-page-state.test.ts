import { describe, expect, it } from 'vitest';
import {
  resolveVisibleUserSelection,
} from '../apps/admin-web/src/pages/memory-page-state.js';

describe('admin memory page user selection', () => {
  it('keeps the selection aligned with the visible user page', () => {
    const users = [
      { userKey: 'onebot:user:2' },
      { userKey: 'onebot:user:3' },
    ];

    expect(resolveVisibleUserSelection(users, 'onebot:user:2')).toBe('onebot:user:2');
    expect(resolveVisibleUserSelection(users, 'onebot:user:1')).toBe('onebot:user:2');
    expect(resolveVisibleUserSelection([], 'onebot:user:1')).toBe('');
  });
});
