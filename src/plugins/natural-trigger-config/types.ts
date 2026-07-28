import { z } from 'zod';

export const NATURAL_TRIGGER_CONFIG_SCHEMA_VERSION = 1 as const;

const canonicalGroupIdSchema = z.string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^:\s,]+$/, 'must be a canonical group id without a scope prefix');

const aliasSchema = z.string().trim().min(1).max(80);

function addDuplicateIssues(
  values: readonly string[],
  path: (string | number)[],
  context: z.RefinementCtx,
  normalize: (value: string) => string,
): void {
  const seen = new Map<string, number>();
  for (const [index, value] of values.entries()) {
    const identity = normalize(value);
    const previous = seen.get(identity);
    if (previous !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index],
        message: `duplicate value also used at index ${previous}`,
      });
      continue;
    }
    seen.set(identity, index);
  }
}

const naturalTriggerConfigObjectSchema = z.object({
  enabled: z.boolean(),
  allowedGroupIds: z.array(canonicalGroupIdSchema).max(500),
  voiceAdmission: z.object({
    enabled: z.boolean(),
  }).strict(),
  mechanisms: z.object({
    quote: z.object({
      enabled: z.boolean(),
    }).strict(),
    alias: z.object({
      enabled: z.boolean(),
      aliases: z.array(aliasSchema).max(100),
    }).strict(),
    heuristic: z.object({
      enabled: z.boolean(),
    }).strict(),
    focus: z.object({
      enabled: z.boolean(),
      windowMs: z.number().int().nonnegative().max(86_400_000),
    }).strict(),
    random: z.object({
      enabled: z.boolean(),
      probability: z.number().min(0).max(1),
    }).strict(),
  }).strict(),
  modelDecision: z.object({
    minConfidence: z.number().min(0).max(1),
  }).strict(),
  pacing: z.object({
    minReplyIntervalMs: z.number().int().nonnegative().max(3_600_000),
  }).strict(),
  antiSpam: z.object({
    enabled: z.boolean(),
    windowMs: z.number().int().positive().max(3_600_000),
    threshold: z.number().int().positive().max(10_000),
    muteMs: z.number().int().nonnegative().max(86_400_000),
  }).strict(),
}).strict();

export const naturalTriggerConfigSchema = naturalTriggerConfigObjectSchema.superRefine(
  (config, context) => {
    addDuplicateIssues(
      config.allowedGroupIds,
      ['allowedGroupIds'],
      context,
      (value) => value,
    );
    addDuplicateIssues(
      config.mechanisms.alias.aliases,
      ['mechanisms', 'alias', 'aliases'],
      context,
      (value) => value.toLocaleLowerCase(),
    );
  },
);
export type NaturalTriggerConfig = z.infer<typeof naturalTriggerConfigSchema>;

export const naturalTriggerConfigDocumentSchema = z.object({
  schemaVersion: z.literal(NATURAL_TRIGGER_CONFIG_SCHEMA_VERSION),
  savedRevision: z.number().int().positive(),
  appliedRevision: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
  config: naturalTriggerConfigSchema,
}).strict().superRefine((document, context) => {
  if (document.appliedRevision > document.savedRevision) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['appliedRevision'],
      message: 'appliedRevision cannot exceed savedRevision',
    });
  }
});
export type NaturalTriggerConfigDocument = z.infer<typeof naturalTriggerConfigDocumentSchema>;

export const naturalTriggerConfigPutSchema = z.object({
  expectedRevision: z.number().int().positive(),
  config: naturalTriggerConfigSchema,
}).strict();
export type NaturalTriggerConfigPutInput = z.infer<typeof naturalTriggerConfigPutSchema>;

export interface NaturalTriggerRuntimeSnapshot {
  revision: number;
  config: NaturalTriggerConfig;
  allowedGroupIds: ReadonlySet<string>;
}

export interface NaturalTriggerConfigState {
  schemaVersion: typeof NATURAL_TRIGGER_CONFIG_SCHEMA_VERSION;
  savedRevision: number;
  appliedRevision: number;
  pending: boolean;
  updatedAt: string;
  config: NaturalTriggerConfig;
}
