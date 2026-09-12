/**
 * Route-layer review submission enforcement; C5-S1 procedure guards provide
 * the second layer (D-C5-2). Reviews are web-only, so no Pydantic parity applies.
 */

import { z } from "zod";

export const ReviewSubmissionSchema = z.strictObject({
  score: z.number().int().min(1).max(5),
  aroma: z.number().int().min(0).max(100).nullable().optional(),
  acidity: z.number().int().min(0).max(100).nullable().optional(),
  sweetness: z.number().int().min(0).max(100).nullable().optional(),
  body: z.number().int().min(0).max(100).nullable().optional(),
  aftertaste: z.number().int().min(0).max(100).nullable().optional(),
  reviewerName: z.string().max(80).optional(),
  notes: z.string().max(2000).optional(),
  brewMethod: z.string().max(40).optional(),
  website: z.literal("").optional(),
});

export type ReviewSubmission = z.infer<typeof ReviewSubmissionSchema>;
