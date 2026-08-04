export const QQBOT_SUBMIT_REPLY_TOOL_NAME = 'qqbot_submit_reply';

export const QQBOT_INTERNAL_TOOL_NAMES = new Set<string>([
  QQBOT_SUBMIT_REPLY_TOOL_NAME,
]);

export function isQqbotInternalToolName(toolName: string): boolean {
  return QQBOT_INTERNAL_TOOL_NAMES.has(toolName.trim());
}
