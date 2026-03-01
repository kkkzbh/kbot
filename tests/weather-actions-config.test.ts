import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('weather actions config in koishi.yml', () => {
  it('enables actions and includes weather geo/forecast action specs', () => {
    const configPath = resolve(process.cwd(), 'koishi.yml');
    const content = readFileSync(configPath, 'utf8');

    expect(content).toContain("actions: ${{ env.CHATLUNA_COMMON_ACTIONS === 'true' }}");

    expect(content).toContain('name: weather.geo');
    expect(content).toContain('title: Open-Meteo Geocoding API');
    expect(content).toContain('/v1/search:');
    expect(content).toContain('name: name');

    expect(content).toContain('name: weather.forecast');
    expect(content).toContain('title: Open-Meteo Forecast API');
    expect(content).toContain('/v1/forecast:');
    expect(content).toContain('name: latitude');
    expect(content).toContain('name: longitude');
    expect(content).toContain('name: forecast_days');
    expect(content).toContain('name: timezone');
  });
});
