import { z } from "zod";

const viatorDurationSchema = z.object({
  fixedDurationInMinutes: z.number().int().nonnegative().optional(),
  variableDurationFromMinutes: z.number().int().nonnegative().optional(),
  variableDurationToMinutes: z.number().int().nonnegative().optional(),
}).strict();

const viatorKeyAttributesSchema = z.object({
  features: z.array(z.string()),
  mainCategory: z.string().trim().min(1),
}).strict();

export const viatorExperienceSchema = z.object({
  title: z.string().trim().min(1).max(512),
  code: z.string().trim().min(1).max(128),
  thumbnail: z.string().url().max(2048),
  rating: z.number().min(0).max(5).optional(),
  reviewCount: z.number().int().nonnegative().optional(),
  freeCancellation: z.boolean(),
  // The official MCP response does not state a currency. It is validated so
  // schema drift is detected, then deliberately omitted from normalized data.
  fromPrice: z.number().nonnegative(),
  fromPriceBeforeDiscount: z.number().nonnegative().optional(),
  clickOffToLander: z.string().url().max(4096),
  duration: viatorDurationSchema.optional(),
  keyAttributes: viatorKeyAttributesSchema.optional(),
}).strict();

export const viatorSearchStructuredContentSchema = z.object({
  sessionId: z.string().uuid(),
  experiences: z.array(viatorExperienceSchema).max(20),
}).strict();

const jsonRpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
}).passthrough();

export const viatorMcpResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.object({
    content: z.array(z.object({
      type: z.string(),
      text: z.string().optional(),
    }).passthrough()).optional(),
    isError: z.boolean().optional(),
    structuredContent: z.unknown().optional(),
  }).passthrough().optional(),
  error: jsonRpcErrorSchema.optional(),
}).passthrough().superRefine((value, ctx) => {
  if (!value.result && !value.error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "JSON-RPC response has neither result nor error" });
  }
});
