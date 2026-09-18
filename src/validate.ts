import { z } from "zod";

/**
 * Zod schemas for /funding input validation (plan §8 validation matrix).
 * Unknown venue_id / bad symbol / oversized body -> validation error entries, not 500.
 */
export const FundingBodySchema = z.object({
  venue_ids: z.array(z.string()).max(10).optional(),
  markets: z
    .array(z.string().regex(/^[A-Za-z0-9\-_:]{1,32}$/, "bad symbol"))
    .max(50)
    .optional(),
});

export type FundingBody = z.infer<typeof FundingBodySchema>;

export function parseBody(raw: unknown): { ok: true; body: FundingBody } | { ok: false; error: string } {
  const r = FundingBodySchema.safeParse(raw);
  if (r.success) return { ok: true, body: r.data };
  return { ok: false, error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
}
