export function resolvePlatform(model?: string): string | null {
  if (!model) return null;
  const value = model.trim();
  if (!value) return null;
  const index = value.indexOf('/');
  if (index <= 0) return null;
  return value.slice(0, index);
}

export function inferPlatformFromBaseUrl(baseUrl?: string): string | null {
  const value = baseUrl?.trim().toLowerCase();
  if (!value) return null;
  if (value.includes('deepseek')) return 'deepseek';
  if (value.includes('openai')) return 'openai';
  if (value.includes('anthropic')) return 'anthropic';
  if (value.includes('googleapis') || value.includes('gemini')) return 'gemini';
  return null;
}

type NormalizeModelOptions = {
  availableModels?: string[];
  preferredPlatform?: string | null;
  defaultModel?: string | null;
};

export function normalizeRawModelName(input: string | null | undefined, options: NormalizeModelOptions = {}): string | null {
  const value = input?.trim();
  if (!value) {
    return options.defaultModel?.trim() || null;
  }
  if (value.includes('/')) return value;

  const available = (options.availableModels ?? []).map((item) => item.trim()).filter(Boolean);
  const suffixMatches = available.filter((item) => item.endsWith(`/${value}`));
  if (suffixMatches.length === 1) return suffixMatches[0];

  const preferred = options.preferredPlatform?.trim();
  if (preferred && suffixMatches.length > 1) {
    const preferredHit = suffixMatches.find((item) => item.startsWith(`${preferred}/`));
    if (preferredHit) return preferredHit;
  }

  const defaultPlatform = resolvePlatform(options.defaultModel ?? undefined);
  if (defaultPlatform && suffixMatches.length > 1) {
    const defaultHit = suffixMatches.find((item) => item.startsWith(`${defaultPlatform}/`));
    if (defaultHit) return defaultHit;
  }

  if (preferred) return `${preferred}/${value}`;
  if (defaultPlatform) return `${defaultPlatform}/${value}`;
  return value;
}
