'use strict'

const INTERNAL_METADATA_TOKENS = Object.freeze([
  'ReplyPlan',
  '<qqbot-',
  '系统提示词',
  '内部回复协议',
  'WorkingState',
  'submit_working_state',
  'qqbot_reply_plan_executor',
  'protocol violation',
  'qqbot_submit_reply',
  'CHAT_REPLY_V1',
  'AgentTerminalContractError',
  'terminal contract',
  'terminal tool',
  'terminalTool',
  'qqbot_final_response_contract',
  'qqbot_final_response_instruction',
  'lc_direct_tool_output',
  'qqbot-internal',
])

function findInternalMetadataLeak(value) {
  const text = String(value ?? '')
  const normalized = text.toLocaleLowerCase('en-US')
  return INTERNAL_METADATA_TOKENS.find(
    (token) => normalized.includes(token.toLocaleLowerCase('en-US')),
  ) ?? null
}

module.exports = {
  INTERNAL_METADATA_TOKENS,
  findInternalMetadataLeak,
}
