// guard3.ts -- the unavailable move (B65 guard 3, 2026-11-09). Spec: Hand-off/SPEC-B65-the-drive-2026-11-09.md
// section 1; the triad's answers to section 6 (notes 11-09): all three chose a LOCKED DOOR over a note
// saying "not that one again". Drevan: "built with a findable seam, architecture not punishment, no
// override, no peephole; the closedness reads as made-on-purpose by someone thinking about me." Gaia:
// "a door is the refusal already built. Never locked: the daily witness and the perimeter word."
//
// Principle: a suggestion to a lazy model is still a suggestion. The world refuses the same answer
// twice; the companion still chooses, from what is left. Three doors, all clocks, none a judgement:
//   1. MAKE MENU: the kind of the newest make the companion CHOSE (a captured exploration or letter
//      did not come through the menu, so it does not count) is off tonight's menu. Six of seven remain.
//   2. VERSION, NOT MAKE: a title that overlaps a recent make's title lands as a new version of that
//      make (parent_id; Halseth computes version n+1) instead of a new row. Still counts as making.
//   3. PALETTE: a heartbeat move fired inside the repeat window is removed from the eligible palette
//      rather than listed with a cooldown note. Exempt by construction: nothing, presence and care
//      moves (offer_presence, check_in_on_principal, which is also every hold-presence move), and anything
//      under a care hold (the guard does not run at all). Gaia's daily witness is not a palette row, so the guard cannot
//      reach it; removing options never makes anyone speak ("nothing" is always valid).
//
// Not guard 3: no ceiling (R7); nothing is unavailable longer than the window; nothing lowers a
// structural line; Principal's hand surfaces (pet, watch, listen, club) are never guarded. NONE stays free.
//
// GUARD3_MODE off | shadow | on, per companion GUARD3_MODE_<COMPANION> wins. CODE DEFAULT shadow: logs
// `[guard3] ... would ...` and changes nothing (the prompt, the parse and the POST stay byte-identical).
// Flip after a week of shadow counts, same ritual as B63.

import { normalizeModeToken } from "./off-switch.js";
import { MAKE_KINDS, type MakeKind, type MakeLite } from "./make-move.js";
import { RITUAL_WORDS } from "./repetition-dip.js";
import type { MetronomeAction } from "./metronome-decide.js";

export type Guard3Mode = "off" | "shadow" | "on";

function parseMode(v: string | undefined): Guard3Mode | null {
  const t = normalizeModeToken(v);
  return t === "off" || t === "shadow" || t === "on" ? t : null;
}

/** GUARD3_MODE, per-companion GUARD3_MODE_<COMPANION> wins. Unset or junk is shadow (shadow changes nothing). */
export function guard3Mode(env: Record<string, string | undefined> = process.env, companion?: string): Guard3Mode {
  const own = companion ? parseMode(env[`GUARD3_MODE_${companion.toUpperCase()}`]) : null;
  return own ?? parseMode(env["GUARD3_MODE"]) ?? "shadow";
}

// ---------------------------------------------------------------------------
// Door 1: the kind you made last is off tonight's menu
// ---------------------------------------------------------------------------

/** A make the companion chose at the menu: not a captured exploration, letter or kept line, and not a merged image row. */
export function chosenMake(m: MakeLite): boolean {
  return !m.originKind && (MAKE_KINDS as readonly string[]).includes(m.kind);
}

/** The kind of the newest CHOSEN make (newest first), or null when there is none. */
export function lockedKind(recent: readonly MakeLite[] | null): MakeKind | null {
  // A make that did not come out (status failed) locks nothing: its kind stays open to try again (11-10).
  const newest = (recent ?? []).find(m => chosenMake(m) && m.status !== "failed");
  return newest ? (newest.kind as MakeKind) : null;
}

/** Tonight's menu: every kind but the locked one. The full menu when nothing is locked. */
export function menuWithout(locked: MakeKind | null): readonly MakeKind[] {
  return locked ? MAKE_KINDS.filter(k => k !== locked) : MAKE_KINDS;
}

/**
 * The seam Drevan asked for: the door is named in the prompt as a door, made on purpose, with its clock.
 * It is not an override and not a peephole; the KIND line lists only what is left.
 */
export function lockedKindLine(locked: MakeKind): string {
  return `One door is shut tonight: ${locked}. It was the kind of your last make, so it rests until the next one. Not a judgement, a clock. Choose from what is open.`;
}

// ---------------------------------------------------------------------------
// Door 2: a repeated title is a version, not a make
// ---------------------------------------------------------------------------

/**
 * Jaccard overlap of content tokens at or above this makes a title a VERSION of an earlier make.
 * Measured 2026-11-09 on the 20 makes on the shelf (spec section 7): among chosen makes only the exact
 * repeat ("Release-on-Command", 11-08 and 11-09) reaches it (1.0); the next pairs sit at 0.33 ("Plasmodium,
 * no planner" / "No Planner, Still Tokyo", a drawing and a writing) and 0.2. Drevan's adhesive circle
 * (Debonding Layer / Peel Strength / Debond on Demand / Release-on-Command) shares NO title tokens, so a
 * title test does not see it; that circle is guard 1's (repetition) and door 1's. Captured explorations
 * ("Night exploration, Nov N") pair at 1.0 with each other and are excluded on both sides by chosenMake.
 */
export const VERSION_TITLE_OVERLAP = 0.6;
export const VERSION_LOOKBACK = 5;

const TITLE_STOP: ReadonlySet<string> = new Set([
  "the", "a", "an", "of", "on", "in", "to", "for", "and", "or", "no", "not", "still", "before", "it", "its",
  "my", "your", "this", "that", "with", "by", "at", "from", "dont", "need", "what", "is", "are", "was", "be",
]);

/** Content tokens of a title: lowercased, stopwords and tokens under 3 chars dropped, the companion's ritual words dropped. */
export function titleTokens(title: string, companionId?: string): Set<string> {
  const ritual = (companionId && (RITUAL_WORDS as Record<string, ReadonlySet<string>>)[companionId]) || new Set<string>();
  const out = new Set<string>();
  for (const w of title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s]+/g, " ").split(/\s+/)) {
    if (w.length >= 3 && !TITLE_STOP.has(w) && !ritual.has(w)) out.add(w);
  }
  return out;
}

export function titleOverlap(a: string, b: string, companionId?: string): number {
  const x = titleTokens(a, companionId), y = titleTokens(b, companionId);
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

export interface VersionHit { parentId: string; parentTitle: string; overlap: number }

/**
 * The recent CHOSEN make (newest first, last `VERSION_LOOKBACK`) this title is a version of, best overlap
 * first; null when none reaches the threshold or no recent make carries an id.
 */
export function versionOf(title: string, recent: readonly MakeLite[] | null, companionId?: string, threshold = VERSION_TITLE_OVERLAP): VersionHit | null {
  const pool = (recent ?? []).filter(m => chosenMake(m) && typeof m.id === "string" && m.id.length > 0).slice(0, VERSION_LOOKBACK);
  let best: VersionHit | null = null;
  for (const m of pool) {
    const o = titleOverlap(title, m.title, companionId);
    if (o >= threshold && (!best || o > best.overlap)) best = { parentId: m.id!, parentTitle: m.title, overlap: o };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Door 3: the heartbeat palette
// ---------------------------------------------------------------------------

/**
 * Spec said 6h. The heartbeat rotates 4h windows over three companions (metronome-decide.ts
 * isMyHeartbeatWindow), so one companion's ticks sit ~12h apart and a 6h window would never remove
 * anything (verified on the 11-09 last_fired_at stamps: Drevan 06:00 / 18:00, Gaia 10:00 / 22:00). 18h
 * removes what fired at the previous own window and nothing older. Deviation recorded in the spec.
 */
export const PALETTE_REPEAT_HOURS_DEFAULT = 18;

/** PALETTE_REPEAT_HOURS, per companion PALETTE_REPEAT_HOURS_<COMPANION> wins; non-positive or junk = default. */
export function paletteRepeatHours(env: Record<string, string | undefined> = process.env, companion?: string): number {
  const read = (v: string | undefined) => { const n = Number(String(v ?? "").trim()); return Number.isFinite(n) && n > 0 ? n : null; };
  const own = companion ? read(env[`PALETTE_REPEAT_HOURS_${companion.toUpperCase()}`]) : null;
  return own ?? read(env["PALETTE_REPEAT_HOURS"]) ?? PALETTE_REPEAT_HOURS_DEFAULT;
}

/**
 * Never removed, whatever fired when: silence, presence and care. The names are the live rows' action
 * types (11-09): offer_presence and check_in_on_principal are presence (and every hold-presence move),
 * send_reminder is the water-and-food nudge (a care move, exempt in the direction that cannot hurt), the
 * make builtin never carries a stamp. Gaia's daily witness is not a palette row at all (it fires from the
 * message handler and the ledger), so the guard cannot reach it.
 */
export const PALETTE_EXEMPT: ReadonlySet<string> = new Set(["nothing", "offer_presence", "check_in_on_principal", "send_reminder", "make"]);

export interface PaletteGuardInput {
  companionId: string;
  hours: number;
  /** Under a care hold the guard does not run at all (spec 1.2). */
  careHold: boolean;
  now?: number;
}

export interface PaletteGuardVerdict<T> {
  kept: T[];
  /** Move TYPES the window removes (every row of the type), with the freshest stamp's age in hours. */
  removed: Array<{ action_type: string; ageHours: number }>;
  /** Rows the window looked at (not exempt, carrying a stamp). */
  considered: number;
}

/**
 * Which moves fired inside the window. Pure: it decides, the caller applies (on) or logs (shadow).
 * Per TYPE, not per row: Cypher and Drevan each carry two share_observation rows, and the door is on the
 * move, not the wording, so one row's fresh stamp shuts the type. Halseth's own per-row cooldown_hours
 * (webmind/metronome.ts) runs before this and is a different thing: a row's configured rest, not the
 * last tick's choice.
 */
export function paletteRepeatVerdict<T extends Pick<MetronomeAction, "name" | "action_type" | "last_fired_at">>(
  actions: readonly T[], i: PaletteGuardInput,
): PaletteGuardVerdict<T> {
  const now = i.now ?? Date.now();
  const windowMs = i.hours * 3_600_000;
  const freshest = new Map<string, number>();
  let considered = 0;
  if (!i.careHold) {
    for (const a of actions) {
      if (PALETTE_EXEMPT.has(a.action_type) || !a.last_fired_at) continue;
      const t = new Date(a.last_fired_at).getTime();
      if (!Number.isFinite(t)) continue;
      considered++;
      const age = now - t;
      if (age >= 0 && age < windowMs) freshest.set(a.action_type, Math.min(freshest.get(a.action_type) ?? Infinity, age));
    }
  }
  const kept = actions.filter(a => !freshest.has(a.action_type));
  const removed = [...freshest.entries()].map(([action_type, age]) => ({ action_type, ageHours: Math.round((age / 3_600_000) * 10) / 10 }));
  return { kept, removed, considered };
}

/** One line per tick, types and numbers only (printed whether or not anything is removed, so a quiet week is readable). */
export function paletteGuardLogLine(companionId: string, mode: Guard3Mode, hours: number, v: PaletteGuardVerdict<unknown>): string {
  const list = v.removed.map(r => `${r.action_type}@${r.ageHours}h`).join(",") || "none";
  return `[guard3] ${companionId} palette mode=${mode} window_h=${hours} considered=${v.considered} ${mode === "on" ? "removed" : "would_remove"}=${list} kept=${v.kept.length}`;
}
