import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../halseth-client.js", () => ({
  getAvailableSeeds: vi.fn(async () => []),
  markSeedUsed: vi.fn(async () => {}),
  appendLog: vi.fn(async () => {}),
  getForageFindsFor: vi.fn(async () => []),
  consumeForageFind: vi.fn(async () => true),
  getOpenProjects: vi.fn(async () => []),
  getDueIntention: vi.fn(async () => null),
}));
vi.mock("../deepseek.js", () => ({ prompt: vi.fn(async () => ({ content: "B live", tokensUsed: 1 })) }));

import { runSeed } from "../phases/seed.js";
import { getAvailableSeeds, markSeedUsed, appendLog, getOpenProjects } from "../halseth-client.js";
import {
  growthMode, isSeedClaimNight, seedWindowDays, graduationOfferBlock, parseGraduationAnswer,
} from "../growth-loops.js";
import type { PipelineContext, Seed } from "../types.js";

const CLAIM_NIGHT = new Date(Date.UTC(2026, 0, 3, 9)); // day-of-year 3 (3 % 3 == 0), also an odd/forage day
const PLAIN_NIGHT = new Date(Date.UTC(2026, 0, 2, 9)); // day 2

const seed = (id: string, created: string): Seed => ({
  id, companion_id: "cypher", seed_type: "topic", content: `topic ${id}`, priority: 6,
  used_at: null as unknown as string, created_at: created, claim_source: null, justification: null,
});
const makeCtx = (): PipelineContext => ({
  companionId: "cypher", runId: "run1", activeThreads: [], unexaminedDreamIds: [], openLoops: [],
  pressureFlags: [], seed: null, runType: null, seedDecisionReason: null, project: null,
  identityText: "identity", tokensUsed: 0,
} as unknown as PipelineContext);

describe("knob parsing", () => {
  it("defaults to shadow; junk is shadow; off tokens are off", () => {
    expect(growthMode(undefined)).toBe("shadow");
    expect(growthMode("banana")).toBe("shadow");
    expect(growthMode(" ON ")).toBe("on");
    for (const v of ["off", "0", "false", "no"]) expect(growthMode(v)).toBe("off");
  });
  it("window defaults to 7 days, claim night is every third day", () => {
    expect(seedWindowDays()).toBe(7);
    expect(isSeedClaimNight(CLAIM_NIGHT)).toBe(true);
    expect(isSeedClaimNight(PLAIN_NIGHT)).toBe(false);
  });
});

describe("SEED_CLAIM in runSeed", () => {
  const OLD = process.env["SEED_CLAIM"];
  beforeEach(() => {
    vi.mocked(getAvailableSeeds).mockReset().mockResolvedValue([seed("fresh", "2026-01-02 03:00:00")]);
    vi.mocked(markSeedUsed).mockReset().mockResolvedValue(undefined as never);
    vi.mocked(appendLog).mockReset().mockResolvedValue(undefined as never);
    vi.mocked(getOpenProjects).mockReset().mockResolvedValue([]);
  });
  afterEach(() => { if (OLD === undefined) delete process.env["SEED_CLAIM"]; else process.env["SEED_CLAIM"] = OLD; });

  it("on: claim night takes the freshest windowed seed above forage rotation", async () => {
    process.env["SEED_CLAIM"] = "on";
    const ctx = makeCtx();
    await runSeed(ctx, CLAIM_NIGHT);
    expect(ctx.seed?.id).toBe("fresh");
    expect(vi.mocked(markSeedUsed)).toHaveBeenCalledWith("fresh");
    expect(vi.mocked(getAvailableSeeds).mock.calls[0]![2]).toEqual({ freshWithinDays: 7 });
    expect(vi.mocked(appendLog).mock.calls.some(c => c[1] === "seed:fresh_claim")).toBe(true);
  });

  it("shadow (the default): logs would_claim, consumes nothing, and the normal pool is unchanged", async () => {
    delete process.env["SEED_CLAIM"];
    const ctx = makeCtx();
    await runSeed(ctx, CLAIM_NIGHT);
    // the normal pick fetch carries no window opts; only the shadow peek does
    expect(vi.mocked(getAvailableSeeds).mock.calls[0]![2]).toBeUndefined();
    expect(vi.mocked(appendLog).mock.calls.some(c => c[1] === "seed:would_claim")).toBe(true);
    expect(vi.mocked(appendLog).mock.calls.some(c => c[1] === "seed:fresh_claim")).toBe(false);
  });

  it("off: no window, no peek", async () => {
    process.env["SEED_CLAIM"] = "off";
    await runSeed(makeCtx(), CLAIM_NIGHT);
    expect(vi.mocked(getAvailableSeeds)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getAvailableSeeds).mock.calls[0]![2]).toBeUndefined();
  });

  it("on, ordinary night: the queue pick comes from the windowed fresh pool", async () => {
    process.env["SEED_CLAIM"] = "on";
    const ctx = makeCtx();
    await runSeed(ctx, PLAIN_NIGHT);
    expect(vi.mocked(getAvailableSeeds).mock.calls[0]![2]).toEqual({ freshWithinDays: 7 });
  });
});

describe("graduation offer", () => {
  const cand = { id: "sm_1", observation: "I trust a plain sentence over a clever one", confidence: 0.9, kind: "preference" };
  it("names the id and the verb, promises nothing is lowered", () => {
    const t = graduationOfferBlock(cand);
    expect(t).toContain("sm_1");
    expect(t).toContain("self_model_graduate");
    expect(t).toContain("nothing is ever lowered");
  });
  it("only the exact offered id graduates; null, other ids and non-strings do not", () => {
    expect(parseGraduationAnswer("sm_1", "sm_1")).toBe("sm_1");
    expect(parseGraduationAnswer(" sm_1 ", "sm_1")).toBe("sm_1");
    expect(parseGraduationAnswer("sm_2", "sm_1")).toBeNull();
    expect(parseGraduationAnswer(null, "sm_1")).toBeNull();
    expect(parseGraduationAnswer(true, "sm_1")).toBeNull();
    expect(parseGraduationAnswer("sm_1", null)).toBeNull();
  });
});
