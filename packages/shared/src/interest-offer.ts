// interest-offer.ts -- the night's candidate interest put to the companion at their own-time slot (B65 step 5,
// 2026-11-09). Spec: BBH Hand-off/SPEC-B65-the-drive-2026-11-09.md section 2.4; Halseth side mig 0178 +
// handlers/interest-births.ts.
//
// Halseth's nightly pass notices the words that keep recurring in what a companion encountered and writes ONE
// candidate. Here, right after the make slot (Dre 03:30, Cy 04:30 Chicago), the companion is asked once:
// "Something keeps coming back in what you have been reading: <term>. Is it yours?" They answer in their own
// words with the existing born verb ("new interest: <name>, because <why>"), or "not mine: <term>", or
// anything else, which is silence: nothing is written and it is not asked again (Drevan: silence-default
// expiry is right). Keeping it is Halseth's `born` with born_from = 'exposure:<candidate id>'; the name and the
// why are the companion's, the term was only the prompt.
//
// The offer is NOT folded into the make prompt (guard 3's shadow promise is a byte-identical make prompt, and
// the two reply grammars must not mix) and is NOT behind the make slot's skips (a flat night or a recent make
// is no reason to swallow the question). It never runs while Principal is active, never posts to Discord, and
// serves nothing unless Halseth is in INTEREST_BIRTHS=on (shadow answers with no candidate). INTEREST_OFFER=off
// is the bot-side kill switch. Gaia has no own-time slot and makes nothing; her kept-line offer waits on hers.
// Logs carry ids, outcomes and counts only, never generated text.

import type { AutonomousContext } from "./autonomous-core.js";
import { skipIfActive } from "./autonomous-core.js";
import type { FetchLike } from "./make-move.js";
import { runAutonomousTurn } from "./turn-telemetry.js";

export type InterestOfferMode = "off" | "on";

/** off/0/false/no = off; anything else (unset, junk) = on. The real gate is Halseth's INTEREST_BIRTHS. */
export function interestOfferMode(env: NodeJS.ProcessEnv = process.env): InterestOfferMode {
  const v = String(env["INTEREST_OFFER"] ?? "").trim().toLowerCase();
  return v === "off" || v === "0" || v === "false" || v === "no" ? "off" : "on";
}

export interface OfferCandidate { id: string; term: string; created_at?: string; offered_at?: string | null }

/** The one line put to the companion. Both answers are spelled out exactly; anything else passes. */
export function offerPrompt(term: string): string {
  return `Something keeps coming back in what you have been reading: ${term}. Is it yours? ` +
    `If it is, answer exactly "new interest: <your name for it>, because <why>" (your words, your reason). ` +
    `If not, answer exactly "not mine: ${term}" (add ", because <why>" if you want the reason on record). ` +
    `Anything else passes: it will not be asked again, and nothing is written.`;
}

export type OfferAnswer =
  | { kind: "kept"; name: string; why: string }
  | { kind: "declined"; why: string }
  | { kind: "silence" };

const BORN_RE = /^(?:please\s+)?new\s+interest\s*:\s*((?:(?!\bbecause\b)[\s\S])+?)\s*[,;:]?\s+because\b[\s,:]*([\s\S]+)$/i;
const NOT_MINE_RE = /^(?:please\s+)?not\s+mine\s*:\s*([\s\S]+?)(?:\s*[,;:]?\s+because\b[\s,:]*([\s\S]+))?\s*[.!]?$/i;

const unquote = (s: string): string => s.trim().replace(/^["'`*_]+|["'`*_]+$/g, "").replace(/\s+/g, " ").trim();

/**
 * Read the companion's reply. The first line that is one of the two answers wins (they may wrap it in a
 * sentence or two); a reply with neither is silence. A kept answer with an empty name or why is silence too:
 * the system never fills in their words.
 */
export function parseOfferAnswer(reply: string): OfferAnswer {
  for (const raw of reply.split(/\r?\n/)) {
    const line = raw.replace(/^\s*[-*>]\s*/, "").trim();
    if (!line) continue;
    const b = BORN_RE.exec(line);
    if (b) {
      const name = unquote(b[1]!).slice(0, 80);
      const why = b[2]!.trim().replace(/[.!]+$/, "").slice(0, 500);
      if (name && why) return { kind: "kept", name, why };
      continue;
    }
    const n = NOT_MINE_RE.exec(line);
    if (n) return { kind: "declined", why: (n[2] ?? "").trim().slice(0, 500) };
  }
  return { kind: "silence" };
}

export interface InterestOfferResult {
  outcome: "skip:off" | "skip:no_halseth_url" | "skip:active" | "none" | "kept" | "declined" | "silence" | "answer_refused" | "error";
  candidateId?: string;
}

/** The log line: outcome and ids only. */
export function offerLogLine(companionId: string, r: InterestOfferResult): string {
  return `[interest-offer] ${companionId} outcome=${r.outcome}${r.candidateId ? ` candidate=${r.candidateId.slice(0, 8)}` : ""}`;
}

export function runInterestOffer(
  ctx: AutonomousContext,
  opts: { env?: NodeJS.ProcessEnv; fetchFn?: FetchLike; generate?: (prompt: string) => Promise<string> } = {},
): Promise<InterestOfferResult> {
  return runAutonomousTurn("interest_offer", ctx.companionId, () => runInterestOfferBody(ctx, opts));
}

async function runInterestOfferBody(
  ctx: AutonomousContext,
  opts: { env?: NodeJS.ProcessEnv; fetchFn?: FetchLike; generate?: (prompt: string) => Promise<string> },
): Promise<InterestOfferResult> {
  const id = ctx.companionId;
  const env = opts.env ?? process.env;
  const fetchFn = opts.fetchFn ?? fetch;
  const done = (r: InterestOfferResult): InterestOfferResult => { console.log(offerLogLine(id, r)); return r; };
  try {
    if (interestOfferMode(env) === "off") return done({ outcome: "skip:off" });
    const url = (env["HALSETH_URL"] ?? "").replace(/\/$/, "");
    if (!url) return done({ outcome: "skip:no_halseth_url" });
    if (skipIfActive(ctx, "interest-offer")) return done({ outcome: "skip:active" });
    const headers = { Authorization: `Bearer ${ctx.halsethSecret}`, "Content-Type": "application/json" };

    const res = await fetchFn(`${url}/mind/interest-candidates/${encodeURIComponent(id)}?pending=1`, { headers, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return done({ outcome: "error" });
    const body = (await res.json()) as { candidate?: OfferCandidate | null };
    const cand = body?.candidate;
    if (!cand || typeof cand.id !== "string" || typeof cand.term !== "string" || !cand.term) return done({ outcome: "none" });

    const generate = opts.generate ?? ((p: string) => ctx.inference.generate(ctx.bootCtx.systemPrompt, [{ role: "user", content: p }]));
    const reply = await generate(offerPrompt(cand.term));
    const answer = parseOfferAnswer(String(reply ?? ""));
    if (answer.kind === "silence") return done({ outcome: "silence", candidateId: cand.id });

    const payload = answer.kind === "kept"
      ? { companion_id: id, answer: "kept", name: answer.name, why: answer.why }
      : { companion_id: id, answer: "declined", why: answer.why };
    const post = await fetchFn(`${url}/mind/interest-candidates/${encodeURIComponent(cand.id)}/answer`, {
      method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(8_000),
    });
    if (!post.ok) return done({ outcome: "answer_refused", candidateId: cand.id });
    return done({ outcome: answer.kind, candidateId: cand.id });
  } catch (e) {
    console.log(`[interest-offer] ${id} outcome=error err=${e instanceof Error ? e.name : "unknown"}`);
    return { outcome: "error" };
  }
}
