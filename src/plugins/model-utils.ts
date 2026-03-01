export function resolvePlatform(model?: string): string | null {
  if (!model) return null;
  const value = model.trim();
  if (!value) return null;
  const index = value.indexOf('/');
  if (index <= 0) return null;
  return value.slice(0, index);
}
