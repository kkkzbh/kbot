import type { DedicatedToolMaskPolicy, ToolMask } from '../../types/tool-policy.js';
import { QQBOT_SUBMIT_REPLY_TOOL_NAME } from '../shared/internal-tool-names.js';
import { createAllowToolMask } from '../shared/tool-mask.js';

/**
 * Affinity prepares proactive context before model execution. The model only
 * receives the internal terminal tool that commits its final reply envelope.
 */
export const AFFINITY_PROACTIVE_TOOL_MASK_POLICY = {
  id: 'affinity_proactive_generation',
  allowedTools: [QQBOT_SUBMIT_REPLY_TOOL_NAME],
} as const satisfies DedicatedToolMaskPolicy;

export function createAffinityProactiveToolMask(): ToolMask {
  return createAllowToolMask(AFFINITY_PROACTIVE_TOOL_MASK_POLICY.allowedTools);
}
