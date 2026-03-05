import { describe, expect, it } from 'vitest';
import { resolvePokemonCommandRoute } from '../src/plugins/pokemon-battle-route.js';

describe('pokemon battle bridge command routing', () => {
  it('routes root pokemon command', () => {
    expect(resolvePokemonCommandRoute('宝可梦')).toBe('宝可梦');
    expect(resolvePokemonCommandRoute('/宝可梦')).toBe('宝可梦');
    expect(resolvePokemonCommandRoute('宝可梦 宝可梦签到')).toBe('宝可梦 宝可梦签到');
  });

  it('routes pokemon keyword commands to pokemon namespace', () => {
    expect(resolvePokemonCommandRoute('宝可梦签到')).toBe('宝可梦 宝可梦签到');
    expect(resolvePokemonCommandRoute('捕捉宝可梦')).toBe('宝可梦 捕捉宝可梦');
    expect(resolvePokemonCommandRoute('对战 @张三')).toBe('宝可梦 对战 @张三');
    expect(resolvePokemonCommandRoute('装备技能 十万伏特')).toBe('宝可梦 装备技能 十万伏特');
  });

  it('does not hijack normal conversation text', () => {
    expect(resolvePokemonCommandRoute('我不太懂这个呢')).toBeNull();
    expect(resolvePokemonCommandRoute('宝可梦啊')).toBeNull();
    expect(resolvePokemonCommandRoute('今天要不要玩点别的')).toBeNull();
  });
});
