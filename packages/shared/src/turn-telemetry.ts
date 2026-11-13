// turn-telemetry.ts -- ONE structured line per reply turn (P6 of Hand-off/DESIGN-rapid-fire-bursts-2026-10-18.md).
//
// 2026-10-18 incident: reconstructing one slow channel moment took four log sources and snowflake
// decoding. Now every turn that reaches the inbox's run callback (and every turn the inbox drops)
// ends in exactly one `[turn] {json}` line, same shape idiom as `[rail]` (rail-telemetry.ts):
//
//   [turn] {"c":"drevan","ch":"...","msg":"...","side":"spouse","outcome":"posted","queue_ms":0,
//           "settle_ms":4000,"gathered":2,"vision_ms":1200,"vision":"wait","halseth_ms":310,
//           "inference_ms":9100,"post_ms":240,"total_ms":15200,"catchup":false,"in_tok":null,"at":"..."}
//
// IDS, COUNTS AND TIMINGS ONLY. Never message or reply text; the schema has no field that could hold it.
//
// How the stages reach the trace without threading a parameter through a 3,600-line handler: the
// bot-core turn wrapper runs the turn inside an AsyncLocalStorage context (`runWithTurn`), and the
// seams (resolveSeenImages, the Librarian fetch, the Hermes call, the send, railSuppressed) read
// `currentTurn()`. Outside a turn it is undefined and every hook is a no-op.
//
// Outcomes: posted | absorbed | superseded_a | superseded_b | skipped:<gate> | held.
//   posted        a reply went to the channel (always wins over an earlier skip mark)
//   absorbed      the inbox superseded this turn and nothing else ended it first (STM/ingest only)
//   superseded_a  check A: skipped before the model was called
//   superseded_b  check B: a finished reply was dropped (SUPERSEDE_B=on)
//   skipped:<g>   a rail/gate ended it: the rail name (echo, bid_lost, human_address, ...), or
//                 queue_overflow (inbox backstop dropped it), pass, error, other
//   held          reserved: a reply deliberately withheld (the B32 care [PASS])
// The FIRST outcome set wins, except `posted`.
//
// TURN_TELEMETRY=off/0/false/no turns the line off (the measurements still cost nothing).

import { AsyncLocalStorage } from "node:async_hooks";
import { appendServedRow, buildServedRow, servedMemoryEnabled, type ServedMemoryRow } from "./served-memory.js";
import { appendTurnRow, type TurnHubRow, type TurnKind } from "./turn-hub.js";

export type { TurnKind } from "./turn-hub.js";

/**
 * Mint a turn id: `<companion>-<YYYYMMDDTHHMMSS UTC>-<4 base36 random>`, readable and sortable.
 * Minted ONCE per run (turn-key spec, 2026-11-11): a lull release or a `:pass` follow-up is a new run
 * and gets a new id even though the Discord `msg` repeats.
 */
export function mintTurnId(companion: string, now: number = Date.now(), rand: () => number = Math.random): string {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
  let r = "";
  while (r.length < 4) r += Math.floor(rand() * 36 ** 4).toString(36).padStart(4, "0");
  return `${companion}-${stamp}-${r.slice(0, 4)}`;
}

const OFF = new Set(["off", "0", "false", "no"]);

/** TURN_TELEMETRY, default ON. */
export function turnTelemetryEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !OFF.has((env["TURN_TELEMETRY"] ?? "").trim().toLowerCase());
}

export type VisionKind = "hit" | "miss" | "wait" | "lock-wait" | "budget" | "none";

export interface TurnTraceInit {
  companionId: string;
  channelId: string;
  messageId: string;
  /** Human side (principal | spouse) or null when unknown / not a human message. */
  side: string | null;
  /** Discord createdTimestamp of the (newest) message; null = unknown. total_ms counts from it. */
  createdAt: number | null;
  /** When the message entered this bot's inbox (fallback origin for total_ms). */
  enqueuedAt: number;
  startedAt: number;
  /** Time spent behind other turns, excluding the settle hold. */
  queueMs: number;
  /** Time actually held in the burst-settle window. */
  settleMs: number;
  /** Earlier messages of the burst this turn answers for. */
  gathered: number;
  /** This turn arrived while another was running in the channel (it is the catch-up). */
  catchup: boolean;
  enabled?: boolean;
  now?: () => number;
  log?: (line: string) => void;
  /** Served-memory audit sink (served-memory.ts); default appends the JSONL row. Tests inject. */
  audit?: (row: ServedMemoryRow) => void;
  /** Overrides SERVED_MEMORY_AUDIT for tests. */
  auditEnabled?: boolean;
  /** What kind of run this is (default "reply"). */
  kind?: TurnKind;
  /** Override the minted id (tests). */
  turnId?: string;
  /** The deleted pre-proxy PluralKit message id, when known. */
  pkOriginal?: string | null;
  /** Earlier burst message ids folded into this run. */
  absorbed?: readonly string[];
  /** Autonomous runs: no `[turn]` line and no served-memory row (those reports count reply turns only). */
  quiet?: boolean;
  /** Hub-log sink (turn-hub.ts); default appends to TURN_LOG. Tests inject. */
  hub?: (row: TurnHubRow) => void | Promise<void>;
}

export class TurnTrace {
  private outcome: string | null = null;
  private visionMs = 0;
  private visionKind: VisionKind = "none";
  private halsethMs = 0;
  private inferenceMs = 0;
  private postMs = 0;
  private inTok: number | null = null;
  private emitted = false;
  private transcriptId: string | null = null;
  readonly turnId: string;
  private kind: TurnKind;
  private replyTargetId: string | null = null;
  private pkOriginalId: string | null;
  private hermesCalls = 0;
  private regens = 0;
  private tokensIn = 0;
  private tokensOut = 0;
  private readonly sentIds: string[] = [];
  private readonly served = new Map<string, Set<string>>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly enabled: boolean;

  constructor(private readonly i: TurnTraceInit) {
    this.now = i.now ?? Date.now;
    this.log = i.log ?? ((l) => console.log(l));
    this.enabled = i.enabled ?? turnTelemetryEnabled();
    this.turnId = i.turnId ?? mintTurnId(i.companionId, this.now());
    this.kind = i.kind ?? "reply";
    this.pkOriginalId = i.pkOriginal ?? null;
  }

  private hubSkipped = false;
  /** An autonomous poll that did nothing: no hub row. */
  skipHub(): void { this.hubSkipped = true; }

  /** Ids for the hub row (never text). */
  setReplyTarget(id: string | null | undefined): void { if (id) this.replyTargetId = String(id); }
  setPkOriginal(id: string | null | undefined): void { if (id) this.pkOriginalId = String(id); }
  addSent(ids: readonly string[]): void { for (const id of ids) if (id && !this.sentIds.includes(id)) this.sentIds.push(id); }
  addHermesCall(): void { this.hermesCalls += 1; }
  addRegenerate(): void { this.regens += 1; }
  addUsage(inTok: number, outTok: number): void {
    if (Number.isFinite(inTok) && inTok > 0) this.tokensIn += Math.round(inTok);
    if (Number.isFinite(outTok) && outTok > 0) this.tokensOut += Math.round(outTok);
  }

  /** Ids (never text) of memory items injected into this turn; see served-memory.ts. */
  addServed(source: string, ids: readonly string[]): void {
    if (!ids.length) return;
    let set = this.served.get(source);
    if (!set) { set = new Set(); this.served.set(source, set); }
    for (const id of ids) set.add(id);
  }
  setTranscript(id: string): void { this.transcriptId = id; }

  get hasOutcome(): boolean { return this.outcome !== null; }

  setOutcome(o: string): void {
    if (o === "posted" || this.outcome === null) this.outcome = o;
  }
  setVision(ms: number, kind: VisionKind): void { this.visionMs += Math.max(0, Math.round(ms)); this.visionKind = kind; }
  addHalseth(ms: number): void { this.halsethMs += Math.max(0, Math.round(ms)); }
  setInference(ms: number): void { this.inferenceMs = Math.max(0, Math.round(ms)); }
  setPost(ms: number): void { this.postMs = Math.max(0, Math.round(ms)); }
  setInTok(n: number | null | undefined): void { if (typeof n === "number" && Number.isFinite(n)) this.inTok = Math.round(n); }

  /** Called by the wrapper when the turn function returns or throws; derives an outcome if none was set. */
  finish(o: { superseded: boolean; threw?: boolean }): void {
    if (this.outcome === null) this.outcome = o.threw ? "skipped:error" : o.superseded ? "absorbed" : "skipped:other";
    this.emit();
  }

  emit(): void {
    if (this.emitted) return;
    this.emitted = true;
    this.emitHub();
    if (this.i.quiet) return;
    this.emitServed();
    if (!this.enabled) return;
    try {
      const now = this.now();
      const origin = this.i.createdAt !== null && this.i.createdAt <= now ? this.i.createdAt : this.i.enqueuedAt;
      const payload = {
        c: this.i.companionId,
        ch: this.i.channelId,
        msg: this.i.messageId,
        side: this.i.side,
        outcome: this.outcome ?? "skipped:other",
        queue_ms: this.i.queueMs,
        settle_ms: this.i.settleMs,
        gathered: this.i.gathered,
        vision_ms: this.visionMs,
        vision: this.visionKind,
        halseth_ms: this.halsethMs,
        inference_ms: this.inferenceMs,
        post_ms: this.postMs,
        total_ms: Math.max(0, now - origin),
        catchup: this.i.catchup,
        in_tok: this.inTok,
        at: new Date(now).toISOString(),
        turn: this.turnId,
        kind: this.effectiveKind(),
      };
      this.log(`[turn] ${JSON.stringify(payload)}`);
    } catch { /* telemetry must never be the reason a turn fails */ }
  }

  /** A reply-kind run that ended without answering (absorbed into a burst, superseded) is an `absorb`. */
  private effectiveKind(): TurnKind {
    if (this.kind === "reply" && (this.outcome === "absorbed" || this.outcome === "superseded_a" || this.outcome === "superseded_b")) return "absorb";
    return this.kind;
  }

  /** One hub row per run, ids and counts only. Never throws; the append is detached and fail-open. */
  private emitHub(): void {
    try {
      if (this.hubSkipped) return;
      const autonomous = this.i.quiet === true;
      const row: TurnHubRow = {
        turn: this.turnId,
        at: new Date(this.now()).toISOString(),
        c: this.i.companionId,
        kind: this.effectiveKind(),
        ch: this.i.channelId || null,
        answered: !autonomous && this.outcome === "posted" && this.i.messageId ? this.i.messageId : null,
        absorbed: [...(this.i.absorbed ?? [])],
        pk_original: this.pkOriginalId,
        reply_target: this.replyTargetId,
        transcript: this.transcriptId,
        hermes_calls: this.hermesCalls,
        regenerates: this.regens,
        sent: [...this.sentIds],
        outcome: this.outcome ?? "skipped:other",
        tokens_in: this.tokensIn,
        tokens_out: this.tokensOut,
      };
      const sink = this.i.hub ?? ((r) => appendTurnRow(r));
      const res = sink(row);
      if (res && typeof (res as Promise<void>).catch === "function") (res as Promise<void>).catch(() => {});
    } catch { /* the hub log must never be the reason a turn fails */ }
  }

  /** One audit row per turn that answered (posted) or served anything; independent of TURN_TELEMETRY. */
  private emitServed(): void {
    try {
      if (!(this.i.auditEnabled ?? servedMemoryEnabled())) return;
      if (this.served.size === 0 && this.outcome !== "posted") return;
      const row = buildServedRow({
        at: new Date(this.now()).toISOString(), companion: this.i.companionId, channelId: this.i.channelId,
        messageId: this.i.messageId, transcriptId: this.transcriptId, outcome: this.outcome ?? "skipped:other",
        served: this.served, turn: this.turnId,
      });
      (this.i.audit ?? ((r) => appendServedRow(r)))(row);
    } catch { /* the audit must never be the reason a turn fails */ }
  }
}

const store = new AsyncLocalStorage<TurnTrace>();

export function runWithTurn<T>(trace: TurnTrace, fn: () => T): T { return store.run(trace, fn); }
export function currentTurn(): TurnTrace | undefined { return store.getStore(); }

/**
 * The stamp: `{turn: "<id>"}` inside a run, `{}` outside. Spread it LAST into every jsonl row
 * (`{...row, ...turnFields()}`); it only ever APPENDS a field, never renames one the report scripts read.
 * Call it synchronously at the writer's entry: detached work started inside the run keeps the context.
 */
export function turnFields(): { turn?: string } {
  try { const t = currentTurn(); return t ? { turn: t.turnId } : {}; } catch { return {}; }
}

/**
 * The Halseth journal tag (turn-key phase 2): [`turn:<id>`] inside a run, [] outside. Same convention as
 * `reply_to:<id>`. CAPTURE IT BEFORE handing a write to a retry queue: a retry runs on the queue's timer,
 * outside the run, so calling this inside the retried closure would drop the tag (or worse, stamp another run).
 * Never put the id in `external_id` (partial UNIQUE index) or a wm note's `correlation_id` (tray merge keys).
 */
export function turnTags(): string[] {
  try { const t = currentTurn(); return t ? [`turn:${t.turnId}`] : []; } catch { return []; }
}

/** The header every Halseth request made inside a run carries (turn-key phase 2). The Worker logs it. */
export const TURN_HEADER = "X-Turn-Id";

/**
 * `init` with X-Turn-Id added when inside a run; `init` untouched (same object) outside one. Accepts the
 * three HeadersInit shapes. A Request input with no init is left alone: an init `headers` would REPLACE the
 * Request's own (auth included).
 */
export function withTurnHeader(input: unknown, init: RequestInit | undefined): RequestInit | undefined {
  let id: string | undefined;
  try { id = currentTurn()?.turnId; } catch { id = undefined; }
  if (!id) return init;
  if (!init && typeof input !== "string" && !(input instanceof URL)) return init;
  const h = init?.headers;
  let headers: HeadersInit;
  if (h instanceof Headers) { const c = new Headers(h); c.set(TURN_HEADER, id); headers = c; }
  else if (Array.isArray(h)) headers = [...h, [TURN_HEADER, id]];
  else headers = { ...(h as Record<string, string> | undefined), [TURN_HEADER]: id };
  return { ...(init ?? {}), headers };
}

/** The stamp for a tagged log line: ` turn=<id>` inside a run, "" outside. Append at the END of the line. */
export function turnToken(): string {
  try { const t = currentTurn(); return t ? ` turn=${t.turnId}` : ""; } catch { return ""; }
}

/**
 * Run an autonomous job (heartbeat, make, interest_offer, consolidation, spouse_note, med) inside its own
 * trace so `currentTurn()` and the stamps work there, and write its hub row at the end. Already inside a
 * run (e.g. a typed dry-run) it just runs: the job belongs to that turn. No `[turn]` line is written
 * (the turn report counts replies); the hub row is.
 */
export async function runAutonomousTurn<T>(
  kind: Exclude<TurnKind, "reply" | "absorb" | "lull_release" | "pass">,
  companionId: string,
  fn: () => Promise<T>,
  opts: { channelId?: string; init?: Partial<TurnTraceInit>; record?: (result: T) => boolean } = {},
): Promise<T> {
  if (currentTurn()) return fn();
  const now = Date.now();
  const trace = new TurnTrace({
    companionId, channelId: opts.channelId ?? "", messageId: "", side: null,
    createdAt: null, enqueuedAt: now, startedAt: now, queueMs: 0, settleMs: 0, gathered: 0, catchup: false,
    kind, quiet: true, ...(opts.init ?? {}),
  });
  return runWithTurn(trace, async () => {
    try {
      const out = await fn();
      trace.setOutcome("ok");
      // A poller that found nothing to do (every-minute Spouse/med ticks) writes no hub row.
      try { if (opts.record && !opts.record(out)) trace.skipHub(); } catch { /* record() must not matter */ }
      return out;
    } catch (e) {
      trace.setOutcome("error");
      throw e;
    } finally {
      trace.emit();
    }
  });
}

/** rail-telemetry hook: a rail that ends a turn names its outcome. `superseded` is check B. */
export function traceRailOutcome(rail: string): void {
  try { currentTurn()?.setOutcome(rail === "superseded" ? "superseded_b" : `skipped:${rail}`); } catch { /* never throws */ }
}

/** Time a Halseth/Librarian call into the ambient turn (sum of call durations; overlapping calls overlap). */
export async function timeHalseth<T>(fn: () => Promise<T>, now: () => number = Date.now): Promise<T> {
  const t = currentTurn();
  if (!t) return fn();
  const t0 = now();
  try { return await fn(); } finally { t.addHalseth(now() - t0); }
}

/** A turn the inbox dropped before it ran (queue backstop): one line, no stages. */
export function emitDroppedTurn(init: Omit<TurnTraceInit, "queueMs" | "settleMs" | "gathered" | "catchup" | "startedAt">, reason: string): void {
  const t = new TurnTrace({ ...init, startedAt: init.enqueuedAt, queueMs: 0, settleMs: 0, gathered: 0, catchup: false });
  t.setOutcome(`skipped:${reason}`);
  t.emit();
}
