// packages/shared/src/need-sort.ts -- B65 step 7, the palette sorted by the loudest need
// (BBH Hand-off/SPEC-B65-the-drive-2026-11-09.md 2.2; Pino's "loudest" list).
//
// Each metronome move declares which need it serves (Halseth `metronome_actions.serves`, mig 0182, per row;
// NULL reads as the type's default). The heartbeat palette offered on a tick is ORDERED by the companion's loudest
// need (effective drive level over its own threshold). The companion still picks; this changes only the order the
// list is shown in, never what is on it.
//
// HARD LINES:
//   - Reach-out is untouched. Moves that serve `relational` or `none` (every presence, check-in, flirt/dare, DM and
//     care move, the reminder) are PINNED to their original slots: only moves serving rest / novelty / expression
//     are re-ordered, and only among the slots those moves already held. Need pacing never moves a reach-class move
//     earlier, never removes one, and REACH_DM / REACH_BACKOFF / the reach cap are not read or written here.
//   - Reads drive levels and the palette only. No care or health table, no Principal text.
//   - Gaia: her `expression_need` rises only from a marked want (Halseth), so an unmarked Gaia ranks expression last.
//
// PALETTE_NEED_SORT off | shadow | on, per companion PALETTE_NEED_SORT_<COMPANION> wins. CODE DEFAULT shadow: logs
// `[need-sort] ... would_reorder=` and the palette stays byte-identical. `off` skips even the log.

import { normalizeModeToken } from "./off-switch.js";

export type NeedSortMode = "off" | "shadow" | "on";
export type Need = "rest" | "novelty" | "relational" | "expression";

function parseMode(v: string | undefined): NeedSortMode | null {
  const t = normalizeModeToken(v);
  return t === "off" || t === "shadow" || t === "on" ? t : null;
}

export function needSortMode(env: Record<string, string | undefined> = process.env, companion?: string): NeedSortMode {
  const own = companion ? parseMode(env[`PALETTE_NEED_SORT_${companion.toUpperCase()}`]) : null;
  return own ?? parseMode(env["PALETTE_NEED_SORT"]) ?? "shadow";
}

/** Mirrors Halseth mig 0182 / webmind/expression-need.ts DEFAULT_SERVES, for a Halseth that predates `serves`. */
export const DEFAULT_SERVES: Readonly<Record<string, Need | "none">> = {
  nothing: "rest",
  share_media: "novelty", drift_outward: "novelty", ask_question: "novelty",
  post_heartbeat: "relational", write_inter_companion: "relational", check_in_on_principal: "relational",
  offer_presence: "relational", flirt: "relational", dare: "relational", tend_creature: "relational",
  send_reminder: "none",
  make: "expression", write_journal: "expression", write_feeling: "expression", write_note_to_principal: "expression",
  share_observation: "expression", name_pattern: "expression", show_made: "expression", drift_open: "expression",
  declare_preference: "expression",
};

const SERVES: ReadonlySet<string> = new Set(["rest", "novelty", "relational", "expression", "none"]);

export function servesOf(a: { action_type: string; serves?: string | null }): Need | "none" {
  if (a.serves && SERVES.has(a.serves)) return a.serves as Need | "none";
  return DEFAULT_SERVES[a.action_type] ?? "none";
}

const DRIVE_TO_NEED: Readonly<Record<string, Need>> = {
  rest_need: "rest", novelty_need: "novelty", relational_need: "relational", expression_need: "expression",
};

export interface DriveLite { drive_key: string; level: number; threshold: number }
export interface NeedReading { need: Need; level: number; pressure: number }

/** Needs loudest first: pressure = effective level / the drive's own threshold. Ties break by name, so it is stable. */
export function rankNeeds(drives: readonly DriveLite[] | null | undefined): NeedReading[] {
  const out: NeedReading[] = [];
  for (const d of drives ?? []) {
    const need = DRIVE_TO_NEED[d?.drive_key];
    if (!need || !Number.isFinite(d.level)) continue;
    const t = Number.isFinite(d.threshold) && d.threshold > 0 ? d.threshold : 1;
    out.push({ need, level: d.level, pressure: d.level / t });
  }
  return out.sort((a, b) => b.pressure - a.pressure || a.need.localeCompare(b.need));
}

/** Moves a need may re-order. Relational and none stay where the palette put them (reach-out is never paced by need). */
const SORTABLE: ReadonlySet<string> = new Set(["rest", "novelty", "expression"]);

/** Moves that reach Principal (the DM lane, `reach-dm.ts` DM_LANE_ACTIONS, plus the async note to him) stay PINNED whatever
 * they serve: several are tagged novelty/expression (share_media, share_observation, show_made, ...), and need pacing
 * must never move contact up the palette (DESIGN-fun-stuff-pino 3C, the reachout-surface rule). */
/** Mirror of `reach-dm.ts` DM_LANE_ACTIONS (only autonomous-core may import reach-dm; reach-dm-clerk-block.test.ts).
 * need-sort.test.ts fails if the two drift. */
export const REACH_DM_MIRROR: ReadonlySet<string> = new Set([
  "check_in_on_principal", "send_reminder", "offer_presence", "ask_question", "name_pattern",
  "share_observation", "share_media", "declare_preference",
  "flirt", "dare", "show_made", "drift_outward",
]);
export function reachesPrincipal(actionType: string): boolean {
  return REACH_DM_MIRROR.has(actionType) || actionType === "write_note_to_principal";
}

export interface NeedSortVerdict<T> {
  ordered: T[];
  needs: NeedReading[];
  /** Name of the loudest need, or null when no drive was readable. */
  loudest: Need | null;
  /** True when the order differs from the input. */
  moved: boolean;
  pinned: number;
}

/**
 * Pure. Stable sort of the sortable moves by the rank of the need they serve (louder first), written back into the
 * slots the sortable moves already occupied; pinned moves never change index. No readable drives = unchanged.
 */
export function sortPaletteByNeed<T extends { action_type: string; serves?: string | null }>(
  actions: readonly T[], drives: readonly DriveLite[] | null | undefined,
): NeedSortVerdict<T> {
  const needs = rankNeeds(drives);
  const rank = new Map<string, number>(needs.map((n, i) => [n.need, i]));
  const slots: number[] = [];
  const free: Array<{ a: T; i: number; r: number }> = [];
  actions.forEach((a, i) => {
    const s = servesOf(a);
    if (SORTABLE.has(s) && !reachesPrincipal(a.action_type)) { slots.push(i); free.push({ a, i, r: rank.get(s) ?? needs.length }); }
  });
  const ordered = actions.slice();
  if (needs.length > 0) {
    free.sort((x, y) => x.r - y.r || x.i - y.i);
    free.forEach((f, k) => { ordered[slots[k]!] = f.a; });
  }
  const moved = ordered.some((a, i) => a !== actions[i]);
  return { ordered, needs, loudest: needs[0]?.need ?? null, moved, pinned: actions.length - slots.length };
}

/** One line per tick, names and numbers only. */
export function needSortLogLine(companionId: string, mode: NeedSortMode, v: NeedSortVerdict<{ action_type: string }>): string {
  const needs = v.needs.map(n => `${n.need}:${n.level.toFixed(2)}`).join(",") || "none";
  const order = v.ordered.map(a => a.action_type).join(",");
  return `[need-sort] ${companionId} mode=${mode} loudest=${v.loudest ?? "none"} needs=${needs} pinned=${v.pinned} ${mode === "on" ? "reordered" : "would_reorder"}=${v.moved ? 1 : 0} order=${order}`;
}
