import type { Message } from "discord.js";
import type { Attribution } from "./types.js";
import { cleanPronouns, type PkRoster } from "./pk-roster.js";

// PluralKit's Discord application ID -- stable, not subject to change.
// When PluralKit proxies a message via webhook, message.applicationId equals this value.
export const PLURALKIT_APP_ID = "000000000000000069";

export interface PKContext {
  isPluralKit: boolean;
  memberName: string | null; // display name of the fronting system member
}

export function detectPluralKit(message: Message): PKContext {
  if (!message.webhookId) {
    return { isPluralKit: false, memberName: null };
  }
  // applicationId is only populated when Discord attributes the webhook to an application;
  // for a classic webhook execute (which is how PK proxies) it is frequently NULL. So this
  // is a positive signal only -- never treat `false` here as "not PluralKit". The caller
  // combines it with roster identification and the dedup pairing (see isPKProxy in
  // bot-message-handler), which is what actually carries the decision.
  const isPluralKit = message.applicationId === PLURALKIT_APP_ID;
  return {
    isPluralKit,
    memberName: isPluralKit ? (message.author?.username ?? null) : null,
  };
}

interface PendingOriginal {
  messageId: string;
  content: string; // trimmed original content (still carries proxy tags)
  senderId: string;
  skip: boolean;
  ts: number;
  /** Set by a waiting turn; fired the instant a webhook claims this original. */
  notify?: () => void;
}

/**
 * Proxy-tag-tolerant suppression of the direct+webhook message pair PluralKit
 * produces. When PK proxies a message it deletes the user's original and reposts
 * it via webhook with the proxy tag stripped ("cy: hello" -> "hello"). Keying
 * dedup on exact content therefore misses every tag-based proxy, causing both
 * copies to be processed (double reply) and the webhook to lose the captured
 * sender id (identity falls back to guest when the PK API races).
 *
 * Matching is by content *containment* within the same channel: the proxied
 * text is always a contiguous substring of the original, whether the tag is a
 * prefix, suffix, or both. Fully offline -- it does not depend on the PK API,
 * which is exactly what fails in the moments dedup matters most.
 *
 * ORDERING (2026-07-27, load-bearing): `addOriginal` and `matchWebhook` MUST be called at
 * messageCreate event time, never inside a ChannelInbox turn. The inbox serializes turns per
 * channel, so a hold taken inside a turn blocks the very webhook turn it is waiting for --
 * the claim can never arrive, every original is processed as if unproxied, and the webhook
 * loses the captured sender id. Only the *decision* belongs in the turn, via `waitForClaim`.
 */
// Longest plausible PluralKit proxy tag including brackets/spaces. Containment
// matches are rejected when the original is longer than the webhook by more than
// this, so a short proxied message ("ok") can't be swallowed by an unrelated
// long pending message that merely contains it.
const PK_TAG_BUDGET = 16;

export class PkDedup {
  private byChannel = new Map<string, PendingOriginal[]>();
  constructor(private readonly holdMs = 3000) {}

  /** Record a direct (non-webhook) message that may shortly be proxied by PK. */
  addOriginal(channelId: string, messageId: string, content: string, senderId: string): void {
    this.prune();
    const list = this.byChannel.get(channelId) ?? [];
    list.push({ messageId, content: content.trim(), senderId, skip: false, ts: Date.now() });
    this.byChannel.set(channelId, list);
  }

  /**
   * Called when a webhook arrives. If it matches an un-consumed pending original
   * in the same channel (by containment), marks that original to be skipped and
   * returns the captured sender id so the webhook can attribute correctly even
   * if the PK API is slow or down. Returns null when there is no match.
   */
  matchWebhook(channelId: string, webhookContent: string): { senderId: string; originalId: string } | null {
    const text = webhookContent.trim();
    if (!text) return null; // image-only proxy: cannot match safely, never dedup-all
    const list = this.byChannel.get(channelId);
    if (!list) return null;
    // Newest first so rapid identical messages pair in send order.
    for (let i = list.length - 1; i >= 0; i--) {
      const o = list[i]!;
      if (!o.skip && o.content.includes(text) && o.content.length - text.length <= PK_TAG_BUDGET) {
        o.skip = true;
        o.notify?.(); // release a turn already waiting on this original
        return { senderId: o.senderId, originalId: o.messageId };
      }
    }
    return null;
  }

  /** After the hold window, report whether the original was claimed by a proxy, then forget it. */
  resolveOriginal(channelId: string, messageId: string): { skip: boolean } {
    const list = this.byChannel.get(channelId);
    if (!list) return { skip: false };
    const idx = list.findIndex((o) => o.messageId === messageId);
    if (idx === -1) return { skip: false };
    const [removed] = list.splice(idx, 1);
    if (list.length === 0) this.byChannel.delete(channelId);
    return { skip: removed!.skip };
  }

  /**
   * Wait for this original to be claimed by a proxy, releasing the moment it is (or as soon
   * as the claim is found to have already happened, which is the common case when the queue
   * was busy). Falls through after `timeoutMs` and reports the original as unproxied.
   *
   * This is the only part of pairing that may run inside a serialized inbox turn.
   */
  waitForClaim(channelId: string, messageId: string, timeoutMs: number): Promise<{ skip: boolean }> {
    const list = this.byChannel.get(channelId);
    const entry = list?.find((o) => o.messageId === messageId);
    // Never registered (or already pruned): nothing can claim it -- treat as unproxied.
    if (!entry) return Promise.resolve({ skip: false });
    // Claim already landed while this turn was queued behind another: no wait at all.
    if (entry.skip) return Promise.resolve(this.resolveOriginal(channelId, messageId));

    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        delete entry.notify;
        resolve(this.resolveOriginal(channelId, messageId));
      };
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      entry.notify = finish;
    });
  }

  /**
   * Bound the map. Claimed-but-unresolved and still-waiting entries are kept far longer than
   * the hold window on purpose: under hermes a queued turn can start minutes after its
   * message arrived, and pruning its entry first would silently restore the double-process
   * bug. A per-channel cap is the real backstop against unbounded growth.
   */
  private prune(): void {
    const cutoff = Date.now() - PK_PENDING_TTL_MS;
    for (const [ch, list] of this.byChannel) {
      const kept = list.filter((o) => o.ts >= cutoff);
      const capped = kept.length > PK_PENDING_CAP ? kept.slice(kept.length - PK_PENDING_CAP) : kept;
      if (capped.length) this.byChannel.set(ch, capped);
      else this.byChannel.delete(ch);
    }
  }
}

/** How long an unresolved original stays claimable -- must exceed the worst inbox backlog. */
const PK_PENDING_TTL_MS = 10 * 60 * 1000;
/** Hard per-channel bound so a wedged worker can't grow the map without limit. */
const PK_PENDING_CAP = 50;

interface IngestMessage {
  id: string;
  channelId: string;
  content: string;
  webhookId: string | null;
  authorId: string;
  authorIsBot: boolean;
}

/**
 * Register/claim half of PK pairing. MUST be called at messageCreate event time, before the
 * message is handed to the channel inbox -- see the ordering note on PkDedup.
 *
 * Returns the sender id recovered from the matching original for a webhook message, so
 * attribution has a certain, offline answer even when the PK API races or is down.
 */
export function pkIngestAtEvent(message: IngestMessage, dedup: PkDedup): { pkSenderId?: string; pkOriginalId?: string } {
  if (message.webhookId) {
    const match = dedup.matchWebhook(message.channelId, message.content);
    return match ? { pkSenderId: match.senderId, pkOriginalId: match.originalId } : {};
  }
  if (!message.authorIsBot) {
    dedup.addOriginal(message.channelId, message.id, message.content, message.authorId);
  }
  return {};
}

// ---------------------------------------------------------------------------------------------
// Per-message PluralKit verification (2026-11-10, owner-impersonation follow-up).
//
// The roster is a HINT, not proof: a guest's REAL PluralKit member (another system, so the webhook
// genuinely is PluralKit's) can carry a name identical to one of the owner's members. Only
// GET /v2/messages/{id} says which system proxied a message, so a roster hit confers a tier only
// once that lookup confirms the message's system (or sender account) is the roster member's own.
//
// One lookup per message per process: lookups are de-duplicated in flight and successful answers
// are cached (bounded, TTL), so the event-time prefetch, the turn's resolveAttribution and every
// synchronous label/side caller share a single API call. Only 200s are cached: a 404 at arrival is
// usually PK's own write race, and caching it would pin a wrong verdict for the message's lifetime.
// The cache is keyed per fetch implementation so injected test fetches never share state.
// ---------------------------------------------------------------------------------------------

export interface PkMessageInfo {
  /** Discord user id of the account that triggered the proxy. */
  sender: string;
  /** PK system short id (hid) and uuid of the proxying system; null when PK omits it. */
  systemId: string | null;
  systemUuid: string | null;
  memberName: string | null;
  memberPronouns: string | null;
}

export type PkLookup =
  | { status: "found"; info: PkMessageInfo }
  /** 404 on every attempt: not (yet) a PK message. */
  | { status: "absent" }
  /** Timeout, network error or a non-404 failure on at least one attempt, and no success. */
  | { status: "unreachable" };

const PK_MSG_TTL_MS = 6 * 60 * 60 * 1000;
const PK_MSG_CACHE_MAX = 2000;
/** Event-time prefetch waits this long before its first attempt so it does not lose PK's write race. */
export const PK_PREFETCH_DELAY_MS = 800;

class PkMessageVerifier {
  private found = new Map<string, { at: number; info: PkMessageInfo }>();
  private inflight = new Map<string, Promise<PkLookup>>();
  constructor(private readonly fetchFn: typeof fetch) {}

  peek(id: string): PkMessageInfo | null {
    const hit = this.found.get(id);
    if (!hit) return null;
    if (Date.now() - hit.at > PK_MSG_TTL_MS) { this.found.delete(id); return null; }
    return hit.info;
  }

  remember(id: string, info: PkMessageInfo): void {
    this.found.delete(id);
    this.found.set(id, { at: Date.now(), info });
    while (this.found.size > PK_MSG_CACHE_MAX) {
      const oldest = this.found.keys().next().value;
      if (oldest === undefined) break;
      this.found.delete(oldest);
    }
  }

  lookup(id: string, delayMs = 0): Promise<PkLookup> {
    const cached = this.peek(id);
    if (cached) return Promise.resolve({ status: "found", info: cached });
    const running = this.inflight.get(id);
    if (running) return running;
    const p = this.run(id, delayMs).finally(() => { this.inflight.delete(id); });
    this.inflight.set(id, p);
    return p;
  }

  private async run(id: string, delayMs: number): Promise<PkLookup> {
    if (delayMs > 0) await new Promise<void>((r) => { const t = setTimeout(r, delayMs); t.unref?.(); });
    let only404 = true;
    // Two attempts (2026-07-27): PK creates the /v2/messages record just *after* dispatching
    // the webhook, so a single shot at arrival loses a real race.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise<void>((r) => setTimeout(r, 400));
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const res = await this.fetchFn(
          `https://api.pluralkit.me/v2/messages/${id}`,
          { signal: controller.signal },
        ).finally(() => clearTimeout(timeout));
        if (res.ok) {
          const pk = await res.json() as {
            sender?: unknown;
            member?: { name?: unknown; pronouns?: unknown } | null;
            system?: { id?: unknown; uuid?: unknown } | null;
          };
          const info: PkMessageInfo = {
            sender: typeof pk?.sender === "string" ? pk.sender : "",
            systemId: typeof pk?.system?.id === "string" ? pk.system.id : null,
            systemUuid: typeof pk?.system?.uuid === "string" ? pk.system.uuid : null,
            memberName: typeof pk?.member?.name === "string" ? pk.member.name : null,
            memberPronouns: cleanPronouns(pk?.member?.pronouns),
          };
          this.remember(id, info);
          return { status: "found", info };
        }
        if (res.status !== 404) only404 = false;
      } catch {
        only404 = false; // timeout or network error
      }
    }
    return only404 ? { status: "absent" } : { status: "unreachable" };
  }
}

const verifiers = new WeakMap<object, PkMessageVerifier>();
function verifierFor(fetchFn: typeof fetch): PkMessageVerifier {
  let v = verifiers.get(fetchFn);
  if (!v) { v = new PkMessageVerifier(fetchFn); verifiers.set(fetchFn, v); }
  return v;
}

/** Look a proxied message up on PK's API (de-duplicated in flight, success-cached). */
export function lookupPkMessage(messageId: string, fetchFn: typeof fetch = globalThis.fetch, delayMs = 0): Promise<PkLookup> {
  return verifierFor(fetchFn).lookup(messageId, delayMs);
}

/** Synchronous read of an already-verified message; null when it has not been verified (yet). */
export function peekPkMessage(messageId: string, fetchFn: typeof fetch = globalThis.fetch): PkMessageInfo | null {
  return verifierFor(fetchFn).peek(messageId);
}

/** Seed the cache with a known answer (tests stand in for a completed lookup with it). */
export function primePkMessage(messageId: string, info: PkMessageInfo, fetchFn: typeof fetch = globalThis.fetch): void {
  verifierFor(fetchFn).remember(messageId, info);
}

/** A webhook whose app id is PluralKit's or unattributed (null) may be a PK proxy; any other app id cannot. */
export function mayBePkWebhook(m: { webhookId?: string | null; applicationId?: string | null }): boolean {
  if (!m.webhookId) return false;
  const app = m.applicationId ?? null;
  return app === null || app === PLURALKIT_APP_ID;
}

/**
 * Start the PK lookup at messageCreate time (fire-and-forget) so the turn awaits a promise that is
 * already running instead of paying the round trip itself, and so history/side callers later find
 * the message verified. Delayed slightly so the first attempt does not race PK's own write.
 * Never awaited by the caller; never throws.
 */
export function prefetchPkMessage(
  m: { id: string; webhookId?: string | null; applicationId?: string | null },
  fetchFn: typeof fetch = globalThis.fetch,
): void {
  if (!mayBePkWebhook(m)) return;
  void lookupPkMessage(m.id, fetchFn, PK_PREFETCH_DELAY_MS).catch(() => undefined);
}

/** PK shows hids uppercase and 6-char ones split by a dash ("EXA-MPL"); compare case- and dash-free. */
function normPkId(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/-/g, "").trim();
}

/** Does a verified PK message belong to this roster member's system (or account)? */
export function pkMessageMatchesMember(
  info: PkMessageInfo,
  member: { systemId: string; discordUserId: string },
): boolean {
  const want = normPkId(member.systemId);
  if (want && (normPkId(info.systemId) === want || normPkId(info.systemUuid) === want)) return true;
  return !!info.sender && info.sender === member.discordUserId;
}

/** The roster surface the verified helper needs (PkRoster satisfies it). */
export interface RosterLike<M extends { systemId: string; discordUserId: string }> {
  identify(name: string | null | undefined): M | null;
}

/**
 * THE way to turn a webhook username into a roster identity outside resolveAttribution. A name is
 * a hint: it counts only for a webhook that may be PluralKit's (never another app's) AND whose
 * message PK's API has already confirmed belongs to that member's system. Synchronous (reads the
 * verification cache); a message not verified yet is null, i.e. unknown, never a guessed tier.
 */
export function verifiedRosterMember<M extends { systemId: string; discordUserId: string }>(
  m: { id: string; webhookId?: string | null; applicationId?: string | null; author?: { username?: string | null } | null },
  roster: RosterLike<M> | null | undefined,
  fetchFn: typeof fetch = globalThis.fetch,
): M | null {
  if (!roster || !mayBePkWebhook(m)) return null;
  const member = roster.identify(m.author?.username ?? null);
  if (!member) return null;
  const info = peekPkMessage(m.id, fetchFn);
  return info && pkMessageMatchesMember(info, member) ? member : null;
}

/** One `[pk-appid]` token for a PK-webhook message: was Discord's applicationId null, PluralKit's, or another app's? */
export function pkAppIdKind(m: { applicationId?: string | null }): "null" | "pk" | "other" {
  const app = m.applicationId ?? null;
  return app === null ? "null" : app === PLURALKIT_APP_ID ? "pk" : "other";
}

interface DiscordMessage {
  id: string;
  webhookId: string | null;
  /** Discord application that owns the webhook; null/undefined when Discord does not attribute it. */
  applicationId?: string | null;
  author: { id: string; bot: boolean; username?: string };
}

export async function resolveAttribution(
  message: DiscordMessage,
  ownerDiscordId: string,
  knownSenderId?: string,
  fetchFn: typeof fetch = globalThis.fetch,
  spouseDiscordId?: string,
  spousePkSystemId?: string,
  roster?: PkRoster | null,
): Promise<Attribution> {
  if (!message.webhookId) {
    return {
      isOwner: message.author.id === ownerDiscordId,
      discordUserId: message.author.id,
      frontMember: null,
      frontState: "unknown",
      source: "direct",
    };
  }

  // Owner-impersonation guard (2026-11-10). A webhook's display name is attacker-controlled
  // (any webhook owner, another proxy bot, a guest's PK member), so a name never confers a tier
  // on its own. Three cases on message.applicationId:
  //   - another app id: provably NOT PK -> guest/unknown, no roster, no PK API, no dedup sender.
  //   - PK's app id: a real PK proxy, but from WHICH system is unknown -- a guest's real member can
  //     share an owner member's name. The roster name is a hint; /v2/messages must confirm the
  //     message's system before the hint's tier is granted.
  //   - null/absent: classic webhook executes often leave it null even for real PK proxies
  //     (see detectPluralKit). No roster hint; /v2/messages decides.
  const appId = message.applicationId ?? null;
  if (appId !== null && appId !== PLURALKIT_APP_ID) {
    return {
      isOwner: false,
      discordUserId: "unknown",
      frontMember: null,
      frontState: "unknown",
      source: "fallback",
    };
  }
  const hint = appId === PLURALKIT_APP_ID ? (roster?.identify(message.author.username) ?? null) : null;

  const looked = await lookupPkMessage(message.id, fetchFn);
  if (looked.status === "found") {
    const pk = looked.info;
    // Verified roster hit: the roster's display name and pronouns (what PK rendered on screen),
    // the API's word on whose message it is.
    if (hint && pkMessageMatchesMember(pk, hint)) {
      return {
        isOwner: hint.isOwner,
        discordUserId: hint.discordUserId,
        frontMember: hint.memberName,
        frontPronouns: hint.pronouns ?? null,
        frontState: "known",
        source: "pluralkit",
      };
    }
    if (pk.sender === ownerDiscordId) {
      return {
        isOwner: true,
        discordUserId: pk.sender,
        frontMember: pk.memberName,
        frontPronouns: pk.memberPronouns,
        frontState: "known",
        source: "pluralkit",
      };
    }
    // Spouse's system: match by Discord ID or PK system ID (belt-and-suspenders).
    const spouseSys = normPkId(spousePkSystemId);
    const isSpouse = (spouseDiscordId && pk.sender === spouseDiscordId)
      || (spouseSys && (normPkId(pk.systemId) === spouseSys || normPkId(pk.systemUuid) === spouseSys));
    return {
      isOwner: false,
      discordUserId: isSpouse ? (spouseDiscordId ?? pk.sender) : (pk.sender || "unknown"),
      frontMember: pk.memberName,
      frontPronouns: pk.memberPronouns,
      frontState: "known",
      source: "pluralkit",
    };
  }

  // API down, timed out, or 404 on both attempts. Same policy as the null-app-id path: FAIL CLOSED
  // on the name. The only offline proof of who sent a proxy is the dedup pairing (the sender id of
  // the original PK deleted), so the tier comes from that alone. When the pairing names the very
  // account the roster hint belongs to, the hint's member name is kept for addressing.
  // Never assume owner -- misattribution (a guest treated as owner) is worse than a missed
  // response (owner treated as guest, can retry).
  const senderId = knownSenderId ?? "unknown";
  const agreed = hint && knownSenderId !== undefined && hint.discordUserId === knownSenderId ? hint : null;
  return {
    isOwner: senderId === ownerDiscordId,
    discordUserId: senderId,
    frontMember: agreed ? agreed.memberName : null,
    ...(agreed ? { frontPronouns: agreed.pronouns ?? null } : {}),
    frontState: agreed ? "known" : "unknown",
    source: "fallback",
  };
}
