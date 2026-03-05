const POKEMON_KEYWORD_PREFIXES = [
  '宝可梦签到',
  '捕捉宝可梦',
  '杂交宝可梦',
  '查看信息',
  '属性',
  '放生',
  '对战',
  '技能扭蛋机',
  '技能背包',
  '装备技能',
  '查看图鉴',
  '接收宝可梦',
  '接收',
  '图鉴检查',
  'notice',
];

export function resolvePokemonCommandRoute(rawContent: string): string | null {
  const normalized = rawContent.replace(/^[/／]+/, '').trim();
  if (!normalized) return null;

  if (normalized === '宝可梦' || normalized.startsWith('宝可梦 ')) {
    return normalized;
  }

  for (const keyword of POKEMON_KEYWORD_PREFIXES) {
    if (normalized === keyword || normalized.startsWith(`${keyword} `)) {
      return `宝可梦 ${normalized}`;
    }
  }

  return null;
}
