import { describe, expect, it, vi } from 'vitest';

vi.mock('koishi', () => {
  type MockSchemaNode = {
    default: () => MockSchemaNode;
    description: () => MockSchemaNode;
    role: () => MockSchemaNode;
  };

  const createSchemaNode = (): MockSchemaNode => ({
    default: () => createSchemaNode(),
    description: () => createSchemaNode(),
    role: () => createSchemaNode(),
  });

  class MockLogger {
    info(): void {}
    warn(): void {}
    debug(): void {}
  }

  return {
    Context: class {},
    Logger: MockLogger,
    Schema: {
      object: () => createSchemaNode(),
      boolean: () => createSchemaNode(),
      string: () => createSchemaNode(),
    },
  };
});

vi.mock('koishi-plugin-pokemon-battle', () => ({}));

import {
  patchPokemonFontForRendering,
  resolveBundledFallbackFontPath,
  resolvePokemonFallbackFont,
} from '../src/plugins/pokemon-battle-bridge.js';

describe('pokemon battle bridge font fallback', () => {
  it('resolves bundled fallback font from repository asset', async () => {
    const fontPath = await resolveBundledFallbackFontPath();
    expect(fontPath).toContain('/src/plugins/assets/fonts/NotoSansCJKsc-Regular.otf');
  });

  it('prefers bundled fallback font over system probes', async () => {
    await expect(resolvePokemonFallbackFont()).resolves.toMatchObject({
      source: 'bundled',
    });
  });

  it('injects pokemon fallback family into zpix font declarations', () => {
    expect(patchPokemonFontForRendering('normal 16px zpix')).toContain('pokemon-fallback');
    expect(patchPokemonFontForRendering('normal 16px zpix, "pokemon-fallback"')).toBe(
      'normal 16px zpix, "pokemon-fallback"',
    );
  });
});
