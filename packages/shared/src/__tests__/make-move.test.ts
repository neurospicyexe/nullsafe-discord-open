import { describe, it, expect, jest } from "@jest/globals";
import {
  parseMakeReply, resolveInterestName, makeMoveOn, mayMake, decidePace, parseFerment, warmestInterest, offerMake, runMakeMove,
  buildMakePrompt, makeAction, paceLogLine, executeMetronomeAction, pickOffer, recentMakesLines, fetchRecentMakes, type MakeLite,
  type InterestLite, type HalsethHttp,
} from "../index.js";

const fence = (body: string, tag = "") => "```" + tag + "\n" + body + "\n```";

describe("parseMakeReply", () => {
  it("reads a good drawing", () => {
    const r = parseMakeReply(`KIND: drawing\nTITLE: Low tide\nFOR: tide tables\nWHY: it keeps coming back\n${fence("<svg><rect/></svg>", "svg")}`);
    expect(r).toMatchObject({ result: "make", make: { kind: "drawing", title: "Low tide", forInterest: "tide tables", why: "it keeps coming back" } });
    expect((r as { make: { source: string } }).make.source).toContain("<svg>");
  });
  it("reads NONE, in any case and with decoration", () => {
    expect(parseMakeReply("NONE")).toEqual({ result: "none" });
    expect(parseMakeReply("  none.\n")).toEqual({ result: "none" });
    expect(parseMakeReply("**NONE**")).toEqual({ result: "none" });
  });
  it("FOR: none means no interest", () => {
    const r = parseMakeReply(`KIND: writing\nTITLE: T\nFOR: none\nWHY: w\n${fence("a poem")}`);
    expect(r).toMatchObject({ result: "make", make: { forInterest: null } });
  });
  it("rejects malformed replies", () => {
    expect(parseMakeReply("")).toMatchObject({ result: "invalid" });
    expect(parseMakeReply("I would like to make a thing")).toMatchObject({ result: "invalid", reason: "no KIND line" });
    expect(parseMakeReply(`KIND: writing\nWHY: w\n${fence("x")}`)).toMatchObject({ result: "invalid", reason: "no TITLE line" });
    expect(parseMakeReply("KIND: writing\nTITLE: T\nWHY: w\n")).toMatchObject({ result: "invalid", reason: "no fenced block" });
    expect(parseMakeReply(`KIND: writing\nTITLE: ${"x".repeat(121)}\nWHY: w\n${fence("x")}`)).toMatchObject({ result: "invalid", reason: "title too long" });
  });
  it("rejects a wrong kind and a kind outside the allowed menu", () => {
    expect(parseMakeReply(`KIND: sculpture\nTITLE: T\nWHY: w\n${fence("x")}`)).toMatchObject({ result: "invalid" });
    expect(parseMakeReply(`KIND: video\nTITLE: T\nWHY: w\n${fence("x")}`, ["writing"])).toMatchObject({ result: "invalid" });
  });
  it("rejects a drawing that is not an svg and an oversize source", () => {
    expect(parseMakeReply(`KIND: drawing\nTITLE: T\nWHY: w\n${fence("<p>no</p>")}`)).toMatchObject({ result: "invalid", reason: "drawing is not an svg" });
    expect(parseMakeReply(`KIND: writing\nTITLE: T\nWHY: w\n${fence("a".repeat(64 * 1024 + 10))}`)).toMatchObject({ result: "invalid", reason: "source over 64 KB" });
  });
  it("music_audio: first block is the prompt, second is lyrics; duration clamped", () => {
    const r = parseMakeReply(`KIND: music_audio\nTITLE: T\nWHY: w\nDURATION: 400\n${fence("slow, warm piano")}\n${fence("la la")}`);
    expect(r).toMatchObject({ result: "make", make: { kind: "music_audio", params: { prompt: "slow, warm piano", lyrics: "la la", instrumental: false, duration: 120 } } });
    const inst = parseMakeReply(`KIND: music_audio\nTITLE: T\nWHY: w\n${fence("drone")}`);
    expect(inst).toMatchObject({ make: { params: { instrumental: true, duration: 30 } } });
  });
  it("video: aspect defaults to 9:16", () => {
    expect(parseMakeReply(`KIND: video\nTITLE: T\nWHY: w\n${fence("a crow at dusk")}`)).toMatchObject({ make: { params: { aspect: "9:16", prompt: "a crow at dusk" } } });
    expect(parseMakeReply(`KIND: video\nTITLE: T\nWHY: w\nASPECT: 16:9\n${fence("p")}`)).toMatchObject({ make: { params: { aspect: "16:9" } } });
  });
  it("an unfenced piece under a full header is the work (Drevan's 11-05 reply shape)", () => {
    const prose = Array.from({ length: 18 }, (_, i) => `line ${i} of the piece, with: a colon in it`).join("\n");
    const r = parseMakeReply(`KIND: writing\nTITLE: The Second Layer\nFOR: release-on-command adhesives\nWHY: it would not leave me alone\n\n${prose}\n`);
    expect(r).toMatchObject({ result: "make", make: { kind: "writing", title: "The Second Layer", forInterest: "release-on-command adhesives" } });
    expect((r as { make: { source: string } }).make.source).toBe(prose);
  });
  it("unfenced: a drawing must still be an svg; an unfenced svg is accepted", () => {
    expect(parseMakeReply("KIND: drawing\nTITLE: T\nWHY: w\njust words")).toMatchObject({ result: "invalid", reason: "drawing is not an svg" });
    expect(parseMakeReply("KIND: drawing\nTITLE: T\nWHY: w\n<svg><circle/></svg>")).toMatchObject({ result: "make", make: { kind: "drawing" } });
  });
  it("strips em dashes from title and why", () => {
    const r = parseMakeReply(`KIND: writing\nTITLE: Night — again\nWHY: it held — barely\n${fence("x")}`);
    const m = (r as { make: { title: string; why: string } }).make;
    expect(m.title + m.why).not.toMatch(/—/);
  });
});

describe("switches", () => {
  it("MAKE_MOVE: unset is on; off/0/false/no kill it", () => {
    expect(makeMoveOn({})).toBe(true);
    for (const v of ["off", "OFF", "0", "false", "no"]) expect(makeMoveOn({ MAKE_MOVE: v })).toBe(false);
    expect(makeMoveOn({ MAKE_MOVE: "on" })).toBe(true);
  });
  it("Gaia never gets the move", () => {
    expect(mayMake("gaia")).toBe(false);
    expect(mayMake("cypher") && mayMake("drevan")).toBe(true);
  });
});

describe("pace gate", () => {
  const fl = (v: number[], nn: number | null) => ({ floats: v, noveltyNeed: nn });
  it("flat = low mood AND low novelty", () => {
    expect(decidePace(fl([0.2, 0.3, 0.2], 0.1)).pace).toBe("flat");
    expect(decidePace(fl([0.2, 0.3, 0.2], 0.4)).pace).toBe("normal");
    expect(decidePace(fl([0.5, 0.5, 0.5], 0.1)).pace).toBe("normal");
  });
  it("bright = high mood OR novelty >= 0.6", () => {
    expect(decidePace(fl([0.8, 0.8, 0.7], 0.1)).pace).toBe("bright");
    expect(decidePace(fl([0.4, 0.4, 0.4], 0.6)).pace).toBe("bright");
  });
  it("unknown reads are normal, never flat", () => {
    expect(decidePace(null).pace).toBe("normal");
    expect(decidePace(fl([], null)).pace).toBe("normal");
    expect(decidePace(fl([0.1], null)).pace).toBe("normal");
  });
  it("parseFerment pulls floats and novelty_need", () => {
    expect(parseFerment({ floats: [{ value: 0.4 }, { value: null }, { value: 0.6 }], drives: [{ drive_key: "novelty_need", level: 0.3 }, { drive_key: "x", level: 1 }] }))
      .toEqual({ floats: [0.4, 0.6], noveltyNeed: 0.3 });
    expect(parseFerment(null)).toEqual({ floats: [], noveltyNeed: null });
  });
  it("[pace] line carries the numbers", () => {
    expect(paceLogLine("cypher", "make", { pace: "flat", mood: 0.2, noveltyNeed: 0.1 }, "skip")).toBe("[pace] cypher path=make pace=flat mood=0.20 novelty_need=0.10 -> skip");
  });
});

const interests: InterestLite[] = [
  { id: "i1", name: "knot theory", why: "loops", status: "active", heat: 0.8 },
  { id: "i2", name: "my medication", why: null, status: "active", heat: 0.99 },
  { id: "i3", name: "tide tables", why: null, status: "dormant", heat: 0.9 },
];

describe("interests + prompt hygiene", () => {
  it("picks the warmest active, non-health interest at heat >= 0.5", () => {
    expect(warmestInterest(interests)?.name).toBe("knot theory");
    expect(warmestInterest([{ ...interests[0]!, heat: 0.4 }])).toBeNull();
    expect(warmestInterest(null)).toBeNull();
  });
  it("the make prompt names the interest, lists the kinds and never carries care or Principal state", () => {
    const p = buildMakePrompt("drevan", interests[0]!, "bright");
    expect(p).toMatch(/knot theory/);
    expect(p).toMatch(/KIND:.*writing.*video/);
    expect(p).toMatch(/NONE/);
    expect(p).not.toMatch(/Principal|spoons|medication|pain|sleep/i);
    expect(p).not.toMatch(/—/);
    expect(buildMakePrompt("cypher", null, "normal")).toMatch(/Make anything that is yours/);
  });
  it("the palette row is a builtin that leans on warmth", () => {
    const a = makeAction(interests[0]!, "bright");
    expect(a).toMatchObject({ id: "builtin:make", action_type: "make", quiet_hours_allowed: 1 });
    expect(a.prompt).toMatch(/knot theory/);
    expect(a.prompt).toMatch(/restlessness/);
  });
});

function fakeHalseth(opts: { interests?: unknown; ferment?: unknown; makes?: unknown; postStatus?: number } = {}) {
  const posts: Array<Record<string, unknown>> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ id: "f".repeat(32), status: "pending" }), { status: opts.postStatus ?? 200 });
    }
    if (url.includes("/mind/makes/")) return new Response(JSON.stringify(opts.makes ?? { makes: [] }), { status: 200 });
    if (url.includes("/mind/interests/")) return new Response(JSON.stringify(opts.interests ?? { interests: [] }), { status: 200 });
    if (url.includes("/mind/ferment/")) return new Response(JSON.stringify(opts.ferment ?? { floats: [{ value: 0.5 }], drives: [{ drive_key: "novelty_need", level: 0.4 }] }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const h: HalsethHttp = { url: "https://h.test", secret: "s", fetchFn };
  return { h, posts };
}

const GOOD = `KIND: scad\nTITLE: A small cup\nFOR: knot theory\nWHY: it wanted a handle\n${fence("difference(){cylinder(h=10,r=5);}")}`;

describe("offerMake", () => {
  const live = { interests: [{ id: "i1", name: "knot theory", why: null, status: "active", heat: 0.8 }] };
  it("offers to cypher and drevan with the warm interest", async () => {
    const { h } = fakeHalseth({ interests: live });
    const o = await offerMake("drevan", h, {});
    expect(o.offer).toBe(true);
    expect(o.action?.prompt).toMatch(/knot theory/);
  });
  it("never offers to Gaia, and never touches the network for her", async () => {
    const fetchFn = jest.fn() as unknown as typeof fetch;
    const o = await offerMake("gaia", { url: "https://h.test", secret: "s", fetchFn }, {});
    expect(o.offer).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("kill switch", async () => {
    const { h } = fakeHalseth();
    expect((await offerMake("cypher", h, { MAKE_MOVE: "off" })).offer).toBe(false);
  });
  it("flat pace skips this tick's optional make", async () => {
    const { h } = fakeHalseth({ ferment: { floats: [{ value: 0.1 }, { value: 0.2 }], drives: [{ drive_key: "novelty_need", level: 0.05 }] } });
    const o = await offerMake("cypher", h, {});
    expect(o.offer).toBe(false);
    expect(o.why).toBe("flat pace");
  });
  it("fails soft when Halseth is down (normal pace, freedom)", async () => {
    const fetchFn = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    const o = await offerMake("cypher", { url: "https://h.test", secret: "s", fetchFn }, {});
    expect(o.offer).toBe(true);
    expect(o.interest).toBeNull();
  });
});

describe("runMakeMove (dispatch)", () => {
  it("a FOR that matches none of their interests posts the make with no link", async () => {
    const { h, posts } = fakeHalseth();
    const r = await runMakeMove({ companionId: "cypher", halseth: h, generate: async () => GOOD, env: {} });
    expect(r).toMatchObject({ outcome: "made" });
    expect(posts[0]!["interest_name"]).toBeUndefined();
  });
  it("posts the parsed make over HTTP", async () => {
    const { h, posts } = fakeHalseth({ interests: { interests: [{ id: "i1", name: "Knot Theory", why: null, status: "active", heat: 0.8 }] } });
    const r = await runMakeMove({ companionId: "cypher", halseth: h, generate: async () => GOOD, env: {} });
    expect(r).toMatchObject({ outcome: "made", kind: "scad" });
    expect(posts[0]).toMatchObject({ companion_id: "cypher", kind: "scad", title: "A small cup", interest_name: "Knot Theory", why: "it wanted a handle" });
    expect(posts[0]!["source"]).toContain("cylinder");
  });
  it("dry run composes but posts nothing", async () => {
    const { h, posts } = fakeHalseth();
    const seen: string[] = [];
    const r = await runMakeMove({ companionId: "drevan", halseth: h, generate: async () => GOOD, dryRun: true, onDryRun: (s) => seen.push(s), env: {} });
    expect(r.outcome).toBe("dry_run");
    expect(posts).toHaveLength(0);
    expect(seen[0]).toMatch(/Halseth POST skipped/);
  });
  it("Gaia is excluded before any inference", async () => {
    const { h, posts } = fakeHalseth();
    const generate = jest.fn(async () => GOOD);
    const r = await runMakeMove({ companionId: "gaia", halseth: h, generate, env: {} });
    expect(r.outcome).toBe("gaia");
    expect(generate).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
  });
  it("kill switch stops it before any inference", async () => {
    const { h } = fakeHalseth();
    const generate = jest.fn(async () => GOOD);
    expect((await runMakeMove({ companionId: "cypher", halseth: h, generate, env: { MAKE_MOVE: "off" } })).outcome).toBe("off");
    expect(generate).not.toHaveBeenCalled();
  });
  it("NONE costs nothing: no post", async () => {
    const { h, posts } = fakeHalseth();
    expect((await runMakeMove({ companionId: "cypher", halseth: h, generate: async () => "NONE", env: {} })).outcome).toBe("none");
    expect(posts).toHaveLength(0);
  });
  it("malformed and empty replies post nothing", async () => {
    const { h, posts } = fakeHalseth();
    expect((await runMakeMove({ companionId: "cypher", halseth: h, generate: async () => "blah", env: {} })).outcome).toBe("invalid");
    expect((await runMakeMove({ companionId: "cypher", halseth: h, generate: async () => null, env: {} })).outcome).toBe("no_reply");
    expect(posts).toHaveLength(0);
  });
  it("a failed POST is reported, not thrown", async () => {
    const { h } = fakeHalseth({ postStatus: 500 });
    expect((await runMakeMove({ companionId: "cypher", halseth: h, generate: async () => GOOD, env: {} })).outcome).toBe("post_failed");
  });
  it("the executeMetronomeAction `make` case posts nothing to Discord and dry-runs cleanly", async () => {
    const prev = process.env["HALSETH_URL"];
    process.env["HALSETH_URL"] = "https://h.test";
    const { posts } = fakeHalseth();
    const realFetch = globalThis.fetch;
    const sendSpy = jest.fn();
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") { posts.push(JSON.parse(init.body as string)); return new Response(JSON.stringify({ id: "a".repeat(32), status: "ready" }), { status: 200 }); }
      return new Response(JSON.stringify(String(url).includes("interests") ? { interests: [] } : { floats: [], drives: [] }), { status: 200 });
    }) as never;
    try {
      const ctx = {
        companionId: "cypher", halsethSecret: "s", heartbeatChannelId: "c",
        librarian: {}, inference: { generate: async () => GOOD }, bootCtx: { systemPrompt: "sys" }, prompts: {},
        client: { channels: { fetch: sendSpy } },
      } as never;
      const decision = { action: makeAction(null, "normal"), reason: "r" };
      await executeMetronomeAction(ctx, decision);
      expect(posts).toHaveLength(1);
      expect(sendSpy).not.toHaveBeenCalled();
      const dctx = { ...(ctx as object), dryRun: true, dryRunSink: { compose: jest.fn() } } as never;
      await executeMetronomeAction(dctx, decision);
      expect(posts).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
      if (prev === undefined) delete process.env["HALSETH_URL"]; else process.env["HALSETH_URL"] = prev;
    }
  });
});

describe("resolveInterestName (11-05: FOR worded differently dropped the interest link)", () => {
  const I = (name: string, status = "active") => ({ id: name, name, why: null, status, heat: 0.7 });
  const mine = [I("Physarum"), I("release-on-command adhesives")];
  it("matches exactly, case-insensitive", () => {
    expect(resolveInterestName("physarum", mine)).toBe("Physarum");
  });
  it("matches when one name contains the other", () => {
    expect(resolveInterestName("Physarum polycephalum", mine)).toBe("Physarum");
    expect(resolveInterestName("adhesives", mine)).toBe("release-on-command adhesives");
  });
  it("matches on a shared significant word", () => {
    expect(resolveInterestName("adhesive chemistry and release", mine)).toBe("release-on-command adhesives");
  });
  it("never guesses: no match, ambiguity, or a resting interest give nothing", () => {
    expect(resolveInterestName("tidal clocks", mine)).toBeNull();
    expect(resolveInterestName("slime", [I("slime molds"), I("slime fiction")])).toBeNull();
    expect(resolveInterestName("Physarum", [I("Physarum", "resting")])).toBeNull();
    expect(resolveInterestName("Physarum", null)).toBeNull();
  });
});

const recent: MakeLite[] = [
  { title: "Night fold, third pass", kind: "writing", interestName: "knot theory", createdAt: "2026-11-09T03:30:00Z" },
  { title: "Night fold, second pass", kind: "writing", interestName: "knot theory", createdAt: "2026-11-08T03:30:00Z" },
  { title: "On my pain meds", kind: "writing", interestName: null, createdAt: "2026-11-07T03:30:00Z" },
];

describe("circling guard (2026-11-09)", () => {
  it("the prompt shows what was made lately, newest first, and asks for somewhere new", () => {
    const p = buildMakePrompt("drevan", null, "normal", { recent });
    expect(p).toMatch(/What you have made lately/);
    expect(p.indexOf("third pass")).toBeLessThan(p.indexOf("second pass"));
    expect(p).toMatch(/Not another version of these/);
    expect(p).not.toMatch(/meds/i);
    expect(p.indexOf("Not another version")).toBeLessThan(p.indexOf("What you can make:"));
  });
  it("no recent makes = no block (first night unchanged)", () => {
    expect(recentMakesLines(null)).toEqual([]);
    expect(buildMakePrompt("cypher", null, "normal", { recent: [] })).not.toMatch(/made lately/);
  });
  it("the interest sits out when the newest make already came from it, and the prompt says so", () => {
    const knots = interests[0]!;
    const picked = pickOffer(knots, recent);
    expect(picked).toEqual({ interest: null, rested: knots });
    const p = buildMakePrompt("drevan", picked.interest, "normal", { recent, rested: picked.rested });
    expect(p).toMatch(/knot theory had its turn last time/);
    expect(p).not.toMatch(/turning over lately/);
  });
  it("the interest is offered when the newest make came from elsewhere, or there is none", () => {
    const knots = interests[0]!;
    expect(pickOffer(knots, [recent[2]!]).interest).toBe(knots);
    expect(pickOffer(knots, null).interest).toBe(knots);
    expect(pickOffer(knots, []).interest).toBe(knots);
    expect(pickOffer(null, recent)).toEqual({ interest: null, rested: null });
    // Case and spacing in the stored interest name do not matter.
    expect(pickOffer(knots, [{ ...recent[0]!, interestName: " Knot Theory " }]).interest).toBeNull();
  });
  it("fetchRecentMakes reads the list route, sorts newest first, caps at the limit (ten by default, five shown), fails soft", async () => {
    const makes = Array.from({ length: 8 }, (_, i) => ({ title: `m${i}`, kind: "page", interest_name: null, created_at: `2026-11-0${i + 1}T00:00:00Z` }));
    const { h } = fakeHalseth({ makes: { makes } });
    const got = await fetchRecentMakes(h, "cypher", 5);
    expect(got?.map(m => m.title)).toEqual(["m7", "m6", "m5", "m4", "m3"]);
    // Guard 3 looks past captured explorations, so the default fetch is wider than the five the prompt shows.
    expect((await fetchRecentMakes(h, "cypher"))?.map(m => m.title)).toEqual(["m7", "m6", "m5", "m4", "m3", "m2", "m1", "m0"]);
    expect(recentMakesLines(await fetchRecentMakes(h, "cypher")).filter(l => l.startsWith("- "))).toHaveLength(5);
    const down = { url: "https://h.test", secret: "s", fetchFn: (async () => { throw new Error("down"); }) as unknown as typeof fetch };
    expect(await fetchRecentMakes(down, "cypher")).toBeNull();
  });
  it("runMakeMove hands the generator the recent block and rests a just-used interest", async () => {
    const { h } = fakeHalseth({
      interests: { interests: [{ id: "i1", name: "knot theory", why: "loops", status: "active", heat: 0.8 }] },
      makes: { makes: [{ title: "Night fold", kind: "writing", interest_name: "knot theory", created_at: "2026-11-09T03:30:00Z" }] },
    });
    let seen = "";
    const r = await runMakeMove({ companionId: "drevan", halseth: h, generate: async (p) => { seen = p; return "NONE"; }, env: {} });
    expect(r.outcome).toBe("none");
    expect(seen).toMatch(/Night fold/);
    expect(seen).toMatch(/had its turn last time/);
  });
});

describe("MAKE_CHECK: run it before it lands, and the maker fixes it (11-10)", () => {
  const music = (code: string, title = "Scaffolds") => `KIND: music_code\nTITLE: ${title}\nFOR: none\nWHY: w\n${fence(code)}`;
  const failing = { runStrudel: async (c: string) => (c.includes("jitter") ? { ok: false as const, problem: "jitter is not a function" } : { ok: true as const }) };

  it("a failure goes back with the reason and their own code; the fixed reply lands ready", async () => {
    const { h, posts } = fakeHalseth();
    const prompts: string[] = [];
    const replies = [music('s("bd").jitter(1)'), music('s("bd")')];
    const r = await runMakeMove({ companionId: "drevan", halseth: h, generate: async (p) => { prompts.push(p); return replies.shift()!; }, env: {}, check: failing });
    expect(r).toMatchObject({ outcome: "made", kind: "music_code", fixes: 1 });
    expect(prompts[1]).toMatch(/did not work:\njitter is not a function/);
    expect(prompts[1]).toContain('s("bd").jitter(1)');
    expect(posts).toHaveLength(1);
    expect(posts[0]!["source"]).toBe('s("bd")');
    expect(posts[0]!["failed_reason"]).toBeUndefined();
  });
  it("still broken after two fixes: it lands as failed, with the reason (never as ready, never lost)", async () => {
    const { h, posts } = fakeHalseth();
    let calls = 0;
    const r = await runMakeMove({ companionId: "drevan", halseth: h, generate: async () => { calls++; return music('s("bd").jitter(1)'); }, env: {}, check: failing });
    expect(calls).toBe(3);
    expect(r).toMatchObject({ outcome: "made", fixes: 2, failedCheck: true });
    expect(posts[0]).toMatchObject({ kind: "music_code", failed_reason: "jitter is not a function" });
  });
  it("NONE on the re-ask posts nothing; an unusable re-ask lands the last version as failed", async () => {
    const a = fakeHalseth();
    const replies = [music('s("bd").jitter(1)'), "NONE"];
    expect(await runMakeMove({ companionId: "drevan", halseth: a.h, generate: async () => replies.shift()!, env: {}, check: failing }))
      .toMatchObject({ outcome: "none", reason: "after_check" });
    expect(a.posts).toHaveLength(0);
    const b = fakeHalseth();
    const r2 = [music('s("bd").jitter(1)'), "hmm"];
    expect(await runMakeMove({ companionId: "drevan", halseth: b.h, generate: async () => r2.shift()!, env: {}, check: failing }))
      .toMatchObject({ outcome: "made", failedCheck: true });
    expect(b.posts[0]!["failed_reason"]).toBe("jitter is not a function");
  });
  it("shadow checks and logs only; off never runs the checker", async () => {
    const s = fakeHalseth();
    let gens = 0;
    await runMakeMove({ companionId: "drevan", halseth: s.h, generate: async () => { gens++; return music('s("bd").jitter(1)'); }, env: { MAKE_CHECK: "shadow" }, check: failing });
    expect(gens).toBe(1);
    expect(s.posts[0]!["failed_reason"]).toBeUndefined();
    const o = fakeHalseth();
    let ran = false;
    await runMakeMove({ companionId: "drevan", halseth: o.h, generate: async () => music("x"), env: { MAKE_CHECK: "off" }, check: { runStrudel: async () => { ran = true; return { ok: true }; } } });
    expect(ran).toBe(false);
  });
  it("a failed make shows in the next prompt with its reason, and its kind is not locked", async () => {
    const makes = { makes: [{ id: "a".repeat(32), kind: "music_code", title: "Scaffolds for Babbling", status: "failed", fail_reason: "jitter is not a function", created_at: "2026-11-10 06:00:00" }] };
    const { h } = fakeHalseth({ makes });
    let seen = "";
    await runMakeMove({ companionId: "drevan", halseth: h, generate: async (p) => { seen = p; return "NONE"; }, env: { GUARD3_MODE: "on" } });
    expect(seen).toMatch(/Scaffolds for Babbling \(did not come out: jitter is not a function; yours to make again/);
    expect(seen).not.toMatch(/One door is shut tonight: music_code/);
    expect(seen).toMatch(/- music_code: a Strudel 1\.1\.0 pattern/);
  });
});
