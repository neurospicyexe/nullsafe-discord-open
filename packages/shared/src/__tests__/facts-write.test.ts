import { jest, describe, it, expect } from "@jest/globals";
import {
  runFactsWrite, factsWriteMode, factHealthHit, factCandidateShape, parseAuthoredFact, snowflakeIso,
  type FactsWriteCtx, type FactProposalPost,
} from "../facts-write.js";
import { runWritebackGate, type WritebackLibrarian } from "../writeback-gate.js";
import type { JevEvalResult, JevRequest } from "../jev-gate.js";
import type { InferenceAdapter } from "../inference.js";

// GAP-MAP A3 (2026-11-11): Principal's stated facts become OPEN architect_facts proposals. The guard
// that matters most: nothing about meds, care, health, the body or a diagnosis is ever proposed,
// and nobody but the owner ever sources a fact.

const OWNER = { name: "Principal", isOwner: true, ownerName: "Principal" };
const SPOUSE = { name: "Spouse", isOwner: false, ownerName: "Principal", kind: "spouse" as const };
const GUEST = { name: "Acquaintance", isOwner: false, ownerName: "Principal", kind: "guest" as const };
const SIBLING = { name: "Drevan", isOwner: false, ownerName: "Principal", kind: "sibling" as const };

const FACT_LINE = "no, Hope is the dog; PersonP was a friend of mine from school";

function jevAnswer(p: { fact?: number; corr?: number; health?: number | null } = {}) {
  const answers: Record<string, unknown> = {
    states_life_fact: { type: "noul", noul: p.fact ?? 0.9 },
    is_correction: { type: "noul", noul: p.corr ?? 0.8 },
  };
  if (p.health !== null) answers.about_health = { type: "noul", noul: p.health ?? 0.02 };
  return jest.fn(async (_req: JevRequest): Promise<JevEvalResult> => ({ ok: true, answers: answers as never, latency_ms: 10, wall_ms: 12 }));
}

function authoring(reply: string | null) {
  const calls: string[] = [];
  const adapter: InferenceAdapter = { generate: async (_s, m) => { calls.push(m.map(x => x.content).join("\n")); return reply; } };
  return { adapter, calls };
}

function harness(over: Partial<FactsWriteCtx> = {}, env: Record<string, string> = { FACTS_WRITE: "on" }) {
  const posts: FactProposalPost[] = [];
  const lines: string[] = [];
  const done: Array<Promise<void>> = [];
  const jev = jevAnswer();
  const author = authoring(JSON.stringify({ fact: "Hope is Principal's dog; PersonP was a friend, not a dog.", category: "pets", correction: true }));
  const ctx: FactsWriteCtx = {
    companionId: "drevan",
    speaker: OWNER,
    userMessage: FACT_LINE,
    channelId: "0000000000000000002",
    messageId: "0000000000000000017",
    roomTag: "room:home/#general",
    inference: author.adapter,
    librarian: { proposeArchitectFact: async (p) => { posts.push(p); return { outcome: "proposed", id: "abcdef123456" }; } },
    enqueue: (_l, fn) => { done.push(fn()); },
    env: env as NodeJS.ProcessEnv,
    now: () => Date.parse("2026-11-11T20:00:00Z"),
    jev,
    log: (l) => lines.push(l),
    ...over,
  };
  return { ctx, posts, lines, jev, author, settle: () => Promise.all(done) };
}

describe("FACTS_WRITE knob", () => {
  it("defaults to shadow; junk is shadow; off spellings are off; per-companion wins", () => {
    expect(factsWriteMode("cypher", {} as NodeJS.ProcessEnv)).toBe("shadow");
    expect(factsWriteMode("cypher", { FACTS_WRITE: "banana" } as never)).toBe("shadow");
    for (const v of ["off", "0", "false", "NO "]) expect(factsWriteMode("cypher", { FACTS_WRITE: v } as never)).toBe("off");
    expect(factsWriteMode("gaia", { FACTS_WRITE: "off", FACTS_WRITE_GAIA: "on" } as never)).toBe("on");
  });

  it("off runs nothing: no Jev, no model, no log, no write", async () => {
    const h = harness({}, { FACTS_WRITE: "off" });
    expect(await runFactsWrite(h.ctx)).toBe("off");
    expect(h.jev).not.toHaveBeenCalled();
    expect(h.author.calls).toHaveLength(0);
    expect(h.lines).toHaveLength(0);
    expect(h.posts).toHaveLength(0);
  });

  it("shadow classifies and authors, logs ONE would= line with no text, writes nothing", async () => {
    const h = harness({}, { FACTS_WRITE: "shadow" });
    expect(await runFactsWrite(h.ctx)).toBe("would_propose");
    await h.settle();
    expect(h.posts).toHaveLength(0);
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toMatch(/^\[facts-write\] drevan mode=shadow ch=\d+ msg=\d+ would=propose kind=correction p_fact=0\.90 p_corr=0\.80 p_health=0\.02 len=\d+ cat=pets$/);
    expect(h.lines[0]).not.toMatch(/Hope|PersonP/);
  });

  it("on posts the proposal with provenance and the correction flag", async () => {
    const h = harness();
    expect(await runFactsWrite(h.ctx)).toBe("proposed");
    await h.settle();
    expect(h.posts).toEqual([{
      fact: "Hope is Principal's dog; PersonP was a friend, not a dog.", category: "pets", companion_id: "drevan",
      channel_id: "0000000000000000002", message_id: "0000000000000000017", stated_at: snowflakeIso("0000000000000000017"), correction: true,
    }]);
    expect(h.lines.at(-1)).toMatch(/proposed outcome=proposed id=abcdef12 /);
    expect(h.lines.join("\n")).not.toMatch(/Hope|PersonP/);
  });
});

describe("owner only: nobody else ever sources a fact", () => {
  for (const [name, speaker] of [["Spouse", SPOUSE], ["a guest", GUEST], ["a sibling", SIBLING]] as const) {
    it(`${name}: nothing runs`, async () => {
      const h = harness({ speaker });
      expect(await runFactsWrite(h.ctx)).toBe("not_owner");
      expect(h.jev).not.toHaveBeenCalled();
      expect(h.posts).toHaveLength(0);
    });
  }
  it("a non-owner flagged isOwner but carrying a kind is still refused", async () => {
    const h = harness({ speaker: { ...SPOUSE, isOwner: true } });
    expect(await runFactsWrite(h.ctx)).toBe("not_owner");
  });
  it("never from a DM (no room tag)", async () => {
    const h = harness({ roomTag: null });
    expect(await runFactsWrite(h.ctx)).toBe("dm");
    expect(h.jev).not.toHaveBeenCalled();
  });
});

describe("the health guard drops every health statement, at every stage", () => {
  const healthLines = [
    "I took my meds late tonight, around eleven",
    "my blood sugar was 208 this morning after breakfast",
    "my ankle is swollen again from the walk yesterday",
    "I only slept four hours last night and work is long",
    "I have OCD and it has been loud this whole week",
    "my therapist moved our sessions to Thursdays now",
    "I got diagnosed with ADHD back when I was nineteen",
    "I had a meltdown at the grocery store earlier",
    "my heart rate was weird during the drive home",
  ];
  for (const line of healthLines) {
    it(`lexical, before any model call: "${line}"`, async () => {
      const h = harness({ userMessage: line });
      expect(await runFactsWrite(h.ctx)).toBe("drop:health_classify");
      expect(h.jev).not.toHaveBeenCalled();
      expect(h.author.calls).toHaveLength(0);
      await h.settle();
      expect(h.posts).toHaveLength(0);
      expect(h.lines[0]).toMatch(/drop=health stage=classify$/);
    });
  }

  it("keyword-free health (Jev reads it): 'I can't really walk on it since Tuesday'", async () => {
    const h = harness({ userMessage: "I can't really walk on it since Tuesday, it keeps giving out", jev: jevAnswer({ health: 0.85 }) });
    expect(await runFactsWrite(h.ctx)).toBe("drop:health_jev");
    expect(h.author.calls).toHaveLength(0);
    await h.settle();
    expect(h.posts).toHaveLength(0);
  });

  it("Jev gives no health answer: dropped (fail closed)", async () => {
    const h = harness({ jev: jevAnswer({ health: null }) });
    expect(await runFactsWrite(h.ctx)).toBe("drop:health_jev");
  });

  it("Jev down: dropped, never written on a guess", async () => {
    const h = harness({ jev: jest.fn(async (): Promise<JevEvalResult> => ({ ok: false, reason: "timeout after 4000ms", wall_ms: 4000 })) });
    expect(await runFactsWrite(h.ctx)).toBe("drop:jev_failed");
    expect(h.author.calls).toHaveLength(0);
    expect(h.posts).toHaveLength(0);
  });

  it("the AUTHORED fact is guarded too (the model put health in)", async () => {
    const author = authoring(JSON.stringify({ fact: "Principal's ankle injury means Hope is walked by Spouse.", category: "pets", correction: false }));
    const h = harness({ inference: author.adapter });
    expect(await runFactsWrite(h.ctx)).toBe("drop:health_author");
    await h.settle();
    expect(h.posts).toHaveLength(0);
  });

  it("lexical guard keeps ordinary life facts (and 'did' the verb, 'lab' the dog)", () => {
    expect(factHealthHit("Hope is a black lab mix and Principal did the adoption in May")).toBe(false);
    expect(factHealthHit("Principal's sister lives in Denver")).toBe(false);
    expect(factHealthHit("Principal has DID")).toBe(true);
  });
});

describe("classification and authoring", () => {
  it("stated_at is the Discord message's own time (snowflake), not the clock", () => {
    expect(snowflakeIso("000000000000000018")).toBe("2016-04-30T11:18:25.796Z");
    expect(snowflakeIso("not-an-id")).toBeNull();
  });
  it("a correction needs BOTH the author and Jev (one reader's guess never gets a retire target)", async () => {
    const authorOnly = harness({ jev: jevAnswer({ corr: 0.2 }) });
    await runFactsWrite(authorOnly.ctx); await authorOnly.settle();
    expect(authorOnly.posts[0]!.correction).toBe(false);
    const jevOnly = harness({ inference: authoring(JSON.stringify({ fact: "Hope is Principal's dog.", category: "pets", correction: false })).adapter });
    await runFactsWrite(jevOnly.ctx); await jevOnly.settle();
    expect(jevOnly.posts[0]!.correction).toBe(false);
  });
  it("below theta is skipped before any authoring", async () => {
    const h = harness({ jev: jevAnswer({ fact: 0.3 }) });
    expect(await runFactsWrite(h.ctx)).toBe("skip:not_fact");
    expect(h.author.calls).toHaveLength(0);
  });
  it("no direct adapter: never authored on the agent", async () => {
    const h = harness({ inference: null });
    expect(await runFactsWrite(h.ctx)).toBe("skip:no_direct");
  });
  it("the model says NONE: nothing", async () => {
    const h = harness({ inference: authoring("NONE").adapter });
    expect(await runFactsWrite(h.ctx)).toBe("skip:author_none");
  });
  it("shape: acknowledgements, short lines and bare questions never reach Jev", () => {
    expect(factCandidateShape("ok cool")).toBe("short");
    expect(factCandidateShape("is Hope the dog or is PersonP?")).toBe("question");
    expect(factCandidateShape(FACT_LINE)).toBe("ok");
  });
  it("parseAuthoredFact: JSON in, junk out", () => {
    expect(parseAuthoredFact('{"fact":"A b c.","category":"Pets","correction":true}')).toEqual({ fact: "A b c.", category: "pets", correction: true });
    expect(parseAuthoredFact("NONE")).toBeNull();
    expect(parseAuthoredFact("sure! here you go")).toBeNull();
    expect(parseAuthoredFact('{"fact":"x","category":"two words"}')).toEqual({ fact: "x", category: "general", correction: false });
  });
  it("the Jev request carries the owner's line and the three questions only", async () => {
    const h = harness();
    await runFactsWrite(h.ctx);
    const req = h.jev.mock.calls[0]![0] as JevRequest;
    expect(Object.keys(req.questions).sort()).toEqual(["about_health", "is_correction", "states_life_fact"]);
    expect(req.state).toContain(FACT_LINE);
  });
});

describe("inside the writeback gate", () => {
  function lib(posts: FactProposalPost[]): WritebackLibrarian {
    return {
      addCompanionNote: async () => {}, writeWmNote: async () => {}, witnessLog: async () => {}, addLiveThread: async () => {},
      proposeArchitectFact: async (p) => { posts.push(p); return { outcome: "proposed", id: "x" }; },
    };
  }
  const baseGate = (env: Record<string, string>, posts: FactProposalPost[], jevEval: jest.Mock, factsJev: jest.Mock) => ({
    mode: "jev" as const,
    companionId: "cypher",
    speaker: OWNER,
    userMessage: FACT_LINE,
    assistantResponse: "Got it. Hope, not PersonP.",
    channelId: "0000000000000000002",
    messageId: "0000000000000000017",
    roomTag: "room:home/#general",
    inference: { generate: async () => null } as InferenceAdapter,
    factsInference: authoring(JSON.stringify({ fact: "Hope is Principal's dog.", category: "pets", correction: false })).adapter,
    librarian: lib(posts),
    enqueue: (_l: string, fn: () => Promise<void>) => { void fn(); },
    shadowLog: () => {},
    jevEval: jevEval as never,
    factsJev: factsJev as never,
    env: env as NodeJS.ProcessEnv,
  });
  const skipJev = () => jest.fn(async () => ({ ok: true as const, answers: { worth_remembering: { type: "noul", noul: 0.05 } } as never, latency_ms: 1, wall_ms: 1 }));

  it("a fact lands even when the memory writeback decides to write nothing (worth is low)", async () => {
    const posts: FactProposalPost[] = [];
    const facts = jevAnswer({ corr: 0.1 });
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    await runWritebackGate(baseGate({ FACTS_WRITE: "on" }, posts, skipJev(), facts));
    await new Promise((r) => setImmediate(r));
    spy.mockRestore();
    expect(facts).toHaveBeenCalledTimes(1);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ companion_id: "cypher", correction: false });
  });

  it("the writeback Jev request is identical with FACTS_WRITE off and on", async () => {
    const seen: unknown[] = [];
    for (const mode of ["off", "on"]) {
      const jevEval = skipJev();
      const spy = jest.spyOn(console, "log").mockImplementation(() => {});
      await runWritebackGate(baseGate({ FACTS_WRITE: mode }, [], jevEval, jevAnswer()));
      spy.mockRestore();
      // `env` is the gate's own passthrough (it differs only by the knob being tested); the request is the rest.
      const { env: _env, ...req } = jevEval.mock.calls[0]![0] as Record<string, unknown>;
      seen.push(req);
    }
    expect(JSON.stringify(seen[0])).toBe(JSON.stringify(seen[1]));
  });

  it("a sibling-released follow-up keys the fact on Principal's ORIGIN message, not the sibling's post", async () => {
    const posts: FactProposalPost[] = [];
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    await runWritebackGate({ ...baseGate({ FACTS_WRITE: "on" }, posts, skipJev(), jevAnswer()), messageId: "0000000000000000003", factsMessageId: "0000000000000000017" });
    await new Promise((r) => setImmediate(r));
    spy.mockRestore();
    expect(posts[0]!.message_id).toBe("0000000000000000017");
  });

  it("FACTS_WRITE=off never calls the facts Jev", async () => {
    const facts = jevAnswer();
    await runWritebackGate(baseGate({ FACTS_WRITE: "off" }, [], skipJev(), facts));
    expect(facts).not.toHaveBeenCalled();
  });
});
