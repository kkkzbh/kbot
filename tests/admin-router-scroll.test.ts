import { describe, expect, it } from 'vitest';
import { resolveAdminScroll } from '../apps/admin-web/src/router-scroll';

describe('admin router scroll behavior', () => {
  it('preserves the viewport when a control only changes the current page query', () => {
    expect(resolveAdminScroll(
      { path: '/', hash: '' },
      { path: '/', hash: '' },
      null,
    )).toBe(false);
  });

  it('keeps history restoration and explicit anchors authoritative', () => {
    expect(resolveAdminScroll(
      { path: '/', hash: '' },
      { path: '/intelligence/models', hash: '' },
      { left: 0, top: 640 },
    )).toEqual({ left: 0, top: 640 });

    expect(resolveAdminScroll(
      { path: '/', hash: '#events' },
      { path: '/', hash: '' },
      null,
    )).toEqual({
      el: '#events',
      top: 72,
      behavior: 'smooth',
    });
  });

  it('starts a different page at the top', () => {
    expect(resolveAdminScroll(
      { path: '/intelligence/models', hash: '' },
      { path: '/', hash: '' },
      null,
    )).toEqual({ top: 0 });
  });
});
