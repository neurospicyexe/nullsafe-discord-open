// show_made had never fired (2026-11-11): the move had no object. These pin the pieces that give it one and
// that carry his reply back to the maker (show-made.ts, reach-ledger.ts).

import { describe, it, expect, jest, afterEach, beforeEach } from "@jest/globals";
import { runHeartbeat, __resetHeartbeatDeclineCap } from "../autonomous-core.js";
import { heartbeatCtx, inWindowOf, row } from "./fixtures/heartbeat-ctx.js";
import {
  pickShowableMake, showMadeOffer, showMadePrompt, showMadeMode, signalMakeReplied, SHOWN_KEY,
} from "../show-made.js";
import { recordReachSend, noteOwnerArrival, REACH_OUT_KEY } from "../reach-ledger.js";
import type { MakeLite } from "../make-move.js";

const NOW = Date.parse("2026-11-11T18:00:00Z");
const HOURS = 3_600_000;
const iso = (hAgo: number) => new Date(NOW - hAgo * HOURS).toISOString();
const mk = (over: Partial<MakeLite> = {}): MakeLite => ({
  id: "a".repeat(32), title: "Fixture", kind: "drawing", interestName: null, createdAt: iso(30), status: "ready", heardBack: null, originKind: null, ...over,
});

describe("pickShowableMake", () => {
  it("picks the newest ready, unmet, unshown make", () => {
    const older = mk({ id: "b".repeat(32), title: "Older", createdAt: iso(60) });
    const newer = mk({ id: "c".repeat(32), title: "Newer", createdAt: iso(30) });
    expect(pickShowableMake([older, newer], new Set(), NOW)?.title).toBe("Newer");
  });
  it("skips shown, met (any heard_back), failed, pending, letters, too fresh and too old", () => {
    expect(pickShowableMake([mk()], new Set(["a".repeat(32)]), NOW)).toBeNull();
    expect(pickShowableMake([mk({ heardBack: "[seen] Principal opened it on hearth 2026-11-11" })], new Set(), NOW)).toBeNull();
    expect(pickShowableMake([mk({ heardBack: "he laughed" })], new Set(), NOW)).toBeNull();
    expect(pickShowableMake([mk({ status: "failed" })], new Set(), NOW)).toBeNull();
    expect(pickShowableMake([mk({ status: "pending" })], new Set(), NOW)).toBeNull();
    expect(pickShowableMake([mk({ originKind: "letter" })], new Set(), NOW)).toBeNull();
    expect(pickShowableMake([mk({ createdAt: iso(0.1) })], new Set(), NOW)).toBeNull();
    expect(pickShowableMake([mk({ createdAt: iso(24 * 8) })], new Set(), NOW)).toBeNull();
    expect(pickShowableMake([mk({ id: undefined })], new Set(), NOW)).toBeNull();
    expect(pickShowableMake(null, new Set(), NOW)).toBeNull();
    expect(pickShowableMake([], new Set(), NOW)).toBeNull();
  });
  it("a chosen exploration or kept make may be shown", () => {
    expect(pickShowableMake([mk({ originKind: "exploration" })], new Set(), NOW)).not.toBeNull();
    expect(pickShowableMake([mk({ originKind: "kept" })], new Set(), NOW)).not.toBeNull();
  });
});

describe("offer and prompt name the make", () => {
  it("both carry title, kind and age; the prompt asks nothing and pastes nothing", () => {
    const m = mk({ interestName: "Trains" });
    expect(showMadeOffer(m, NOW)).toContain('"Fixture" (drawing, made yesterday)');
    const p = showMadePrompt(m, NOW);
    expect(p).toContain('"Fixture"');
    expect(p).toContain("Trains");
    expect(p).toMatch(/ask nothing of him/);
  });
  it("SHOW_MADE knob: default on, off words turn it off", () => {
    expect(showMadeMode({})).toBe("on");
    expect(showMadeMode({ SHOW_MADE: " Off " })).toBe("off");
    expect(showMadeMode({ SHOW_MADE: "no" })).toBe("off");
    expect(showMadeMode({ SHOW_MADE: "junk" })).toBe("on");
    expect(SHOWN_KEY("x")).toBe("ns:showmade:x");
  });
});

describe("signalMakeReplied", () => {
  it("POSTs replied via discord with the secret; false on failure, never throws", async () => {
    const f = jest.fn(async () => new Response("{}", { status: 200 }));
    expect(await signalMakeReplied({ url: "https://h/", secret: "s", fetchFn: f as unknown as typeof fetch }, "abc")).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://h/mind/makes/abc/reception");
    expect(JSON.parse(init.body as string)).toEqual({ signal: "replied", via: "discord" });
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer s");
    const boom = jest.fn(async () => { throw new Error("down"); });
    expect(await signalMakeReplied({ url: "https://h", secret: "s", fetchFn: boom as unknown as typeof fetch }, "abc")).toBe(false);
  });
});

function fakeRedis() {
  const hashes = new Map<string, Map<string, string>>();
  const z = new Map<string, number>();
  return {
    async hset(k: string, ...kv: string[]) { const h = hashes.get(k) ?? new Map(); for (let i = 0; i < kv.length; i += 2) h.set(kv[i]!, kv[i + 1]!); hashes.set(k, h); return 1; },
    async hget(k: string, f: string) { return hashes.get(k)?.get(f) ?? null; },
    async hgetall(k: string) { const h = hashes.get(k); return h ? Object.fromEntries(h) : {}; },
    async hsetnx(k: string, f: string, v: string) { const h = hashes.get(k) ?? new Map(); if (h.has(f)) return 0; h.set(f, v); hashes.set(k, h); return 1; },
    async expire() { return 1; },
    async zadd(_k: string, score: number, m: string) { z.set(m, score); return 1; },
    async zremrangebyrank() { return 0; },
    async zrevrange() { return [...z.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m); },
    async zrange() { return [...z.keys()]; },
  };
}

describe("his reply reaches the maker", () => {
  it("a replied show_made row reports the make to Halseth; another move does not", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    process.env["HALSETH_URL"] = "https://h.example";
    process.env["HALSETH_SECRET"] = "sek";
    globalThis.fetch = (async (u: string) => { calls.push(String(u)); return new Response("{}"); }) as unknown as typeof fetch;
    try {
      const redis = fakeRedis();
      const t = Date.now() - 60_000;
      await recordReachSend(redis as never, { id: "m1", companionId: "drevan", actionType: "show_made", channelId: "dm", ts: t, makeId: "f".repeat(32) });
      await recordReachSend(redis as never, { id: "m2", companionId: "drevan", actionType: "share_media", channelId: "dm", ts: t - 1000 });
      expect((await redis.hgetall(REACH_OUT_KEY("m1")))["make"]).toBe("f".repeat(32));
      const settled = await noteOwnerArrival(redis as never, { channelId: "dm", isDm: true, content: "oh that is great", ts: Date.now() });
      expect(settled).toBe(2);
      await new Promise((r) => setTimeout(r, 20));
      expect(calls).toEqual([`https://h.example/mind/makes/${"f".repeat(32)}/reception`]);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env["HALSETH_URL"]; delete process.env["HALSETH_SECRET"];
    }
  });
});

describe("through the REAL heartbeat", () => {
  let restore: () => void = () => {};
  const realFetch = globalThis.fetch;
  beforeEach(() => { process.env["REACH_DM"] = "on"; process.env["HALSETH_URL"] = "https://h.example"; });
  afterEach(() => { restore(); globalThis.fetch = realFetch; delete process.env["REACH_DM"]; delete process.env["HALSETH_URL"]; delete process.env["SHOW_MADE"]; });
  const stub = (makes: unknown[]) => { globalThis.fetch = (async () => new Response(JSON.stringify({ makes }), { status: 200 })) as unknown as typeof fetch; };
  const ready = (over: Record<string, unknown> = {}) => ({ id: "a".repeat(32), title: "Fixture", kind: "drawing", status: "ready", heard_back: null, created_at: new Date(Date.now() - 30 * HOURS).toISOString(), ...over });
  async function promptFor(): Promise<string | undefined> {
    __resetHeartbeatDeclineCap();
    restore = inWindowOf("drevan");
    jest.spyOn(console, "log").mockImplementation(() => {});
    const h = heartbeatCtx({ companionId: "drevan", palette: [row("show_made", "row:show_made"), row("offer_presence", "row:presence"), row("nothing")], choose: "nothing" });
    await runHeartbeat(h.ctx);
    return h.prompts[0];
  }
  it("offers show_made naming the make when one is unmet", async () => {
    stub([ready()]);
    const p = await promptFor();
    expect(p).toContain("row:show_made");
    expect(p).toContain('"Fixture" (drawing');
  });
  it("removes show_made when every make has been met, failed, or there are none", async () => {
    for (const makes of [[], [ready({ heard_back: "[seen] Principal opened it on hearth 2026-11-11" })], [ready({ status: "failed" })]]) {
      stub(makes);
      const p = await promptFor();
      expect(p).not.toContain("row:show_made");
      expect(p).toContain("row:presence");
    }
  });
  it("SHOW_MADE=off removes the move even with a make to show", async () => {
    process.env["SHOW_MADE"] = "off";
    stub([ready()]);
    expect(await promptFor()).not.toContain("row:show_made");
  });
});
