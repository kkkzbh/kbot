import { z } from 'zod';

export const secondClassEnvelopeSchema = z.object({
  code: z.coerce.number(),
  msg: z.unknown().optional(),
  message: z.unknown().optional(),
  data: z.unknown().optional(),
}).passthrough();

export const secondClassCaptchaDataSchema = z.object({
  uuid: z.string().min(1),
  img: z.string().min(1),
}).passthrough();

export const secondClassSm2KeyDataSchema = z.object({
  publicKeyQ: z.string().min(1),
}).passthrough();

export const secondClassTokenDataSchema = z.object({
  token: z.string().min(1),
}).passthrough();
