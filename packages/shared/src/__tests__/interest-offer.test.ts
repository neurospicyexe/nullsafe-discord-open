// interest-offer.ts (B65 step 5): the night's candidate put to the companion at own-time; their words or nothing.
import { jest } from "@jest/globals";
import { interestOfferMode, offerPrompt, parseOfferAnswer, offerLogLine, runInterestOffer } from "../interest-offer.js";

function harness(over: { reply?: string; candidate?: unknown; pendingStatus?: number; answerStatus?: number; active?: boolean; env?: Record<string, string> } = {}) {
  const posts: Array<{ url: string; body: unknown }> = [];
  const prompts: string[] = [];
  const generate = jest.fn(async (_sys: string, msgs: Array<{ content: string }>) => { prompts.push(msgs[0]!.content); return over.reply ?? ""; });
  const fetchFn = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/answer") && init?.method === "POST") { posts.push({ url, body: JSON.parse(String(init.body)) }); return new Response("{\"ok\":true}", { status: over.answerStatus ?? 200 }); }
    if (url.includes("?pending=1")) return new Response(JSON.stringify({ mode: "on", candidate: over.candidate === undefined ? { id: "cand0001deadbeef", term: "slime mould" } : over.candidate }), { status: over.pendingStatus ?? 200 });
    return new Response("{}", { status: 404 });
  });
  const ctx = {
    companionId: "cypher",
    halsethSecret: "s",
    sessionWindows: { isAnyActive: () => over.active ?? false },
    inference: { generate },
    bootCtx: { systemPrompt: "SYS" },
  } as any;
  const env = { HALSETH_URL: "https://h.test", ...(over.env ?? {}) } as NodeJS.ProcessEnv;
  return { ctx, env, fetchFn: fetchFn as any, posts, prompts };
}

let logs: string[];
beforeEach(() => {
  logs = [];
  jest.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
});
afterEach(() => jest.restoreAllMocks());

describe("interest offer: knobs and grammar", () => {
  it("INTEREST_OFFER off/0/false/no = off, else on", () => {
    expect(interestOfferMode({} as any)).toBe("on");
    expect(interestOfferMode({ INTEREST_OFFER: "off" } as any)).toBe("off");
    expect(interestOfferMode({ INTEREST_OFFER: "0" } as any)).toBe("off");
    expect(interestOfferMode({ INTEREST_OFFER: "shadow" } as any)).toBe("on");
  });
  it("the prompt names both answers exactly and says silence writes nothing", () => {
    const p = offerPrompt("slime mould");
    expect(p).toContain("slime mould. Is it yours?");
    expect(p).toContain("new interest: <your name for it>, because <why>");
    expect(p).toContain("not mine: slime mould");
    expect(p).toContain("nothing is written");
  });
  it("parses kept (name + why, their words), declined (optional why), and everything else as silence", () => {
    expect(parseOfferAnswer("new interest: Physarum, because a body with no planner still decides.")).toEqual({ kind: "kept", name: "Physarum", why: "a body with no planner still decides" });
    expect(parseOfferAnswer("Yes.\n- New interest: \"slime networks\" because they route around damage\nthat is all")).toEqual({ kind: "kept", name: "slime networks", why: "they route around damage" });
    expect(parseOfferAnswer("not mine: slime mould")).toEqual({ kind: "declined", why: "" });
    expect(parseOfferAnswer("Not mine: slime mould, because that one is Drevan's.")).toEqual({ kind: "declined", why: "that one is Drevan's." });
    expect(parseOfferAnswer("It is not mine really, I think about it sometimes")).toEqual({ kind: "silence" });
    expect(parseOfferAnswer("new interest: slime mould")).toEqual({ kind: "silence" }); // no why = not an answer
    expect(parseOfferAnswer("")).toEqual({ kind: "silence" });
  });
  it("log line carries outcome and id prefix only", () => {
    expect(offerLogLine("cypher", { outcome: "kept", candidateId: "cand0001deadbeef" })).toBe("[interest-offer] cypher outcome=kept candidate=cand0001");
    expect(offerLogLine("cypher", { outcome: "none" })).toBe("[interest-offer] cypher outcome=none");
  });
});

describe("interest offer: the run", () => {
  it("off, no url, or an active window: nothing fetched, nothing generated", async () => {
    const a = harness({ env: { INTEREST_OFFER: "off" } });
    expect((await runInterestOffer(a.ctx, { env: a.env, fetchFn: a.fetchFn })).outcome).toBe("skip:off");
    const b = harness({ active: true });
    expect((await runInterestOffer(b.ctx, { env: b.env, fetchFn: b.fetchFn })).outcome).toBe("skip:active");
    const c = harness();
    expect((await runInterestOffer(c.ctx, { env: { HALSETH_URL: "" } as any, fetchFn: c.fetchFn })).outcome).toBe("skip:no_halseth_url");
    expect(a.fetchFn).not.toHaveBeenCalled();
    expect(b.fetchFn).not.toHaveBeenCalled();
    expect(a.prompts.length + b.prompts.length + c.prompts.length).toBe(0);
  });
  it("no pending candidate (shadow on the server): outcome none, no inference", async () => {
    const h = harness({ candidate: null });
    expect((await runInterestOffer(h.ctx, { env: h.env, fetchFn: h.fetchFn })).outcome).toBe("none");
    expect(h.prompts).toEqual([]);
    expect(logs).toContain("[interest-offer] cypher outcome=none");
  });
  it("kept: one prompt with the term, the answer POSTed in their words with the candidate id", async () => {
    const h = harness({ reply: "new interest: Physarum, because a body with no planner still decides" });
    const r = await runInterestOffer(h.ctx, { env: h.env, fetchFn: h.fetchFn });
    expect(r).toEqual({ outcome: "kept", candidateId: "cand0001deadbeef" });
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toBe(offerPrompt("slime mould"));
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]!.url).toBe("https://h.test/mind/interest-candidates/cand0001deadbeef/answer");
    expect(h.posts[0]!.body).toEqual({ companion_id: "cypher", answer: "kept", name: "Physarum", why: "a body with no planner still decides" });
    expect(logs).toContain("[interest-offer] cypher outcome=kept candidate=cand0001");
    expect(logs.join("\n")).not.toContain("Physarum");
  });
  it("declined: POSTed with their line; silence: nothing POSTed", async () => {
    const d = harness({ reply: "not mine: slime mould, because that is Cypher's shelf" });
    expect((await runInterestOffer(d.ctx, { env: d.env, fetchFn: d.fetchFn })).outcome).toBe("declined");
    expect(d.posts[0]!.body).toEqual({ companion_id: "cypher", answer: "declined", why: "that is Cypher's shelf" });
    const s = harness({ reply: "I would rather sit with it a while." });
    expect((await runInterestOffer(s.ctx, { env: s.env, fetchFn: s.fetchFn })).outcome).toBe("silence");
    expect(s.posts).toHaveLength(0);
  });
  it("a refused answer or a failing read is reported, never retried with other words", async () => {
    const r = harness({ reply: "new interest: slime mould, because yes", answerStatus: 409 });
    expect((await runInterestOffer(r.ctx, { env: r.env, fetchFn: r.fetchFn })).outcome).toBe("answer_refused");
    expect(r.prompts).toHaveLength(1);
    const f = harness({ pendingStatus: 500 });
    expect((await runInterestOffer(f.ctx, { env: f.env, fetchFn: f.fetchFn })).outcome).toBe("error");
    expect(f.prompts).toHaveLength(0);
  });
});
