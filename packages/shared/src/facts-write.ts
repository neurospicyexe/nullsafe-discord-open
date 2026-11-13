// Facts Principal STATES in Discord get a write path (GAP-MAP A3, 2026-11-11, Principal approved).
//
// WHY. `architect_facts` got 0 Principal-sourced rows in the 14 days before this: the writeback gate
// writes only companion_note / witness_log / thread_open, in the companion's voice, as tray drafts
// (Drevan keeps ~2%). "No, Hope is the dog; PersonP was a friend" was said in a room and reached
// nothing the facts picker (facts-pick.ts) reads. This is the "stated fact about Principal's life"
// kind: when PRINCIPAL (the owner; never Spouse, a guest, a sibling or Sol) states something new and
// durable about their life, people, pets, plans or preferences, or corrects a wrong belief, the
// companion that answered PROPOSES an architect_facts row. Halseth lands it `open` (the review
// state Hearth /facts already lists with Confirm / Retire / Fix), trust 0.5, provenance in
// `source`; a correction points at the fact it would replace and retires it only on confirm
// (halseth lib/architect-fact-proposal.ts, POST /identity/architect-facts/proposals).
//
// HARD GUARD, at classification AND at write: no meds, care, health, biometrics, symptoms,
// diagnoses or body states ever become a fact (BBH memory "no care or health in room supply": a
// model speaks what it is fed as itself, and a fact flows to all three on every surface).
//   1. lexical, on Principal's line BEFORE any model call: the two existing bot-side guards
//      (`containsHealthTerm` from spouse-note.ts, `looksHealthRelated` from frame-packet.ts) plus the
//      body-state / diagnosis list below (mirrored in halseth; two repos, change both);
//   2. Jev `about_health` noul >= FACTS_WRITE_HEALTH_P (0.3) drops it; a Jev failure drops it
//      (fail CLOSED: this path never writes on a guess);
//   3. lexical again on the AUTHORED fact text;
//   4. Halseth refuses it again at write (factProposalCareCategory), whatever the bot decided.
//
// KNOB `FACTS_WRITE` off | shadow | on, CODE DEFAULT shadow (junk = shadow); `FACTS_WRITE_<COMPANION>`
// wins per bot. off = nothing runs (no Jev, no model, no log). shadow = classify + author, then ONE
// `[facts-write] would=propose ...` line (codes, ids, numbers; never text) and nothing is written.
// on = the proposal is POSTed. Separate Jev call from the writeback gate's: the writeback Jev request
// is byte-identical in every mode (its thetas were calibrated on its own questions).

import type { InferenceAdapter } from "./inference.js";
import type { WritebackSpeaker } from "./memory.js";
import { postJev, type JevAnswers, type JevEvalResult, type JevRequest, type JevPostOpts } from "./jev-gate.js";
import { containsHealthTerm } from "./spouse-note.js";
import { looksHealthRelated } from "./frame-packet.js";
import { isLowInfo } from "./low-info.js";
import { extractJson } from "./json-extract.js";

export type FactsWriteMode = "off" | "shadow" | "on";

export function factsWriteMode(companionId: string, env: NodeJS.ProcessEnv = process.env): FactsWriteMode {
  const per = env[`FACTS_WRITE_${companionId.toUpperCase()}`];
  const raw = (per !== undefined && per.trim() !== "" ? per : env.FACTS_WRITE ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false" || raw === "no") return "off";
  if (raw === "on") return "on";
  return "shadow";
}

function num(env: NodeJS.ProcessEnv, key: string, dflt: number): number {
  const v = Number(env[key]);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : dflt;
}

// Body states, symptoms and diagnoses the two existing guards do not carry. Mirrored in halseth
// `lib/architect-fact-proposal.ts` (FACT_BODY_RE / FACT_DIAGNOSIS_RE). Over-blocking is intended.
const FACT_BODY_RE = new RegExp(
  "(?<![\\p{L}\\p{N}])(" + [
    "glucose", "blood\\s*sugar", "insulin", "a1c", "cgm", "diabet\\p{L}*", "bp", "blood\\s*pressure", "heart\\s*-?\\s*rate", "hrv", "pulse",
    "sleep\\p{L}*", "slept", "insomnia", "nightmares?", "doctors?", "dr\\.?", "physician\\p{L}*", "nurse\\p{L}*", "clinic\\p{L}*",
    "surger\\p{L}*", "surgical", "mri", "x-?rays?", "blood\\s*(?:test|work)", "lab\\s*(?:work|results?)", "appointments?",
    "injur\\p{L}*", "sprain\\p{L}*", "fractur\\p{L}*", "broken\\s+(?:bone|arm|leg|wrist|ankle|foot|toe)", "ankles?", "achilles", "tendons?",
    "knees?", "wrists?", "back\\s+(?:pain|ache)", "headaches?", "aches?", "aching", "hurts?", "hurting", "sore", "swollen", "swelling",
    "bruis\\p{L}*", "bleed\\p{L}*", "sick", "ill", "illness", "flu", "fever\\p{L}*", "nause\\p{L}*", "vomit\\p{L}*", "cough\\p{L}*",
    "covid", "allerg\\p{L}*", "asthma", "cramps?", "pregnan\\p{L}*", "weigh\\p{L}*", "lbs?", "calories?", "eating\\s+disorder", "binge\\p{L}*",
    "health\\p{L}*", "wellness", "exhausted", "exhaustion", "fatigue\\p{L}*", "burn\\s*-?out", "meltdowns?", "shutdowns?",
    "overstimulat\\p{L}*", "sensory\\s+overload", "dysregulat\\p{L}*", "panic\\s+attacks?", "anxiety", "anxious", "depress\\p{L}*",
    "autis\\p{L}*", "adhd", "audhd", "ocpd", "c-?ptsd", "ptsd", "bipolar", "schizo\\p{L}*", "dissociat\\p{L}*",
    "therap\\p{L}*", "psychiatr\\p{L}*", "suicid\\p{L}*", "self-?harm", "spoons?", "care\\s+hold", "bad\\s+night",
  ].join("|") + ")(?![\\p{L}\\p{N}])",
  "iu",
);
// Upper-case only: "DID" the diagnosis, never "did" the verb.
const FACT_DIAGNOSIS_RE = /(?<![\p{L}\p{N}])(DID|OCD|EDS|POTS)(?![\p{L}\p{N}])/u;

/** True when `text` reads as meds, care, health, biometrics, symptoms, diagnoses or a body state. */
export function factHealthHit(text: string | null | undefined): boolean {
  const t = text ?? "";
  if (!t.trim()) return false;
  return containsHealthTerm(t) || looksHealthRelated(t) || FACT_BODY_RE.test(t) || FACT_DIAGNOSIS_RE.test(t);
}

/** Cheap shape check before any model call: a statement, not an acknowledgement or a bare question. */
export function factCandidateShape(text: string): "ok" | "short" | "lowinfo" | "question" {
  const t = text.trim();
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 4 || t.length < 15) return "short";
  if (isLowInfo(t)) return "lowinfo";
  // A line that is ONLY a question states nothing ("is Hope the dog?"); "no, Hope is the dog?" is
  // rare enough to lose.
  if (/\?\s*$/.test(t) && !/[.!;]/.test(t.replace(/\?\s*$/, ""))) return "question";
  return "ok";
}

export function buildFactsWriteQuestions(): Record<string, JevRequest["questions"][string]> {
  return {
    states_life_fact: {
      type: "noul",
      instructions: "Does the owner, in their own message, state something NEW and DURABLE about their own life: a person, pet, place, plan, routine, preference, belonging or history that would still be true next month?",
      criteria: {
        true: "A durable fact about the owner's life, people, pets, plans or preferences, stated by the owner (including correcting a wrong belief)",
        false: "Chat, feelings in the moment, a question, a joke, a hypothetical, something about the companion, or anything only true today",
      },
    },
    is_correction: {
      type: "noul",
      instructions: "Is the owner correcting something the companion (or the triad) believed wrongly about them?",
      criteria: { true: "Yes: 'no, X is ...', 'actually ...', 'that was Y, not Z'", false: "No correction" },
    },
    about_health: {
      type: "noul",
      instructions: "Does the owner's message concern medication, care, health, the body, sleep, symptoms, diagnoses, biometrics, mental health or a body state?",
      criteria: { true: "Any health, body, care, medication or diagnosis content at all", false: "None" },
    },
  };
}

export function renderFactsWriteState(ownerName: string, companionId: string, userMessage: string): string {
  return `${ownerName} (the owner) said to ${companionId}:\n"${userMessage.slice(0, 1500)}"`;
}

const AUTHOR_SYSTEM =
  "You record durable facts about Principal, the person the companions live with. Principal's pronouns are they/them " +
  "(never he or she). From Principal's own message, write ONE fact, third person, in plain words, at most 200 characters, " +
  "using only what the message says (no inference, no guessing, no feelings of the moment). If the message corrects a " +
  "wrong belief, write the corrected fact and say plainly what it replaces (e.g. \"Hope is Principal's dog; PersonP was a " +
  "friend, not a dog.\"). NEVER write anything about medication, care, health, the body, sleep, symptoms, diagnoses, " +
  "biometrics or mental health: answer NONE instead. If there is no durable fact, answer NONE. Otherwise answer only " +
  'JSON: {"fact": "...", "category": "<one lowercase word: people|pets|places|plans|preferences|history|work|home|general>", "correction": true|false}';

export interface AuthoredFact { fact: string; category: string; correction: boolean }

export function parseAuthoredFact(raw: string | null): AuthoredFact | null {
  if (!raw) return null;
  const t = raw.trim();
  if (/^none\b/i.test(t)) return null;
  const j = extractJson(t);
  if (!j || typeof j.fact !== "string") return null;
  const fact = j.fact.replace(/\s+/g, " ").trim();
  if (!fact || fact.length > 400 || /^none\b/i.test(fact)) return null;
  const cat = typeof j.category === "string" ? j.category.trim().toLowerCase() : "general";
  return { fact, category: /^[a-z_]{2,32}$/.test(cat) ? cat : "general", correction: j.correction === true };
}

export interface FactProposalPost {
  fact: string;
  category: string;
  companion_id: string;
  channel_id: string;
  message_id: string;
  stated_at: string;
  correction: boolean;
}

/** The narrow client slice this needs (librarian.ts `proposeArchitectFact`). */
export interface FactsWriteLibrarian {
  proposeArchitectFact?(p: FactProposalPost): Promise<{ outcome: string; id?: string; category?: string } | null>;
}

export interface FactsWriteCtx {
  companionId: string;
  speaker: WritebackSpeaker;
  userMessage: string;
  channelId: string;
  messageId: string;
  /** Null/absent = a DM. Facts are never proposed from a DM (owner DMs are sealed). */
  roomTag?: string | null;
  /** The direct (tool-less) adapter only. Null = skip: never author on the Hermes agent. */
  inference: InferenceAdapter | null;
  librarian: FactsWriteLibrarian;
  enqueue: (label: string, fn: () => Promise<void>) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  jev?: (req: JevRequest, opts: JevPostOpts) => Promise<JevEvalResult>;
  log?: (line: string) => void;
}

/** When the Discord message was sent, from its snowflake id (ms since the Discord epoch, 2015). */
export function snowflakeIso(id: string): string | null {
  if (!/^\d{15,25}$/.test(id)) return null;
  try {
    const ms = Number((BigInt(id) >> 22n) + 1420070400000n);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  } catch { return null; }
}

function noul(a: JevAnswers, k: string): number | null {
  const x = a[k];
  return x && x.type === "noul" && typeof x.noul === "number" ? x.noul : null;
}

/**
 * Never throws. Returns the decision code (for tests); everything observable is the one log line
 * and, under `on`, the enqueued POST.
 */
export async function runFactsWrite(ctx: FactsWriteCtx): Promise<string> {
  const env = ctx.env ?? process.env;
  const mode = factsWriteMode(ctx.companionId, env);
  if (mode === "off") return "off";
  // Owner only. Spouse, guests, siblings and Sol never source a fact; no log line (it would be one per message).
  if (!ctx.speaker?.isOwner || ctx.speaker.kind) return "not_owner";
  if (!ctx.roomTag) return "dm";

  const log = ctx.log ?? ((l: string) => console.log(l));
  const head = `[facts-write] ${ctx.companionId} mode=${mode} ch=${ctx.channelId} msg=${ctx.messageId}`;
  const shape = factCandidateShape(ctx.userMessage);
  if (shape !== "ok") return `skip:${shape}`;

  // Guard 1: before any model sees the line.
  if (factHealthHit(ctx.userMessage)) {
    log(`${head} drop=health stage=classify`);
    return "drop:health_classify";
  }

  const jev = ctx.jev ?? postJev;
  const res = await jev({
    purpose: `stated-fact write path for ${ctx.companionId}`,
    state: renderFactsWriteState(ctx.speaker.ownerName || "Principal", ctx.companionId, ctx.userMessage),
    questions: buildFactsWriteQuestions(),
  }, { env, tag: "[facts-write]" }).catch((e): JevEvalResult => ({ ok: false, reason: String(e).slice(0, 80), wall_ms: 0 }));
  if (!res.ok) {
    log(`${head} drop=jev_failed reason=${res.reason.split(/\s/)[0]}`);
    return "drop:jev_failed"; // fail CLOSED
  }
  const pFact = noul(res.answers, "states_life_fact");
  const pCorr = noul(res.answers, "is_correction") ?? 0;
  const pHealth = noul(res.answers, "about_health");
  // Guard 2: a missing health answer is treated as health (fail closed).
  if (pHealth === null || pHealth >= num(env, "FACTS_WRITE_HEALTH_P", 0.3)) {
    log(`${head} drop=health stage=jev p_health=${pHealth === null ? "none" : pHealth.toFixed(2)}`);
    return "drop:health_jev";
  }
  const theta = num(env, "FACTS_WRITE_THETA", 0.6);
  if (pFact === null || pFact < theta) {
    log(`${head} skip=not_fact p_fact=${pFact === null ? "none" : pFact.toFixed(2)} theta=${theta}`);
    return "skip:not_fact";
  }

  if (!ctx.inference) {
    log(`${head} skip=no_direct_adapter`);
    return "skip:no_direct";
  }
  let authored: AuthoredFact | null = null;
  try {
    const raw = await ctx.inference.generate(AUTHOR_SYSTEM, [{ role: "user", content: ctx.userMessage.slice(0, 1500) }], 0.2, 200);
    authored = parseAuthoredFact(raw);
  } catch (e) {
    log(`${head} skip=author_failed`);
    return "skip:author_failed";
  }
  if (!authored) {
    log(`${head} skip=author_none p_fact=${pFact.toFixed(2)}`);
    return "skip:author_none";
  }
  // Guard 3: the authored text, too.
  if (factHealthHit(authored.fact)) {
    log(`${head} drop=health stage=author`);
    return "drop:health_author";
  }

  // Both must agree: a correction gets a retire target on Halseth, so one reader's guess is not enough.
  const correction = authored.correction && pCorr >= 0.5;
  const kind = correction ? "correction" : "stated";
  const stats = `kind=${kind} p_fact=${pFact.toFixed(2)} p_corr=${pCorr.toFixed(2)} p_health=${pHealth.toFixed(2)} len=${authored.fact.length} cat=${authored.category}`;
  if (mode === "shadow") {
    log(`${head} would=propose ${stats}`);
    return "would_propose";
  }
  if (!ctx.librarian.proposeArchitectFact) {
    log(`${head} skip=no_client ${stats}`);
    return "skip:no_client";
  }
  const post: FactProposalPost = {
    fact: authored.fact,
    category: authored.category,
    companion_id: ctx.companionId,
    channel_id: ctx.channelId,
    message_id: ctx.messageId,
    stated_at: snowflakeIso(ctx.messageId) ?? new Date((ctx.now ?? Date.now)()).toISOString(),
    correction,
  };
  const propose = ctx.librarian.proposeArchitectFact.bind(ctx.librarian);
  ctx.enqueue(`facts-write:${ctx.channelId}`, async () => {
    const out = await propose(post);
    log(`${head} proposed outcome=${out?.outcome ?? "error"}${out?.id ? ` id=${out.id.slice(0, 8)}` : ""}${out?.category ? ` refused_category=${out.category}` : ""} ${stats}`);
  });
  return "proposed";
}
