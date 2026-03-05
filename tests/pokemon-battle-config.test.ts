import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('pokemon battle config in koishi.yml', () => {
  it('registers downloads and pokemon bridge plugins with env-based toggles', () => {
    const configPath = resolve(process.cwd(), 'koishi.yml');
    const content = readFileSync(configPath, 'utf8');

    expect(content).toContain('downloads:pokemon:');
    expect(content).toContain("output: ${{ env.POKEMON_DOWNLOADS_OUTPUT || './downloads' }}");

    expect(content).toContain('./dist/plugins/pokemon-battle-bridge:pokemon-battle:');
    expect(content).toContain("enabled: ${{ env.POKEMON_BATTLE_ENABLED !== 'false' }}");
    expect(content).toContain('imageSource: >-');
    expect(content).toContain('env.POKEMON_BATTLE_IMAGE_SOURCE');
    expect(content).toContain('https://raw.githubusercontent.com/MAIxxxIAM/pokemonFusionImage/main');
  });
});
