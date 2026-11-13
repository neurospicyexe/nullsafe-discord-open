// packages/shared/src/sol-reply.ts
//
// B64.1 (2026-11-08): a reply to a Sol post is a tend. Spec: BBH
// docs/superpowers/specs/2026-11-08-sol-replies-and-no-repeat.md, Part B "Bots".
//
// Measured 11-08: one fixed appearance line posted 9 times in 30 days. Answering Sol recorded no tend,
// so his mood never moved and the same mood kept drawing the same line. Now a message ANSWERING Sol
// reports to Halseth `POST /mind/creatures/:id/reply { actor, ref, text }`, which classifies tone,
// records one `talk` tend per (creature, actor, Sol post) and drops the text.
//
// What counts (pure, `solReplyRef`): a Discord reply to a message Sol posted, OR a message in the same
// channel within 30 minutes after Sol's latest post there that names him (`\bsol\b`, any case). Talk
// ABOUT Sol elsewhere, or after the window, is not a reply.
//
// Who reports (pure, `solReplyActor`): Principal's own account (the existing owner check, `ownerDiscordId`;
// a PluralKit original arrives from it before PK deletes and reproxies it, so his PK-fronted replies
// count once through the original), and this bot's OWN posts with its own companion id. A sibling's post
// is the sibling's to report; every bot may report Principal's, Halseth dedupes per actor + post.
//
// Sol's posts are recognized by webhook id (sol-sender.ts), never the name. The text goes to Halseth
// only, capped; no log line here ever prints it.

import { isSolPost } from "./sol-sender.js";
import { buildCommandTriggers, COMPANION_ALIASES } from "./command-triggers.js";

export const SOL_REPLY_WINDOW_MS = 30 * 60_000;
export type SolReplyActor = "principal" | "cypher" | "drevan" | "gaia";
const TRIAD = new Set<string>(["cypher", "drevan", "gaia"]);
const SOL_NAME_RE = /\bsol\b/i;
/** Halseth caps the tone input at 500; sending more is only more text in transit. */
const TEXT_CAP = 500;

export interface SolPostSeen { id: string; at: number }
export interface SolReplyState {
  latestByChannel: ReadonlyMap<string, SolPostSeen>;
  knownPosts: ReadonlySet<string>;
}

/** In-memory: channel -> Sol's latest post there, plus a bounded set of recent Sol post ids. */
export class SolPostTracker {
  private readonly latest = new Map<string, SolPostSeen>();
  private readonly known = new Set<string>();
  constructor(private readonly cap = 500) {}

  noteSolPost(channelId: string, id: string, at: number): void {
    const cur = this.latest.get(channelId);
    if (!cur || at >= cur.at) this.latest.set(channelId, { id, at });
    this.known.delete(id);
    this.known.add(id);
    while (this.known.size > this.cap) {
      const oldest = this.known.values().next().value as string;
      this.known.delete(oldest);
    }
  }

  state(): SolReplyState {
    return { latestByChannel: this.latest, knownPosts: this.known };
  }
}

export interface SolReplyCandidate {
  channelId: string;
  content: string;
  /** The Discord reply reference, if any. `webhookId` is the referenced message's, when known. */
  replyTo?: { messageId: string; webhookId?: string | null } | null;
}

/**
 * The Sol post this message answers (its Discord message id, the `ref`), or null when it does not
 * qualify. `now` is the message's own time.
 */
export function solReplyRef(m: SolReplyCandidate, s: SolReplyState, solId: string | null, now: number): string | null {
  const r = m.replyTo;
  if (r?.messageId && (s.knownPosts.has(r.messageId) || (!!solId && r.webhookId === solId))) return r.messageId;
  const latest = s.latestByChannel.get(m.channelId);
  if (!latest) return null;
  const age = now - latest.at;
  if (age < 0 || age > SOL_REPLY_WINDOW_MS) return null;
  return SOL_NAME_RE.test(m.content ?? "") ? latest.id : null;
}

/** Who this bot may report a reply-tend for: Principal (own account), itself, or nobody. */
export function solReplyActor(
  m: { authorId: string; webhookId: string | null },
  ids: { ownerId?: string | null; selfId?: string | null; companionId: string; solId: string | null },
): SolReplyActor | null {
  if (isSolPost(m, ids.solId)) return null;
  if (m.webhookId) return null; // PK proxies and other webhooks: the PK original already counted
  if (ids.ownerId && m.authorId === ids.ownerId) return "principal";
  if (ids.selfId && m.authorId === ids.selfId && TRIAD.has(ids.companionId)) return ids.companionId as SolReplyActor;
  return null;
}

// Commands are not replies. `<alias>: pet Sol feed` already records a hand tend through the command
// path, and the answering bot's acknowledgement names him too: counting either would make one act of
// care two or three tends. A command-shaped line (any companion's guard) is never reported, and this
// bot's own posts in that channel within COMMAND_ACK_WINDOW_MS after one are its acknowledgement.
export const COMMAND_ACK_WINDOW_MS = 2 * 60_000;
const COMMAND_GUARDS = Object.values(COMPANION_ALIASES).map((a) => buildCommandTriggers(a).guard);
export function isCompanionCommand(content: string): boolean {
  const t = (content ?? "").trim();
  return COMMAND_GUARDS.some((g) => g.test(t));
}

// Own posts that were themselves a tend (the heartbeat's tend_creature records an interact before it
// posts): reporting them again would double-count one act of care. Marked by message id at send time.
const tendPosts = new Set<string>();
export function markSolTendPost(messageId: string): void {
  tendPosts.add(messageId);
  while (tendPosts.size > 200) tendPosts.delete(tendPosts.values().next().value as string);
}
export function isSolTendPost(messageId: string): boolean {
  return tendPosts.has(messageId);
}

export interface SolReplyMessage {
  id: string;
  channelId: string;
  authorId: string;
  webhookId: string | null;
  content: string;
  createdAt: number;
  referenceMessageId?: string | null;
}

export interface SolReplyReporterDeps {
  companionId: string;
  ownerDiscordId?: string | null;
  selfUserId: () => string | null | undefined;
  solId: string | null;
  tracker: SolPostTracker;
  resolveCreatureId: () => Promise<string | null>;
  post: (creatureId: string, actor: SolReplyActor, ref: string, text: string) => Promise<{ recorded: boolean; reason?: string }>;
  /** Look up the webhook id of a replied-to message this process never saw (it may predate a restart). */
  fetchReferenceWebhookId?: (m: SolReplyMessage) => Promise<string | null>;
  /**
   * Own posts wait this long before the check, so a send path's onSent mark (markSolTendPost) lands
   * first: the gateway's MessageCreate can beat the REST reply that carries the id.
   */
  ownDelayMs?: number;
  log?: (line: string) => void;
}

/**
 * Called for every non-Sol message at MessageCreate time. Never throws, never blocks a turn
 * (bot-core does not await it). Fire-and-forget with catch.
 */
export function createSolReplyReporter(d: SolReplyReporterDeps) {
  const log = d.log ?? ((l: string) => console.log(l));
  const ownDelayMs = d.ownDelayMs ?? 3000;
  const lastCommandAt = new Map<string, number>();

  async function onMessage(m: SolReplyMessage): Promise<void> {
    try {
      if (!d.solId) return;
      if (isCompanionCommand(m.content)) {
        lastCommandAt.set(m.channelId, m.createdAt);
        return;
      }
      const cmdAt = lastCommandAt.get(m.channelId);
      const actor = solReplyActor(m, { ownerId: d.ownerDiscordId, selfId: d.selfUserId(), companionId: d.companionId, solId: d.solId });
      if (!actor) return;
      if (actor !== "principal") {
        if (cmdAt !== undefined && m.createdAt >= cmdAt && m.createdAt - cmdAt <= COMMAND_ACK_WINDOW_MS) return;
        if (ownDelayMs > 0) await new Promise((res) => setTimeout(res, ownDelayMs));
        if (isSolTendPost(m.id)) return;
      }
      const state = d.tracker.state();
      let replyTo: SolReplyCandidate["replyTo"] = m.referenceMessageId ? { messageId: m.referenceMessageId } : null;
      if (replyTo && !state.knownPosts.has(replyTo.messageId) && d.fetchReferenceWebhookId) {
        const hook = await d.fetchReferenceWebhookId(m).catch(() => null);
        replyTo = { messageId: replyTo.messageId, webhookId: hook };
      }
      const ref = solReplyRef({ channelId: m.channelId, content: m.content, replyTo }, state, d.solId, m.createdAt);
      if (!ref) return;
      const creatureId = await d.resolveCreatureId().catch(() => null);
      if (!creatureId) {
        log(`[sol-reply] ${d.companionId} actor=${actor} ref=${ref} ch=${m.channelId} msg=${m.id} skipped=no_creature`);
        return;
      }
      const res = await d.post(creatureId, actor, ref, (m.content ?? "").slice(0, TEXT_CAP));
      log(`[sol-reply] ${d.companionId} actor=${actor} ref=${ref} ch=${m.channelId} msg=${m.id} recorded=${res.recorded}${res.reason ? ` reason=${res.reason}` : ""}`);
    } catch (e) {
      log(`[sol-reply] ${d.companionId} msg=${m.id} failed: ${e instanceof Error ? e.name : "error"}`);
    }
  }

  return { onMessage };
}

/** Sol's creature id, resolved by name like every other caller (`creaturesList`, name "Sol"), cached. */
export function cachedSolCreatureId(
  list: () => Promise<Array<{ id: string; name: string }>>,
  ttlMs = 6 * 3_600_000,
  now: () => number = Date.now,
): () => Promise<string | null> {
  let cached: { id: string; at: number } | null = null;
  return async () => {
    if (cached && now() - cached.at < ttlMs) return cached.id;
    const all = await list().catch(() => []);
    const sol = all.find((c) => c.name === "Sol");
    if (!sol) return null; // a miss is never cached
    cached = { id: sol.id, at: now() };
    return sol.id;
  };
}
