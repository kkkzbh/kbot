import type { StructuredReply } from '../pipeline/types.js';
import type { ModalityPolicySnapshot } from './director.js';

export type ExplicitReplyModality = 'voice' | 'sticker';

export type ExplicitModalityPolicy = Pick<
  ModalityPolicySnapshot,
  'voiceReason' | 'stickerReason'
>;

export type ExplicitModalityInvariantStage =
  | 'orchestration'
  | 'delivery';

export type ExplicitModalityInvariantEvidence =
  | {
      stage: 'orchestration';
      reply: StructuredReply | null;
    }
  | {
      stage: 'delivery';
      deliveredModalities: readonly ExplicitReplyModality[];
    };

export type ExplicitModalityInvariantFailureCode =
  | 'explicit_modality_no_reply'
  | 'explicit_modality_action_missing'
  | 'explicit_modality_delivery_missing';

function requestedModalities(policy: ExplicitModalityPolicy): ExplicitReplyModality[] {
  const required: ExplicitReplyModality[] = [];
  if (policy.voiceReason === 'explicit_request') required.push('voice');
  if (policy.stickerReason === 'explicit_request') required.push('sticker');
  return required;
}

function modalityLabel(modality: ExplicitReplyModality): string {
  return modality === 'voice' ? 'voice' : 'sticker';
}

function formatRequestedModalities(modalities: readonly ExplicitReplyModality[]): string {
  return modalities.map(modalityLabel).join(' and ');
}

function formatExplicitRequestObject(modalities: readonly ExplicitReplyModality[]): string {
  return modalities.map((modality) => modality === 'voice' ? 'voice' : 'a sticker').join(' and ');
}

function resolveAvailableModalities(
  evidence: ExplicitModalityInvariantEvidence,
): Set<ExplicitReplyModality> {
  if (evidence.stage === 'orchestration') {
    return new Set(
      (evidence.reply?.outbound_messages ?? []).flatMap((message) => {
        if (message.type === 'voice') return ['voice' as const];
        if (message.type === 'meme') return ['sticker' as const];
        return [];
      }),
    );
  }
  return new Set(evidence.deliveredModalities);
}

function failureCode(
  evidence: ExplicitModalityInvariantEvidence,
): ExplicitModalityInvariantFailureCode {
  if (evidence.stage === 'orchestration' && evidence.reply?.decision !== 'reply') {
    return 'explicit_modality_no_reply';
  }
  if (evidence.stage === 'delivery') return 'explicit_modality_delivery_missing';
  return 'explicit_modality_action_missing';
}

function failureMessage(
  code: ExplicitModalityInvariantFailureCode,
  modalities: readonly ExplicitReplyModality[],
): string {
  const requested = formatRequestedModalities(modalities);
  const requestObject = formatExplicitRequestObject(modalities);
  if (code === 'explicit_modality_no_reply') {
    return `the user explicitly requested ${requestObject}; no_reply is not permitted.`;
  }
  if (code === 'explicit_modality_delivery_missing') {
    return `explicit ${requested} request failed because no ${requested} was delivered.`;
  }
  return `the user explicitly requested ${requestObject}; the reply requires ${requested} output.`;
}

export class ExplicitModalityInvariantError extends Error {
  readonly code: ExplicitModalityInvariantFailureCode;
  readonly stage: ExplicitModalityInvariantStage;
  readonly missingModalities: readonly ExplicitReplyModality[];

  constructor(args: {
    code: ExplicitModalityInvariantFailureCode;
    stage: ExplicitModalityInvariantStage;
    missingModalities: readonly ExplicitReplyModality[];
  }) {
    super(failureMessage(args.code, args.missingModalities));
    this.name = 'ExplicitModalityInvariantError';
    this.code = args.code;
    this.stage = args.stage;
    this.missingModalities = [...args.missingModalities];
  }
}

export function assertExplicitModalityInvariant(
  policy: ExplicitModalityPolicy | null,
  evidence: ExplicitModalityInvariantEvidence,
): void {
  if (!policy) return;
  const required = requestedModalities(policy);
  if (!required.length) return;

  const available = resolveAvailableModalities(evidence);
  const missing = required.filter((modality) => !available.has(modality));
  if (!missing.length) return;

  throw new ExplicitModalityInvariantError({
    code: failureCode(evidence),
    stage: evidence.stage,
    missingModalities: missing,
  });
}
