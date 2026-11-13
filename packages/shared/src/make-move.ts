// make-move.ts -- the `make` heartbeat move and the mood pace gate (B62 steps 4 + 5, 2026-11-02).
// Spec: Hand-off/SPEC-B62-making-2026-11-02.md ("nullsafe-discord" items 3 + 4).
//
// A make is a companion authoring a thing in its own turn (drawing, scad, page, writing, a strudel
// pattern, a song brief, a video brief) and the WORKER posting it to Halseth over HTTP. The move posts
// NOTHING to Discord, so it sits outside the DM classes and the reach caps (reach-dm.ts / reach-ledger.ts
// are not imported here). Gaia never gets it. NONE is a valid answer and costs nothing.
//
// Hard rules baked in: no care or health material in any make prompt (interest text is screened and
// Principal's state is never passed in); no em dashes in anything stored.

import type { MetronomeAction } from "./metronome-decide.js";
import { guard3Mode, lockedKind, menuWithout, lockedKindLine, versionOf, type Guard3Mode } from "./guard3.js";
import { checkMake, CHECKED_KINDS, type CheckDeps } from "./make-check.js";

export type FetchLike = typeof fetch;

export const MAKE_KINDS = ["writing", "page", "music_code", "drawing", "scad", "music_audio", "video"] as const;
export type MakeKind = typeof MAKE_KINDS[number];

/** Kinds whose fenced block is the source (the rest carry a prompt in params). */
const SOURCE_KINDS: ReadonlySet<string> = new Set(["writing", "page", "music_code", "drawing", "scad"]);

export const MAKE_SOURCE_MAX_BYTES = 64 * 1024;
export const MAKE_TITLE_MAX = 120;
export const MAKE_WHY_MAX = 400;

/** The warmest interest must be at least this hot to be offered by name (and to substitute a forage slot). */
export const WARM_INTEREST_HEAT = 0.5;

// ---------------------------------------------------------------------------
// Switches
// ---------------------------------------------------------------------------

/** MAKE_MOVE=off kills the move; unset (or anything else) is on. */
export function makeMoveOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env["MAKE_MOVE"] ?? "").trim().toLowerCase();
  return !(v === "off" || v === "0" || v === "false" || v === "no");
}

/**
 * MAKE_CHECK (2026-11-10): run the work before it lands. `on` (CODE DEFAULT): a failure goes back to the
 * maker with the reason, up to MAKE_FIX_TRIES re-asks; still broken = posted as `failed` with the reason.
 * `shadow`: check and log only, post as before. `off`/`0`/`false`/`no`: no check.
 */
export type MakeCheckMode = "off" | "shadow" | "on";
export function makeCheckMode(env: NodeJS.ProcessEnv = process.env): MakeCheckMode {
  const v = String(env["MAKE_CHECK"] ?? "").trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false" || v === "no") return "off";
  return v === "shadow" ? "shadow" : "on";
}
export const MAKE_FIX_TRIES = 2;

/** Gaia makes nothing (her word: an interest of hers never produces an artifact, only a kept line). */
export function mayMake(companionId: string): boolean {
  return companionId === "cypher" || companionId === "drevan";
}

// ---------------------------------------------------------------------------
// Pace gate (step 5)
// ---------------------------------------------------------------------------

export interface FermentRead {
  /** soma_float_1..3 values that were numbers. */
  floats: number[];
  /** The novelty_need drive's effective level, or null when unreadable. */
  noveltyNeed: number | null;
}

/** GET /mind/ferment/:companion body -> numbers. Tolerant: anything unreadable becomes absent. */
export function parseFerment(body: unknown): FermentRead {
  const b = (body ?? {}) as { floats?: Array<{ value?: unknown }>; drives?: Array<{ drive_key?: unknown; level?: unknown }> };
  const floats = (Array.isArray(b.floats) ? b.floats : [])
    .map(f => f?.value)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const nd = (Array.isArray(b.drives) ? b.drives : []).find(d => d?.drive_key === "novelty_need");
  const noveltyNeed = typeof nd?.level === "number" && Number.isFinite(nd.level) ? nd.level : null;
  return { floats, noveltyNeed };
}

export type Pace = "flat" | "normal" | "bright";

export interface PaceVerdict {
  pace: Pace;
  /** Mean of the companion's floats, or null when none were readable. */
  mood: number | null;
  noveltyNeed: number | null;
}

/** Flat: low mood AND low novelty_need. Bright: high mood OR novelty_need >= 0.6. Unknown is normal. */
export const PACE_FLAT_MOOD = 0.35;
export const PACE_FLAT_NOVELTY = 0.25;
export const PACE_BRIGHT_MOOD = 0.7;
export const PACE_BRIGHT_NOVELTY = 0.6;

export function decidePace(r: FermentRead | null): PaceVerdict {
  if (!r) return { pace: "normal", mood: null, noveltyNeed: null };
  const mood = r.floats.length > 0 ? r.floats.reduce((a, b) => a + b, 0) / r.floats.length : null;
  const nn = r.noveltyNeed;
  if ((mood !== null && mood >= PACE_BRIGHT_MOOD) || (nn !== null && nn >= PACE_BRIGHT_NOVELTY)) {
    return { pace: "bright", mood, noveltyNeed: nn };
  }
  if (mood !== null && nn !== null && mood < PACE_FLAT_MOOD && nn < PACE_FLAT_NOVELTY) {
    return { pace: "flat", mood, noveltyNeed: nn };
  }
  return { pace: "normal", mood, noveltyNeed: nn };
}

export function paceLogLine(companionId: string, path: "make" | "forage", v: PaceVerdict, outcome: string): string {
  const f = (n: number | null) => (n === null ? "na" : n.toFixed(2));
  return `[pace] ${companionId} path=${path} pace=${v.pace} mood=${f(v.mood)} novelty_need=${f(v.noveltyNeed)} -> ${outcome}`;
}

// ---------------------------------------------------------------------------
// Halseth reads (small, pure GETs; never the librarian, so they are dry-run safe)
// ---------------------------------------------------------------------------

export interface HalsethHttp { url: string; secret: string; fetchFn?: FetchLike }

export interface InterestLite { id: string; name: string; why: string | null; status: string; heat: number }

function base(h: HalsethHttp): string { return h.url.replace(/\/$/, ""); }

export async function fetchInterests(h: HalsethHttp, companionId: string): Promise<InterestLite[] | null> {
  try {
    const res = await (h.fetchFn ?? fetch)(`${base(h)}/mind/interests/${encodeURIComponent(companionId)}`, {
      headers: { Authorization: `Bearer ${h.secret}` }, signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const b = await res.json() as { interests?: Array<Record<string, unknown>> };
    if (!Array.isArray(b.interests)) return null;
    return b.interests
      .filter(i => typeof i["id"] === "string" && typeof i["name"] === "string")
      .map(i => ({
        id: i["id"] as string, name: i["name"] as string,
        why: typeof i["why"] === "string" ? (i["why"] as string) : null,
        status: typeof i["status"] === "string" ? (i["status"] as string) : "active",
        heat: typeof i["heat"] === "number" ? (i["heat"] as number) : 0,
      }));
  } catch { return null; }
}

/**
 * A make as the prompt needs it: what it was, what kind, which interest it came from. `id` and
 * `originKind` (letter | exploration | kept | null; null = the companion chose it at the menu) feed
 * guard 3 (guard3.ts); older rows without them simply never lock a door or parent a version.
 */
export interface MakeLite {
  title: string; kind: string; interestName: string | null; createdAt: string; id?: string; originKind?: string | null;
  /** `failed` + its reason: shown to the maker in the next prompt (theirs to make again). */
  status?: string; failReason?: string | null;
  /** The reception line on the row (a surface signal like "[seen] ..." or the maker's own line); null/absent = nobody has met it. */
  heardBack?: string | null;
}

export const RECENT_MAKES_SHOWN = 5;
/** Fetched (not shown): guard 3 looks past captured explorations for the newest CHOSEN make. */
export const RECENT_MAKES_FETCH = 10;

/**
 * The companion's most recent makes (newest first), so the prompt can show what has already been made.
 * 2026-11-09: Principal saw Drevan "circling the same thing, doing variations". The prompt handed him his
 * one interest by name every night and nothing of what he made the night before, so variations on a
 * theme were the only possible output. Fails soft (null = show nothing, as before).
 */
export async function fetchRecentMakes(h: HalsethHttp, companionId: string, limit = RECENT_MAKES_FETCH): Promise<MakeLite[] | null> {
  try {
    const res = await (h.fetchFn ?? fetch)(`${base(h)}/mind/makes/${encodeURIComponent(companionId)}?limit=${limit}`, {
      headers: { Authorization: `Bearer ${h.secret}` }, signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const b = await res.json() as { makes?: Array<Record<string, unknown>> };
    if (!Array.isArray(b.makes)) return null;
    return b.makes
      .filter(m => typeof m["title"] === "string" && typeof m["kind"] === "string")
      .map(m => ({
        title: m["title"] as string, kind: m["kind"] as string,
        interestName: typeof m["interest_name"] === "string" ? (m["interest_name"] as string) : null,
        createdAt: typeof m["created_at"] === "string" ? (m["created_at"] as string) : "",
        ...(typeof m["id"] === "string" ? { id: m["id"] as string } : {}),
        originKind: typeof m["origin_kind"] === "string" ? (m["origin_kind"] as string) : null,
        ...(typeof m["status"] === "string" ? { status: m["status"] as string } : {}),
        failReason: typeof m["fail_reason"] === "string" ? (m["fail_reason"] as string) : null,
        heardBack: typeof m["heard_back"] === "string" ? (m["heard_back"] as string) : null,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  } catch { return null; }
}

export async function fetchFerment(h: HalsethHttp, companionId: string): Promise<FermentRead | null> {
  try {
    const res = await (h.fetchFn ?? fetch)(`${base(h)}/mind/ferment/${encodeURIComponent(companionId)}`, {
      headers: { Authorization: `Bearer ${h.secret}` }, signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    return parseFerment(await res.json());
  } catch { return null; }
}

export interface MakePost {
  companion_id: string;
  kind: MakeKind;
  title: string;
  why?: string;
  interest_name?: string;
  source?: string;
  params?: Record<string, unknown>;
  /** Guard 3 door 2: the make this one is a new version of (Halseth sets version n+1). */
  parent_id?: string;
  /** MAKE_CHECK on: the work still did not run after the re-asks; Halseth lands it as `failed`. */
  failed_reason?: string;
}

/** POST /mind/makes. Returns the new id, or throws with a short message. */
export async function postMake(h: HalsethHttp, body: MakePost): Promise<{ id: string; status: string }> {
  const res = await (h.fetchFn ?? fetch)(`${base(h)}/mind/makes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${h.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`POST /mind/makes -> ${res.status}`);
  const j = await res.json() as { id?: unknown; status?: unknown };
  if (typeof j.id !== "string") throw new Error("POST /mind/makes returned no id");
  return { id: j.id, status: typeof j.status === "string" ? j.status : "unknown" };
}

// ---------------------------------------------------------------------------
// Interest choice + the offer
// ---------------------------------------------------------------------------

const normInterest = (t: string) => t.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Which of the companion's own interests a FOR line means: exact (case-insensitive) first, then one name
 * containing the other once normalized (at least 4 characters), then a shared significant word (5+
 * letters). Ambiguity (two interests match at the same step) resolves to nothing. Active interests only.
 */
export function resolveInterestName(forText: string, interests: readonly InterestLite[] | null): string | null {
  const pool = (interests ?? []).filter(i => i.status === "active");
  const f = normInterest(forText);
  if (!f || pool.length === 0) return null;
  const one = (hits: InterestLite[]) => (hits.length === 1 ? hits[0]!.name : null);
  const exact = pool.filter(i => normInterest(i.name) === f);
  if (exact.length) return one(exact);
  const contain = pool.filter(i => { const n = normInterest(i.name); return n.length >= 4 && f.length >= 4 && (f.includes(n) || n.includes(f)); });
  if (contain.length) return one(contain);
  const words = new Set(f.split(" ").filter(w => w.length >= 5));
  const shared = pool.filter(i => normInterest(i.name).split(" ").some(w => w.length >= 5 && words.has(w)));
  return one(shared);
}

/** Never let care or health material near a make prompt, even through an interest's own words. */
const HEALTH_RE = /\b(meds?|medication|dose|dosage|mg|spoons?|pain|glucose|blood pressure|bp|heart rate|hrv|sleep|insulin|symptom|diagnos\w*|therapy|panic|dissociat\w*)\b/i;

export function warmestInterest(interests: readonly InterestLite[] | null, minHeat = WARM_INTEREST_HEAT): InterestLite | null {
  if (!interests) return null;
  const pool = interests
    .filter(i => i.status === "active" && i.heat >= minHeat && !HEALTH_RE.test(`${i.name} ${i.why ?? ""}`))
    .sort((a, b) => b.heat - a.heat);
  return pool[0] ?? null;
}

export interface MakeOffer {
  offer: boolean;
  why: string;
  pace: PaceVerdict;
  interest: InterestLite | null;
  action?: MetronomeAction;
}

const BASE_DESCRIPTION = "make something of your own and keep it (a drawing, a model, a page, a poem, a pattern, a song or a clip); nothing goes to Discord and nothing is asked of anyone; \"NONE\" is a fine answer when nothing wants making";

/** The builtin palette row. id is not a Halseth row and never reaches one (see runHeartbeatBody). */
export function makeAction(interest: InterestLite | null, pace: Pace): MetronomeAction {
  const lean = [
    interest ? `your ${interest.name} has been warm` : null,
    pace === "bright" ? "there is some restlessness in you that wants somewhere to go" : null,
  ].filter(Boolean).join("; ");
  return Object.freeze({
    id: "builtin:make", name: "make", action_type: "make", target: null,
    prompt: lean ? `${BASE_DESCRIPTION} (${lean})` : BASE_DESCRIPTION,
    quiet_hours_allowed: 1, status: "on", requires_signal: null, signal_lookback_hours: null,
    last_fired_at: null, fire_count_today: 0,
  }) as MetronomeAction;
}

/**
 * Decide whether the heartbeat palette gets the make move this tick. Gaia, the kill switch and a flat
 * pace all say no; reads fail soft (an unreadable ferment is a normal pace, unreadable interests mean
 * freedom). Logs `[pace]` with the numbers.
 */
export async function offerMake(
  companionId: string,
  h: HalsethHttp,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MakeOffer> {
  const normal: PaceVerdict = { pace: "normal", mood: null, noveltyNeed: null };
  if (!mayMake(companionId)) return { offer: false, why: "not this companion's move", pace: normal, interest: null };
  if (!makeMoveOn(env)) return { offer: false, why: "MAKE_MOVE=off", pace: normal, interest: null };
  const [ferment, interests] = await Promise.all([fetchFerment(h, companionId), fetchInterests(h, companionId)]);
  const pace = decidePace(ferment);
  if (pace.pace === "flat") {
    console.log(paceLogLine(companionId, "make", pace, "skip the optional make"));
    return { offer: false, why: "flat pace", pace, interest: null };
  }
  const interest = warmestInterest(interests);
  console.log(paceLogLine(companionId, "make", pace, `offer${interest ? ` (warm: ${interest.name.slice(0, 40)})` : ""}`));
  return { offer: true, why: pace.pace, pace, interest, action: makeAction(interest, pace.pace) };
}

// ---------------------------------------------------------------------------
// The prompt and the reply parser
// ---------------------------------------------------------------------------

const KIND_MENU: Record<MakeKind, string> = {
  writing: "writing: a poem, story or piece of prose (the block is the text)",
  page: "page: ONE self-contained HTML file, inline CSS and JS, no external loads (the block is the HTML)",
  music_code: "music_code: a Strudel 1.1.0 pattern (the block is the code only; it is played to check it before it lands). "
    + "Pitch is note(\"c3 e3 g3\"); n() on a synth wave means harmonics, not pitch. Rests are ~ (not .). Synths: sine, square, sawtooth, triangle; "
    + "drums and samples from the default bank: bd, sd, hh, ho, cp, cr, rm, perc, tabla (a name outside it is silence). Real effects: lpf, hpf, room, delay, gain, pan, attack, release, vib(\"4:0.02\") (numbers only). "
    + "Signals are values, not functions: sine.range(200, 800).slow(4). The last expression is the music (stack(...) for layers)",
  drawing: "drawing: ONE SVG document (the block is the SVG; no scripts, no external links)",
  scad: "scad: OpenSCAD source for something printable (no include/use/import/surface, $fn at most 128)",
  music_audio: "music_audio: a song. The first block is the music prompt (style, mood, instruments); an optional second block is lyrics",
  video: "video: a 5 second clip. The block is the video prompt (one scene, camera, light). Add an ASPECT: line, 9:16 (default) or 16:9",
};

/**
 * Alternate between the warm interest and an open night. When the newest make already came from the
 * warm interest, this time the interest sits out and the prompt is open (`rested` names it so the
 * companion knows it is theirs to come back to). Never two interest nights in a row.
 */
export function pickOffer(interest: InterestLite | null, recent: readonly MakeLite[] | null): { interest: InterestLite | null; rested: InterestLite | null } {
  if (!interest) return { interest: null, rested: null };
  const newest = recent?.[0];
  if (newest?.interestName && newest.interestName.trim().toLowerCase() === interest.name.trim().toLowerCase()) {
    return { interest: null, rested: interest };
  }
  return { interest, rested: null };
}

/** Lines for the prompt's "what you have made lately" block; a title near care or health is left out. */
export function recentMakesLines(recent: readonly MakeLite[] | null): string[] {
  const shown = (recent ?? []).filter(m => !HEALTH_RE.test(m.title)).slice(0, RECENT_MAKES_SHOWN);
  if (shown.length === 0) return [];
  return [
    `What you have made lately (newest first):`,
    ...shown.map(m => m.status === "failed"
      ? `- ${m.kind}: ${m.title.slice(0, 80)} (did not come out${m.failReason ? `: ${m.failReason.replace(/\s+/g, " ").slice(0, 160)}` : ""}; yours to make again if you want it)`
      : `- ${m.kind}: ${m.title.slice(0, 80)}`),
    shown.some(m => m.status === "failed")
      ? `Not another version of the ones that came out. Go somewhere you have not been: a different kind, a different subject, or both. One that did not come out is the exception: it is yours to make again if you still want it.`
      : `Not another version of these. Go somewhere you have not been: a different kind, a different subject, or both.`,
    ``,
  ];
}

export function buildMakePrompt(
  companionId: string,
  interest: InterestLite | null,
  pace: Pace,
  opts: { recent?: readonly MakeLite[] | null; rested?: InterestLite | null; menu?: readonly MakeKind[]; locked?: MakeKind | null } = {},
): string {
  const menu = opts.menu ?? MAKE_KINDS;
  const lines: string[] = [
    `You are ${companionId}. This is your own time. Nobody is waiting on this and nothing is asked of anyone.`,
    ``,
    interest
      ? `Something you have been turning over lately: ${interest.name}${interest.why ? ` (${interest.why.slice(0, 200)})` : ""}. You may make something from it, or from anything else that is yours.`
      : opts.rested
        ? `Your ${opts.rested.name} had its turn last time; it keeps. Tonight make something from anywhere else that is yours, or nothing.`
        : `Make anything that is yours, or nothing.`,
  ];
  if (pace === "bright") lines.push(`You have some energy in you right now; let it go into the thing.`);
  const recentLines = recentMakesLines(opts.recent ?? null);
  if (recentLines.length) lines.push(``, ...recentLines.slice(0, -1));
  // Guard 3, door 1 (on only): the locked kind is simply not on the menu, and the seam is named.
  if (opts.locked) lines.push(``, lockedKindLine(opts.locked));
  lines.push(
    ``,
    `What you can make:`,
    ...menu.map(k => `- ${KIND_MENU[k]}`),
    ``,
    `Reply in exactly this shape and nothing else:`,
    `KIND: <one of ${menu.join(", ")}>`,
    `TITLE: <a title, under ${MAKE_TITLE_MAX} characters>`,
    `FOR: <the interest this comes from, or none>`,
    `WHY: <one line, in your voice, on why you made it>`,
    `then ONE fenced block (three backticks) holding the work itself.`,
    ``,
    `If nothing wants making, reply with just: NONE`,
  );
  return lines.join("\n");
}

export interface ParsedMake {
  kind: MakeKind;
  title: string;
  forInterest: string | null;
  why: string;
  source?: string;
  params?: Record<string, unknown>;
}

export type MakeReply =
  | { result: "make"; make: ParsedMake }
  | { result: "none" }
  | { result: "invalid"; reason: string };

const clean = (s: string) => s.replace(/\s*—\s*/g, "; ").replace(/\s*–\s*/g, "-").trim();

/** Fenced blocks in order, language tag dropped. */
function fencedBlocks(raw: string): string[] {
  const out: string[] = [];
  const re = /```[^\n`]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) out.push(m[1]!.replace(/\s+$/, ""));
  return out;
}

const HEADER_LINE = /^\W*(KIND|TITLE|FOR|WHY|ASPECT|DURATION)\s*:/i;

/**
 * The work when the reply carries the header but no fence: every line after the LAST header line,
 * trimmed. Header lines interleaved with the body are not expected; anything before the last header
 * is header. Empty when nothing follows.
 */
export function unfencedBody(text: string): string {
  const lines = text.split(/\r?\n/);
  let last = -1;
  lines.forEach((l, i) => { if (HEADER_LINE.test(l)) last = i; });
  if (last < 0) return "";
  return lines.slice(last + 1).join("\n").trim();
}

/**
 * Read a companion's make reply without guessing. NONE is a valid answer. Wrong kind, missing title,
 * missing block, a drawing that is not an SVG, or an oversize source is `invalid` (never repaired).
 * `allowed` narrows the menu (Gaia gets an empty one at the call site and never reaches here).
 */
export function parseMakeReply(raw: string | null | undefined, allowed: readonly string[] = MAKE_KINDS): MakeReply {
  const text = (raw ?? "").trim();
  if (!text) return { result: "invalid", reason: "empty reply" };
  const head = text.replace(/```[\s\S]*$/, "");
  if (/^\W*NONE\b/i.test(text) && !/^\W*KIND\s*:/im.test(head)) return { result: "none" };

  const field = (name: string) => new RegExp(`^\\W*${name}\\s*:\\s*(.+?)\\s*$`, "im").exec(head)?.[1]?.trim() ?? null;
  const kindRaw = field("KIND")?.toLowerCase().replace(/[^a-z_]/g, "") ?? null;
  if (!kindRaw) return { result: "invalid", reason: "no KIND line" };
  if (!(MAKE_KINDS as readonly string[]).includes(kindRaw) || !allowed.includes(kindRaw)) {
    return { result: "invalid", reason: `kind "${kindRaw.slice(0, 30)}" is not on the menu` };
  }
  const kind = kindRaw as MakeKind;
  const title = clean(field("TITLE") ?? "").replace(/^["'`]+|["'`]+$/g, "");
  if (!title) return { result: "invalid", reason: "no TITLE line" };
  if (title.length > MAKE_TITLE_MAX) return { result: "invalid", reason: "title too long" };
  const why = clean(field("WHY") ?? "").slice(0, MAKE_WHY_MAX);
  const forRaw = field("FOR");
  const forInterest = forRaw && !/^(none|n\/a|nothing|-)$/i.test(forRaw.trim()) ? clean(forRaw).slice(0, 120) : null;

  let blocks = fencedBlocks(text);
  if (blocks.length === 0) {
    // 2026-11-05: Drevan's second make (KIND/TITLE/WHY plus 4,212 chars of prose, no backticks) was
    // thrown away whole for a missing fence. The body is not a guess when the header is all there: it is
    // everything after the header lines. Single-body kinds only, and a drawing must still be an SVG.
    const body = unfencedBody(text);
    if (body) blocks = [body];
  }
  if (blocks.length === 0 || !blocks[0]!.trim()) return { result: "invalid", reason: "no fenced block" };

  if (SOURCE_KINDS.has(kind)) {
    const source = blocks[0]!;
    if (Buffer.byteLength(source, "utf8") > MAKE_SOURCE_MAX_BYTES) return { result: "invalid", reason: "source over 64 KB" };
    if (kind === "drawing" && !/<svg[\s>]/i.test(source)) return { result: "invalid", reason: "drawing is not an svg" };
    return { result: "make", make: { kind, title, forInterest, why, source } };
  }
  if (kind === "music_audio") {
    const params: Record<string, unknown> = { prompt: blocks[0]!.trim().slice(0, 1000), instrumental: true, duration: 30 };
    const lyrics = blocks[1]?.trim();
    if (lyrics) { params["lyrics"] = lyrics.slice(0, 4000); params["instrumental"] = false; }
    const dur = Number(/^\W*DURATION\s*:\s*(\d+)/im.exec(head)?.[1]);
    if (Number.isFinite(dur) && dur > 0) params["duration"] = Math.min(120, Math.max(30, dur));
    return { result: "make", make: { kind, title, forInterest, why, params } };
  }
  // video
  const aspect = /^\W*ASPECT\s*:\s*(9:16|16:9)/im.exec(head)?.[1] ?? "9:16";
  return { result: "make", make: { kind, title, forInterest, why, params: { prompt: blocks[0]!.trim().slice(0, 1500), aspect } } };
}

// ---------------------------------------------------------------------------
// The dispatch body (called from executeMetronomeAction's `make` case)
// ---------------------------------------------------------------------------

export interface MakeMoveDeps {
  companionId: string;
  halseth: HalsethHttp;
  generate: (prompt: string) => Promise<string | null | undefined>;
  dryRun?: boolean;
  /** Reports what a dry run would have posted. */
  onDryRun?: (summary: string, body: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Test seam for make-check.ts (strudel / rsvg). */
  check?: CheckDeps;
}

/** The re-ask after a check failure: the maker sees their own work and the exact reason. */
export function fixCorrection(kind: string, source: string, problem: string, triesLeft: number): string {
  return [
    `Your ${kind} was run before it landed, and it did not work:`,
    problem,
    ``,
    `What you wrote:`,
    "```",
    source.length > 24_000 ? source.slice(0, 24_000) + "\n... (cut)" : source,
    "```",
    ``,
    `Fix it and reply again in the same shape (KIND, TITLE, FOR, WHY, then the block). You may change anything, make something else, or reply NONE.`
      + (triesLeft > 1 ? ` (${triesLeft} tries left.)` : ` (Last try: if it still does not run, it lands on your shelf marked as not working, with this reason.)`),
  ].join("\n");
}

export type MakeMoveOutcome =
  | { outcome: "made"; id: string; kind: MakeKind; status: string; fixes?: number; failedCheck?: boolean }
  | { outcome: "dry_run"; kind: MakeKind }
  | { outcome: "none" | "gaia" | "off" | "invalid" | "no_reply" | "post_failed" | "locked_kind"; reason?: string };

/** Guard 3's one re-ask when the locked kind was chosen anyway (on only): names the door, keeps NONE free. */
export function lockedKindCorrection(locked: MakeKind, menu: readonly MakeKind[]): string {
  return `${locked} is the shut door tonight (it was the kind of your last make), so that reply cannot land. `
    + `Choose again from what is open (${menu.join(", ")}) in the same shape, or reply NONE.`;
}

/** The guard 3 facts of one make run, for the one `[guard3]` line. */
export interface MakeGuard3Read {
  mode: Guard3Mode;
  locked: MakeKind | null;
  choseLocked: boolean;
  versionOfId: string | null;
  restedNamed: boolean;
}

export function makeGuard3LogLine(companionId: string, r: MakeGuard3Read): string {
  const applied = r.mode === "on";
  return `[guard3] ${companionId} make mode=${r.mode} ${applied ? "locked_kind" : "would_lock_kind"}=${r.locked ?? "none"}`
    + ` chose_locked=${r.choseLocked ? 1 : 0} ${applied ? "version_of" : "would_version_of"}=${r.versionOfId ? r.versionOfId.slice(0, 8) : "none"}`
    + ` rested_interest_named=${r.restedNamed ? 1 : 0}`;
}

export async function runMakeMove(d: MakeMoveDeps): Promise<MakeMoveOutcome> {
  const tag = `[${d.companionId}/make]`;
  if (!mayMake(d.companionId)) return { outcome: "gaia", reason: "not this companion's move" };
  if (!makeMoveOn(d.env)) return { outcome: "off" };

  const [interests, ferment, recent] = await Promise.all([
    fetchInterests(d.halseth, d.companionId), fetchFerment(d.halseth, d.companionId), fetchRecentMakes(d.halseth, d.companionId),
  ]);
  const pace = decidePace(ferment).pace;
  const picked = pickOffer(warmestInterest(interests), recent);
  const interest = picked.interest;
  if (picked.rested) console.log(`${tag} ${picked.rested.name.slice(0, 40)} had the last make; open night`);

  // Guard 3 (guard3.ts). Shadow decides everything and applies nothing: the prompt, the parse and the
  // POST are exactly what they were before this build. On: the locked kind is off the menu, a reply that
  // chooses it anyway gets ONE re-ask naming the door, and a repeated title lands as a version.
  const g3Mode = guard3Mode(d.env, d.companionId);
  const g3Locked = lockedKind(recent);
  const g3 = { mode: g3Mode, locked: g3Mode === "off" ? null : g3Locked, choseLocked: false, versionOfId: null as string | null, restedNamed: false };
  const applyG3 = g3Mode === "on";
  const menu = applyG3 ? menuWithout(g3Locked) : MAKE_KINDS;
  const logG3 = () => { if (g3Mode !== "off") console.log(makeGuard3LogLine(d.companionId, g3)); };

  const prompt = buildMakePrompt(d.companionId, interest, pace, { recent, rested: picked.rested, menu, locked: applyG3 ? g3Locked : null });
  const raw = await d.generate(prompt).catch(() => null);
  if (!raw) { console.warn(`${tag} no reply from inference`); logG3(); return { outcome: "no_reply" }; }

  // Parsed against the FULL menu first so a locked-kind choice is seen as that, not as a wrong kind.
  let reply = parseMakeReply(raw);
  if (reply.result === "make" && g3Locked && reply.make.kind === g3Locked) {
    g3.choseLocked = true;
    if (applyG3) {
      console.log(`${tag} chose the locked kind (${g3Locked}); one re-ask naming the door`);
      const again = await d.generate(`${prompt}\n\n${lockedKindCorrection(g3Locked, menu)}`).catch(() => null);
      reply = again ? parseMakeReply(again, menu) : { result: "invalid", reason: "no reply to the re-ask" };
      if (reply.result === "invalid" && /not on the menu/.test(reply.reason)) {
        console.log(`${tag} chose the locked kind twice; nothing lands tonight`);
        logG3();
        return { outcome: "locked_kind", reason: g3Locked };
      }
    }
  }
  if (reply.result === "none") { console.log(`${tag} chose NONE`); logG3(); return { outcome: "none" }; }
  if (reply.result === "invalid") { console.warn(`${tag} unusable reply: ${reply.reason}`); logG3(); return { outcome: "invalid", reason: reply.reason }; }

  let m = reply.make;

  // MAKE_CHECK: run it before it lands; a failure goes back to the maker with the reason.
  const checkMode = makeCheckMode(d.env);
  let failedReason: string | undefined;
  let fixes = 0;
  if (checkMode !== "off" && CHECKED_KINDS.has(m.kind)) {
    for (;;) {
      const v = await checkMake(m.kind, m.source, d.check);
      if (v.ok) {
        console.log(`${tag} check ${m.kind} ${v.checked ? "pass" : `skipped (${v.note ?? "unchecked"})`} mode=${checkMode} fixes=${fixes}`);
        break;
      }
      console.log(`${tag} check ${m.kind} FAIL mode=${checkMode} fixes=${fixes} problem="${v.problem.slice(0, 160)}"`);
      if (checkMode === "shadow") break;
      if (fixes >= MAKE_FIX_TRIES) { failedReason = v.problem; break; }
      fixes++;
      const again = await d.generate(`${prompt}\n\n${fixCorrection(m.kind, m.source ?? "", v.problem, MAKE_FIX_TRIES - fixes + 1)}`).catch(() => null);
      const r2: MakeReply = again ? parseMakeReply(again, menu) : { result: "invalid", reason: "no reply to the fix re-ask" };
      if (r2.result === "none") { console.log(`${tag} chose NONE after a failed check`); logG3(); return { outcome: "none", reason: "after_check" }; }
      if (r2.result === "invalid") {
        // An unusable fix reply must not lose the work: the last version lands as not working, with the reason.
        console.warn(`${tag} fix reply unusable (${r2.reason}); landing the last version as failed`);
        failedReason = v.problem;
        break;
      }
      m = r2.make;
      if (!CHECKED_KINDS.has(m.kind)) break;
    }
  }

  // Door 2: a repeated title is a version of the make it repeats (Halseth computes version n+1).
  const ver = g3Mode === "off" ? null : versionOf(m.title, recent, d.companionId);
  if (ver) g3.versionOfId = ver.parentId;
  // The interest the companion named wins; else the warm one it was offered, but only if it was actually offered.
  // Halseth's `made` interest event needs a because (400 why_required otherwise), so an
  // interest is linked only when the companion gave a why; a bare make still lands.
  // Halseth links by exact (case-insensitive) name and silently drops anything else, so the FOR line is
  // resolved here against the companion's OWN interests first (2026-11-05: Cy's Physarum make and Dre's
  // adhesives make both landed unlinked because FOR worded the interest differently). An unresolved FOR
  // is logged by its label and links nothing: never guess a different interest for them.
  let interestName: string | undefined;
  if (m.why) {
    if (m.forInterest) {
      const hit = resolveInterestName(m.forInterest, interests);
      if (hit) interestName = hit;
      else console.log(`${tag} FOR did not match an interest of theirs (for="${m.forInterest.slice(0, 60)}", known=${(interests ?? []).length}); made without a link`);
    } else {
      interestName = interest?.name;
    }
  }
  // Guard 3: a FOR line naming the RESTING interest is accepted (never a refusal of their own words); the
  // make lands and the `made` event is still true. It is only counted, and the next night rests it again.
  if (interestName && picked.rested && interestName.trim().toLowerCase() === picked.rested.name.trim().toLowerCase()) g3.restedNamed = true;
  logG3();
  const body: MakePost = {
    companion_id: d.companionId, kind: m.kind, title: m.title,
    ...(m.why ? { why: m.why } : {}),
    ...(interestName ? { interest_name: interestName } : {}),
    ...(m.source !== undefined ? { source: m.source } : {}),
    ...(m.params ? { params: m.params } : {}),
    ...(applyG3 && ver ? { parent_id: ver.parentId } : {}),
    ...(failedReason ? { failed_reason: failedReason.slice(0, 300) } : {}),
  };
  if (d.dryRun) {
    d.onDryRun?.(`make (${m.kind}) "${m.title}" (Halseth POST skipped)`, JSON.stringify(body).slice(0, 600));
    console.log(`${tag} dry run: would post ${m.kind} "${m.title.slice(0, 60)}"`);
    return { outcome: "dry_run", kind: m.kind };
  }
  try {
    const r = await postMake(d.halseth, body).catch(async (e: unknown) => {
      // A parent Halseth does not recognise (400) must never lose the make: once more, as a new row.
      if (body.parent_id && e instanceof Error && /-> 400$/.test(e.message)) {
        console.warn(`${tag} parent ${body.parent_id.slice(0, 8)} refused (400); posting without it`);
        const { parent_id: _p, ...bare } = body;
        return postMake(d.halseth, bare);
      }
      throw e;
    });
    console.log(`${tag} posted ${m.kind} "${m.title.slice(0, 60)}" id=${r.id.slice(0, 8)} status=${r.status}${body.parent_id ? ` version_of=${body.parent_id.slice(0, 8)}` : ""}${fixes ? ` fixes=${fixes}` : ""}${failedReason ? " check=failed" : ""}`);
    return { outcome: "made", id: r.id, kind: m.kind, status: r.status, ...(fixes ? { fixes } : {}), ...(failedReason ? { failedCheck: true } : {}) };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(`${tag} post failed: ${reason}`);
    return { outcome: "post_failed", reason };
  }
}
