import { describe, expect, it } from 'vitest';
import {
  isMemoryDialogCancellation,
} from '../apps/admin-web/src/pages/memory-page-state.js';

describe('admin Memory V2 confirmation state', () => {
  it('treats only Element Plus dialog cancellation signals as a no-op', () => {
    expect(isMemoryDialogCancellation('cancel')).toBe(true);
    expect(isMemoryDialogCancellation('close')).toBe(true);
    expect(isMemoryDialogCancellation(new Error('cancel'))).toBe(false);
    expect(isMemoryDialogCancellation('network_error')).toBe(false);
  });
});
