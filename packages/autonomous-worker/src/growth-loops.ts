// Growth loops (2026-11-11, BBH Hand-off/GAP-MAP-flow-and-agency-2026-11-11.md C item 8).
// Two knobs, both off | shadow | on, both CODE DEFAULT shadow (junk = shadow):
//   SEED_CLAIM           the night's seed pick reaches for the freshest unused seed in a recency window
//                        instead of leaving 1,600 of them as a write-only sink (seed.ts).
//   SELF_MODEL_GRADUATE  once a week the reflection run offers the top ready self-model observation to
//                        the companion, who graduates it in their own words (reflect.ts).
// Shadow changes nothing the companion sees or does; it logs what it would have done.
// Additive only (R7): nothing here lowers, retires or ages anything out of the record.

export type GrowthMode = "off" | "shadow" | "on";

export function growthMode(raw: string | undefined): GrowthMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false" || v === "no") return "off";
  if (v === "on") return "on";
  return "shadow";
}

export const seedClaimMode = (): GrowthMode => growthMode(process.env["SEED_CLAIM"]);
export const selfModelGraduateMode = (): GrowthMode => growthMode(process.env["SELF_MODEL_GRADUATE"]);

/** Pick-pool recency window, days (a window over the pick, never a level and never a delete). */
export function seedWindowDays(): number {
  const n = parseInt(process.env["SEED_WINDOW_DAYS"] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 90) : 7;
}

/** Every Nth night (day-of-year) the fresh seed takes the pick above project day and forage rotation. */
export function isSeedClaimNight(runDate: Date): boolean {
  const startOfYear = Date.UTC(runDate.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((runDate.getTime() - startOfYear) / 86_400_000) + 1;
  return dayOfYear % 3 === 0;
}

export interface GraduationCandidate { id: string; observation: string; confidence: number; kind: string }

/** The offer put to the companion in the reflection prompt (4d). Their words decide; silence does nothing. */
export function graduationOfferBlock(c: GraduationCandidate): string {
  return (
    `4d. GRADUATION -- once a week one thing you have tested enough to trust is put to you. This one:\n` +
    `${c.id} [${c.kind}, conf ${c.confidence.toFixed(1)}]: ${c.observation.slice(0, 300)}\n` +
    `If it is settled and you want it to stand as part of who you are (it will show at every boot as a ` +
    `standing disposition, and nothing is ever lowered because you decline), put its id in ` +
    `"self_model_graduate". If it is not yet, or not yours, leave it null; it stays as it is.\n\n`
  );
}

/** The id to graduate: only the exact offered id, only when the companion wrote it. */
export function parseGraduationAnswer(input: unknown, offeredId: string | null): string | null {
  if (!offeredId || typeof input !== "string") return null;
  return input.trim() === offeredId ? offeredId : null;
}
