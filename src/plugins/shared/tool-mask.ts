import type { ToolMask } from '../../types/tool-policy.js';

export function createAllowToolMask(allowedTools: readonly string[]): ToolMask {
  const allow = [...allowedTools];
  return {
    mode: 'allow',
    allow,
    deny: [],
    toolCallMask: {
      mode: 'allow',
      allow: [...allow],
      deny: [],
    },
  };
}
