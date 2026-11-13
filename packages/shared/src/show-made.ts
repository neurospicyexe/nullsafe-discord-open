// show-made.ts -- the `show_made` move, given something real to show (2026-11-11, GAP-MAP section C).
//
// Why it never fired: the row sat in every palette for all three companions with no condition, but the decision
// picker had nothing behind it. "show him something you made" with no make named is a move with no object (the
// picker is offered it beside moves that have one and chooses those), and the executor's prompt did not name a
// make either, so even a pick would have composed a line about nothing. Now:
//   - the palette offers show_made ONLY while the companion has a make worth showing, and the offer NAMES it
//     ("Fixture, a drawing, made yesterday"); with no make it is removed, as an honest "nothing to show";
//   - the executor prompt carries the same make, so the line is about that thing;
//   - a make is shown ONCE (Redis claim at send), and the send records the make id on the reach ledger so a
//     reply from Principal reaches Halseth as `[replied]` and the maker's next orient reads "Principal replied".
//
// A make is showable when it is READY, nobody has met it (heard_back empty: Hearth's "seen" signal and the
// maker's own line both fill it), it is not a captured letter to him (he has that already), it is at least
// MIN_AGE_MS old (a rendered file has landed) and no older than MAX_AGE_DAYS (a stale make is not news), and it
// has not been shown. Pure functions here; the heartbeat wires them.

import type { MakeLite } from "./make-move.js";

export const SHOW_MADE_MIN_AGE_MS = 20 * 60_000;
export const SHOW_MADE_MAX_AGE_DAYS = 7;
export const SHOWN_KEY = (makeId: string): string => `ns:showmade:${makeId}`;
export const SHOWN_TTL_S = 30 * 24 * 3600;

export type ShowMadeMode = "off" | "on";
/** SHOW_MADE: default ON; `off`/`0`/`false`/`no` (trimmed, any case) removes the move from the palette entirely. */
export function showMadeMode(env: NodeJS.ProcessEnv = process.env): ShowMadeMode {
  const v = String(env["SHOW_MADE"] ?? "").trim().toLowerCase();
  return v === "off" || v === "0" || v === "false" || v === "no" ? "off" : "on";
}

function parseTs(ts: string): number {
  if (!ts) return NaN;
  const s = ts.includes("T") ? ts : ts.replace(" ", "T");
  return Date.parse(/(?:Z|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s}Z`);
}

/** The newest make worth showing, or null. `shown` = ids already shown (the caller reads Redis). */
export function pickShowableMake(makes: readonly MakeLite[] | null, shown: ReadonlySet<string>, nowMs: number = Date.now()): MakeLite | null {
  if (!makes) return null;
  const sorted = [...makes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const m of sorted) {
    if (!m.id || shown.has(m.id)) continue;
    if ((m.status ?? "ready") !== "ready") continue;
    if (m.heardBack && m.heardBack.trim()) continue;
    if (m.originKind === "letter") continue;
    const t = parseTs(m.createdAt);
    if (!Number.isFinite(t)) continue;
    const age = nowMs - t;
    if (age < SHOW_MADE_MIN_AGE_MS || age > SHOW_MADE_MAX_AGE_DAYS * 86_400_000) continue;
    return m;
  }
  return null;
}

export function ageWords(createdAt: string, nowMs: number = Date.now()): string {
  const t = parseTs(createdAt);
  if (!Number.isFinite(t)) return "recently";
  const h = (nowMs - t) / 3_600_000;
  if (h < 20) return "today";
  const d = Math.floor(h / 24);
  return d <= 1 ? "yesterday" : `${d} days ago`;
}

/** The palette description, so the picker is choosing between real things. */
export function showMadeOffer(m: MakeLite, nowMs: number = Date.now()): string {
  return `show him one thing you made: "${m.title}" (${m.kind}, made ${ageWords(m.createdAt, nowMs)}); he has not seen it yet`;
}

/** The generation prompt for the send. Names the make; asks nothing of him. */
export function showMadePrompt(m: MakeLite, nowMs: number = Date.now()): string {
  return `Show him this one thing you made: "${m.title}" (${m.kind}, made ${ageWords(m.createdAt, nowMs)}).`
    + (m.interestName ? ` It came out of ${m.interestName}.` : "")
    + ` Say what it is and why you think it is good, in your own voice. He can find it on the Hearth shelf; do not paste its contents, do not give him a link you do not have, and ask nothing of him.`;
}

export interface HalsethHttpLite { url: string; secret: string; fetchFn?: typeof fetch }

/** Tell Halseth Principal answered the DM where this make was shown. Best effort; never throws. */
export async function signalMakeReplied(h: HalsethHttpLite, makeId: string): Promise<boolean> {
  try {
    const res = await (h.fetchFn ?? fetch)(`${h.url.replace(/\/$/, "")}/mind/makes/${encodeURIComponent(makeId)}/reception`, {
      method: "POST",
      headers: { Authorization: `Bearer ${h.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ signal: "replied", via: "discord" }),
      signal: AbortSignal.timeout(8_000),
    });
    return res.ok;
  } catch { return false; }
}
