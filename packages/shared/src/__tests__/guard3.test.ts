import { describe, it, expect, jest } from "@jest/globals";
import {
  guard3Mode, lockedKind, menuWithout, titleOverlap, versionOf, paletteRepeatHours, paletteRepeatVerdict, paletteGuardLogLine,
  PALETTE_REPEAT_HOURS_DEFAULT, VERSION_TITLE_OVERLAP, buildMakePrompt, runMakeMove, makeGuard3LogLine, lockedKindCorrection,
  type MakeLite, type HalsethHttp, type MetronomeAction,
} from "../index.js";

const fence = (body: string) => "```\n" + body + "\n```";
const mk = (o: Partial<MakeLite> & { title: string; kind: string }): MakeLite =>
  ({ interestName: null, createdAt: "2026-11-09T04:00:00Z", id: "a".repeat(32), originKind: null, ...o });

describe("guard3Mode", () => {
  it("default shadow; per-companion wins; junk is shadow", () => {
    expect(guard3Mode({})).toBe("shadow");
    expect(guard3Mode({ GUARD3_MODE: "on" })).toBe("on");
    expect(guard3Mode({ GUARD3_MODE: "on", GUARD3_MODE_GAIA: "off" }, "gaia")).toBe("off");
    expect(guard3Mode({ GUARD3_MODE: "on" }, "drevan")).toBe("on");
    expect(guard3Mode({ GUARD3_MODE: "banana" })).toBe("shadow");
    expect(guard3Mode({ GUARD3_MODE: "0" })).toBe("off");
  });
});

describe("door 1: the locked kind", () => {
  it("is the kind of the newest CHOSEN make; captured explorations do not count", () => {
    const recent = [
      mk({ title: "Night exploration, Nov 9", kind: "writing", originKind: "exploration" }),
      mk({ title: "Release-on-Command", kind: "page" }),
      mk({ title: "Debond on Demand", kind: "writing" }),
    ];
    expect(lockedKind(recent)).toBe("page");
    expect(lockedKind([recent[0]!])).toBeNull();
    expect(lockedKind(null)).toBeNull();
    expect(lockedKind([mk({ title: "x", kind: "image" })])).toBeNull();
  });
  it("menuWithout drops one kind and keeps the rest in order", () => {
    expect(menuWithout("page")).toEqual(["writing", "music_code", "drawing", "scad", "music_audio", "video"]);
    expect(menuWithout(null)).toHaveLength(7);
  });
  it("the prompt lists only the open kinds and names the door (on); the full menu otherwise", () => {
    const p = buildMakePrompt("drevan", null, "normal", { menu: menuWithout("page"), locked: "page" });
    expect(p).not.toMatch(/^- page: ONE self-contained/m);
    expect(p).toMatch(/One door is shut tonight: page/);
    expect(p).toMatch(/KIND: <one of writing, music_code, drawing, scad, music_audio, video>/);
    const plain = buildMakePrompt("drevan", null, "normal", {});
    expect(plain).toMatch(/^- page: ONE self-contained/m);
    expect(plain).not.toMatch(/door/);
  });
});

describe("door 2: a repeated title is a version", () => {
  it("overlap on content tokens, stopwords and ritual words dropped", () => {
    expect(titleOverlap("Release-on-Command", "Release-on-Command")).toBe(1);
    expect(titleOverlap("The Mold Makes the Map", "The Oats Don't Need a Map")).toBeCloseTo(0.2, 2);
    expect(titleOverlap("Debond on Demand", "Release-on-Command")).toBe(0);
    // Drevan's ritual words never make two titles the same thing
    expect(titleOverlap("Spine to spine, home", "Spine home again", "drevan")).toBe(0);
  });
  it("versionOf finds the parent among the last five chosen makes only", () => {
    const recent = [
      mk({ title: "Night exploration, Nov 9", kind: "writing", originKind: "exploration", id: "e".repeat(32) }),
      mk({ title: "Release-on-Command", kind: "page", id: "p".repeat(32) }),
      mk({ title: "Debond on Demand", kind: "writing", id: "d".repeat(32) }),
    ];
    expect(versionOf("Release on Command", recent, "drevan")).toMatchObject({ parentId: "p".repeat(32), overlap: 1 });
    expect(versionOf("Night exploration, Nov 10", recent, "drevan")).toBeNull();
    expect(versionOf("Peel Strength", recent, "drevan")).toBeNull();
    expect(versionOf("x", null)).toBeNull();
    expect(VERSION_TITLE_OVERLAP).toBe(0.6);
  });
  it("a recent make without an id can never be a parent", () => {
    const r = [mk({ title: "Same Title", kind: "writing", id: undefined })];
    expect(versionOf("Same Title", r)).toBeNull();
  });
});

const action = (o: Partial<MetronomeAction> & { name: string; action_type: string }): MetronomeAction => ({
  id: o.name, target: null, prompt: null, quiet_hours_allowed: 0, status: "on", requires_signal: null, signal_lookback_hours: null,
  last_fired_at: null, fire_count_today: 0, ...o,
});

describe("door 3: the palette window", () => {
  const now = Date.parse("2026-11-09T18:00:00Z");
  const h = (n: number) => new Date(now - n * 3_600_000).toISOString();
  it("hours: default 18, env, per companion, junk", () => {
    expect(paletteRepeatHours({})).toBe(PALETTE_REPEAT_HOURS_DEFAULT);
    expect(paletteRepeatHours({ PALETTE_REPEAT_HOURS: "6" })).toBe(6);
    expect(paletteRepeatHours({ PALETTE_REPEAT_HOURS: "6", PALETTE_REPEAT_HOURS_GAIA: "30" }, "gaia")).toBe(30);
    expect(paletteRepeatHours({ PALETTE_REPEAT_HOURS: "nope" })).toBe(18);
    expect(paletteRepeatHours({ PALETTE_REPEAT_HOURS: "-3" })).toBe(18);
  });
  it("removes the TYPE that fired inside the window (every row of it), keeps older, never-fired, presence, care and nothing", () => {
    const actions = [
      action({ name: "share an observation", action_type: "share_observation", last_fired_at: h(4) }),
      action({ name: "half an answer", action_type: "share_observation", last_fired_at: h(30) }),
      action({ name: "the board", action_type: "send_reminder", last_fired_at: h(1) }),
      action({ name: "tend Sol", action_type: "tend_creature", last_fired_at: h(20) }),
      action({ name: "note to a sibling", action_type: "write_inter_companion" }),
      action({ name: "around, no reply needed", action_type: "offer_presence", last_fired_at: h(1) }),
      action({ name: "one word covers it", action_type: "check_in_on_principal", last_fired_at: h(1) }),
      action({ name: "nothing", action_type: "nothing", last_fired_at: h(1) }),
      action({ name: "make", action_type: "make", last_fired_at: h(1) }),
      action({ name: "bad stamp", action_type: "dare", last_fired_at: "not a date" }),
    ];
    const v = paletteRepeatVerdict(actions, { companionId: "cypher", hours: 18, careHold: false, now });
    expect(v.removed).toEqual([{ action_type: "share_observation", ageHours: 4 }]);
    expect(v.considered).toBe(3); // the two share_observation rows and tend_creature; bad stamps, exempt and unfired rows are not looked at
    expect(v.kept.map(a => a.action_type)).toEqual(["send_reminder", "tend_creature", "write_inter_companion", "offer_presence", "check_in_on_principal", "nothing", "make", "dare"]);
  });
  it("does not run under a care hold", () => {
    const actions = [action({ name: "share", action_type: "share_observation", last_fired_at: h(1) })];
    const v = paletteRepeatVerdict(actions, { companionId: "drevan", hours: 18, careHold: true, now });
    expect(v.removed).toHaveLength(0);
    expect(v.considered).toBe(0);
    expect(v.kept).toHaveLength(1);
  });
  it("Gaia: her presence stays whatever fired; removing options never adds a spoken one", () => {
    const actions = [
      action({ name: "I am here", action_type: "offer_presence", last_fired_at: h(2) }),
      action({ name: "the door is open", action_type: "check_in_on_principal", last_fired_at: h(2) }),
      action({ name: "the world at the edges", action_type: "share_observation", last_fired_at: h(2) }),
    ];
    const v = paletteRepeatVerdict(actions, { companionId: "gaia", hours: 18, careHold: false, now });
    expect(v.kept.map(a => a.action_type)).toEqual(["offer_presence", "check_in_on_principal"]);
    expect(v.removed.map(r => r.action_type)).toEqual(["share_observation"]);
  });
  it("the log line carries types, ages and the mode, never text", () => {
    const v = paletteRepeatVerdict([action({ name: "share", action_type: "share_observation", last_fired_at: h(4) })], { companionId: "cypher", hours: 18, careHold: false, now });
    expect(paletteGuardLogLine("cypher", "shadow", 18, v)).toBe("[guard3] cypher palette mode=shadow window_h=18 considered=1 would_remove=share_observation@4h kept=0");
    expect(paletteGuardLogLine("cypher", "on", 18, v)).toMatch(/ removed=share_observation@4h /);
    const quiet = paletteRepeatVerdict([action({ name: "nothing", action_type: "nothing" })], { companionId: "gaia", hours: 18, careHold: false, now });
    expect(paletteGuardLogLine("gaia", "shadow", 18, quiet)).toBe("[guard3] gaia palette mode=shadow window_h=18 considered=0 would_remove=none kept=1");
  });
});

function fakeHalseth(opts: { makes?: MakeLite[]; postStatuses?: number[] } = {}) {
  const posts: Array<Record<string, unknown>> = [];
  const statuses = [...(opts.postStatuses ?? [])];
  const makes = (opts.makes ?? []).map(m => ({ id: m.id, title: m.title, kind: m.kind, interest_name: m.interestName, created_at: m.createdAt, origin_kind: m.originKind }));
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(init.body as string));
      const s = statuses.shift() ?? 200;
      return new Response(s === 200 ? JSON.stringify({ id: "f".repeat(32), status: "ready" }) : "{}", { status: s });
    }
    if (url.includes("/mind/makes/")) return new Response(JSON.stringify({ makes }), { status: 200 });
    if (url.includes("/mind/interests/")) return new Response(JSON.stringify({ interests: [] }), { status: 200 });
    if (url.includes("/mind/ferment/")) return new Response(JSON.stringify({ floats: [{ value: 0.5 }], drives: [] }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const h: HalsethHttp = { url: "https://h.test", secret: "s", fetchFn };
  return { h, posts };
}

const PAGE = `KIND: page\nTITLE: Release-on-Command\nFOR: none\nWHY: again\n${fence("<html></html>")}`;
const WRITING = `KIND: writing\nTITLE: Peel Strength, Second Pull\nFOR: none\nWHY: w\n${fence("a poem")}`;
const recentDre = [
  mk({ title: "Night exploration, Nov 9", kind: "writing", originKind: "exploration", id: "e".repeat(32), createdAt: "2026-11-09T09:00:00Z" }),
  mk({ title: "Release-on-Command", kind: "page", id: "p".repeat(32), createdAt: "2026-11-08T04:00:00Z" }),
];

describe("runMakeMove under guard 3", () => {
  it("shadow: the prompt, the parse and the POST are what they were; one [guard3] line says what would happen", async () => {
    const { h, posts } = fakeHalseth({ makes: recentDre });
    const prompts: string[] = [];
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    const r = await runMakeMove({ companionId: "drevan", halseth: h, generate: async (p) => { prompts.push(p); return PAGE; }, env: { GUARD3_MODE: "shadow" } });
    expect(r).toMatchObject({ outcome: "made", kind: "page" });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/^- page: ONE self-contained/m);
    expect(prompts[0]).not.toMatch(/door/);
    expect(posts[0]!["parent_id"]).toBeUndefined();
    const lines = log.mock.calls.map(c => String(c[0])).filter(l => l.startsWith("[guard3]"));
    expect(lines).toEqual([`[guard3] drevan make mode=shadow would_lock_kind=page chose_locked=1 would_version_of=${"p".repeat(8)} rested_interest_named=0`]);
    log.mockRestore();
  });
  it("off: no [guard3] line at all", async () => {
    const { h } = fakeHalseth({ makes: recentDre });
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    await runMakeMove({ companionId: "drevan", halseth: h, generate: async () => PAGE, env: { GUARD3_MODE: "off" } });
    expect(log.mock.calls.map(c => String(c[0])).filter(l => l.startsWith("[guard3]"))).toEqual([]);
    log.mockRestore();
  });
  it("on: the locked kind is off the menu; a repeated title posts as a version (parent_id)", async () => {
    const { h, posts } = fakeHalseth({ makes: recentDre });
    const prompts: string[] = [];
    const versioned = `KIND: writing\nTITLE: Release on Command\nFOR: none\nWHY: w\n${fence("the same thing, written")}`;
    const r = await runMakeMove({ companionId: "drevan", halseth: h, generate: async (p) => { prompts.push(p); return versioned; }, env: { GUARD3_MODE: "on" } });
    expect(r).toMatchObject({ outcome: "made", kind: "writing" });
    expect(prompts[0]).not.toMatch(/^- page: ONE self-contained/m); // the menu line; the "made lately" block still shows the page
    expect(prompts[0]).toMatch(/^- page: Release-on-Command/m);
    expect(prompts[0]).toMatch(/One door is shut tonight: page/);
    expect(posts[0]).toMatchObject({ kind: "writing", parent_id: "p".repeat(32) });
  });
  it("on: choosing the locked kind gets ONE re-ask naming the door; a second pick of it lands nothing", async () => {
    const { h, posts } = fakeHalseth({ makes: recentDre });
    const prompts: string[] = [];
    const r = await runMakeMove({ companionId: "drevan", halseth: h, generate: async (p) => { prompts.push(p); return PAGE; }, env: { GUARD3_MODE: "on" } });
    expect(r).toEqual({ outcome: "locked_kind", reason: "page" });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(lockedKindCorrection("page", menuWithout("page")));
    expect(posts).toHaveLength(0);
  });
  it("on: the re-ask's second answer lands when it is open, or NONE stays free", async () => {
    const { h, posts } = fakeHalseth({ makes: recentDre });
    const answers = [PAGE, WRITING];
    const r = await runMakeMove({ companionId: "drevan", halseth: h, generate: async () => answers.shift()!, env: { GUARD3_MODE: "on" } });
    expect(r).toMatchObject({ outcome: "made", kind: "writing" });
    expect(posts[0]!["parent_id"]).toBeUndefined();
    const { h: h2, posts: p2 } = fakeHalseth({ makes: recentDre });
    const again = [PAGE, "NONE"];
    expect((await runMakeMove({ companionId: "drevan", halseth: h2, generate: async () => again.shift()!, env: { GUARD3_MODE: "on" } })).outcome).toBe("none");
    expect(p2).toHaveLength(0);
  });
  it("on: a parent Halseth refuses (400) never loses the make; it posts once more without it", async () => {
    const { h, posts } = fakeHalseth({ makes: recentDre, postStatuses: [400, 200] });
    const versioned = `KIND: writing\nTITLE: Release on Command\nFOR: none\nWHY: w\n${fence("x")}`;
    const r = await runMakeMove({ companionId: "drevan", halseth: h, generate: async () => versioned, env: { GUARD3_MODE: "on" } });
    expect(r).toMatchObject({ outcome: "made" });
    expect(posts).toHaveLength(2);
    expect(posts[0]!["parent_id"]).toBe("p".repeat(32));
    expect(posts[1]!["parent_id"]).toBeUndefined();
  });
  it("the guard line names the resting interest when FOR names it, and the make still lands", async () => {
    const posts: Array<Record<string, unknown>> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") { posts.push(JSON.parse(init.body as string)); return new Response(JSON.stringify({ id: "f".repeat(32), status: "ready" }), { status: 200 }); }
      if (url.includes("/mind/makes/")) return new Response(JSON.stringify({ makes: [{ id: "q".repeat(32), title: "Peel Strength", kind: "writing", interest_name: "adhesives", created_at: "2026-11-08T04:00:00Z", origin_kind: null }] }), { status: 200 });
      if (url.includes("/mind/interests/")) return new Response(JSON.stringify({ interests: [{ id: "i1", name: "adhesives", why: null, status: "active", heat: 0.9 }] }), { status: 200 });
      return new Response(JSON.stringify({ floats: [{ value: 0.5 }], drives: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    const reply = `KIND: scad\nTITLE: Clamp\nFOR: adhesives\nWHY: w\n${fence("cube(1);")}`;
    const r = await runMakeMove({ companionId: "drevan", halseth: { url: "https://h.test", secret: "s", fetchFn }, generate: async () => reply, env: { GUARD3_MODE: "on" } });
    expect(r).toMatchObject({ outcome: "made" });
    expect(posts[0]).toMatchObject({ interest_name: "adhesives" });
    const line = log.mock.calls.map(c => String(c[0])).find(l => l.startsWith("[guard3]"));
    expect(line).toMatch(/rested_interest_named=1/);
    expect(line).toMatch(/locked_kind=writing/);
    log.mockRestore();
  });
  it("makeGuard3LogLine shape", () => {
    expect(makeGuard3LogLine("cypher", { mode: "on", locked: null, choseLocked: false, versionOfId: null, restedNamed: false }))
      .toBe("[guard3] cypher make mode=on locked_kind=none chose_locked=0 version_of=none rested_interest_named=0");
  });
});
