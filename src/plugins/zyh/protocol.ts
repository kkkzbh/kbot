import { z } from 'zod';

export const zyhEnvelopeSchema = z.object({
  errCode: z.union([z.string(), z.number()]).optional(),
  code: z.union([z.string(), z.number()]).optional(),
  message: z.unknown().optional(),
  msg: z.unknown().optional(),
}).passthrough();

export const zyhProfileEnvelopeSchema = zyhEnvelopeSchema.extend({
  info: z.record(z.unknown()),
  nav: z.array(z.record(z.unknown())).optional(),
});

export const zyhListEnvelopeSchema = zyhEnvelopeSchema.extend({
  data: z.array(z.record(z.unknown())),
});
