// B65 guard 3 WIRING (2026-11-10): guard3.test.ts proves the pure doors and runMakeMove; this proves the
// guard is actually CALLED from the real runHeartbeat (palette door) and from the heartbeat's `make` move
// (menu lock, re-ask, version parent) with the mode read from process.env, which is how the VPS sets it.
// The gate for flipping GUARD3_MODE from shadow to on (STATUS: "after the runHeartbeatBody wiring test passes").
// Shadow byte-identity of the make prompt/parse/POST is also covered at the runMakeMove seam in
// guard3.test.ts; here it is asserted through the heartbeat against `off`.
import { describe, it, expect, afterEach, beforeEach, jest } from "@jest/globals";
import { runHeartbeat } from "../autonomous-core.js";
import { setCareState } from "../care-state.js";
import { menuWithout, lockedKindLine } from "../guard3.js";
import { heartbeatCtx, inWindowOf, row } from "./fixtures/heartbeat-ctx.js";

let restore: () => void = () => {};
let logs: string[] = [];
const realFetch = globalThis.fetch;
const ENV_KEYS = ["REACH_DM", "GUARD3_MODE", "GUARD3_MODE_DREVAN", "PALETTE_REPEAT_HOURS", "HALSETH_URL", "MAKE_MOVE"];

beforeEach(() => {
  process.env["REACH_DM"] = "on";
  logs = [];
  jest.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
});
afterEach(() => {
  restore();
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) delete process.env[k];
  for (const c of ["cypher", "drevan", "gaia"]) setCareState(c, null);
  jest.restoreAllMocks();
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const g3Lines = () => logs.filter(l => l.startsWith("[guard3]"));

describe("door 3 through the real runHeartbeat", () => {
  const palette = () => [
    { ...row("share_observation", "the share"), last_fired_at: hoursAgo(2) },
    { ...row("post_heartbeat", "a light post"), last_fired_at: hoursAgo(60) },
    { ...row("offer_presence", "I am here"), last_fired_at: hoursAgo(1) },
    { ...row("check_in_on_principal", "how are you"), last_fired_at: hoursAgo(1) },
    { ...row("nothing", "stay quiet"), last_fired_at: hoursAgo(1) },
  ];

  it("on: a move fired inside the window is absent from the decision prompt; older and exempt moves stay", async () => {
    process.env["GUARD3_MODE"] = "on";
    restore = inWindowOf("cypher");
    const h = heartbeatCtx({ companionId: "cypher", palette: palette(), choose: "stay quiet" });
    await runHeartbeat(h.ctx);
    const p = h.prompts[0]!;
    expect(p).not.toContain("(type: share_observation"); // the 24h "fired" recap line may still name it
    expect(p).toContain("a light post");
    expect(p).toContain("I am here");
    expect(p).toContain("how are you");
    expect(p).toContain("stay quiet");
    expect(g3Lines().some(l => /palette mode=on .*removed=share_observation@2h/.test(l))).toBe(true);
  });

  it("shadow: the decision prompt is identical to off (nothing removed) and would_remove is logged", async () => {
    restore = inWindowOf("cypher");
    process.env["GUARD3_MODE"] = "off";
    const off = heartbeatCtx({ companionId: "cypher", palette: palette(), choose: "stay quiet" });
    await runHeartbeat(off.ctx);
    expect(g3Lines()).toEqual([]);
    process.env["GUARD3_MODE"] = "shadow";
    const sh = heartbeatCtx({ companionId: "cypher", palette: palette(), choose: "stay quiet" });
    await runHeartbeat(sh.ctx);
    expect(sh.prompts[0]).toContain("(type: share_observation");
    expect(sh.prompts[0]).toBe(off.prompts[0]);
    expect(g3Lines().some(l => /palette mode=shadow .*would_remove=share_observation@2h/.test(l))).toBe(true);
  });

  it("unset env is shadow (the code default): nothing removed", async () => {
    restore = inWindowOf("cypher");
    const h = heartbeatCtx({ companionId: "cypher", palette: palette(), choose: "stay quiet" });
    await runHeartbeat(h.ctx);
    expect(h.prompts[0]).toContain("(type: share_observation");
    expect(g3Lines()[0]).toContain("mode=shadow");
  });

  it("per-companion override and PALETTE_REPEAT_HOURS are honoured from process.env", async () => {
    process.env["GUARD3_MODE"] = "off";
    process.env["GUARD3_MODE_DREVAN"] = "on";
    process.env["PALETTE_REPEAT_HOURS"] = "1";
    restore = inWindowOf("drevan");
    const h = heartbeatCtx({ companionId: "drevan", palette: [{ ...row("share_observation", "the share"), last_fired_at: hoursAgo(2) }, row("nothing", "stay quiet")], choose: "stay quiet" });
    await runHeartbeat(h.ctx);
    expect(h.prompts[0]).toContain("(type: share_observation");
    expect(g3Lines()[0]).toContain("window_h=1");
  });

  it("on, under a care hold: the guard removes nothing", async () => {
    process.env["GUARD3_MODE"] = "on";
    restore = inWindowOf("cypher");
    setCareState("cypher", { care_hold: true } as never);
    const h = heartbeatCtx({ companionId: "cypher", palette: palette(), choose: "I am here", lines: ["Here."] });
    await runHeartbeat(h.ctx);
    const line = g3Lines().find(l => l.includes("palette"));
    expect(line).toBeDefined();
    expect(line).toMatch(/considered=0 removed=none/);
    expect(h.prompts[0]).toContain("I am here");
  });

  it("on, every move fresh: the model is never asked and nothing is sent", async () => {
    process.env["GUARD3_MODE"] = "on";
    restore = inWindowOf("cypher");
    const h = heartbeatCtx({ companionId: "cypher", palette: [{ ...row("share_observation", "the share"), last_fired_at: hoursAgo(1) }], choose: "the share" });
    await runHeartbeat(h.ctx);
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.dmSent).toEqual([]);
    expect(h.channelSent).toEqual([]);
  });
});

describe("the make move chosen through the real runHeartbeat", () => {
  const fence = (b: string) => "```\n" + b + "\n```";
  const PAGE = `KIND: page\nTITLE: Release-on-Command\nFOR: none\nWHY: again\n${fence("<html></html>")}`;
  const WRITING = `KIND: writing\nTITLE: A Fresh Thing\nFOR: none\nWHY: w\n${fence("words")}`;
  const VERSIONED = `KIND: writing\nTITLE: Release on Command\nFOR: none\nWHY: w\n${fence("words")}`;
  const makes = [
    { id: "e".repeat(32), title: "Night exploration", kind: "writing", origin_kind: "exploration", interest_name: null, created_at: "2026-11-09T09:00:00Z" },
    { id: "p".repeat(32), title: "Release-on-Command", kind: "page", origin_kind: null, interest_name: null, created_at: "2026-11-08T04:00:00Z" },
  ];
  let posts: Array<Record<string, unknown>> = [];
  function stubHalseth() {
    posts = [];
    process.env["HALSETH_URL"] = "https://h.test";
    globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: string }) => {
      const u = String(url);
      if (init?.method === "POST") { posts.push(JSON.parse(init.body as string)); return new Response(JSON.stringify({ id: "f".repeat(32), status: "ready" }), { status: 200 }); }
      if (u.includes("/mind/makes/")) return new Response(JSON.stringify({ makes }), { status: 200 });
      if (u.includes("/mind/interests/")) return new Response(JSON.stringify({ interests: [] }), { status: 200 });
      if (u.includes("/mind/ferment/")) return new Response(JSON.stringify({ floats: [{ value: 0.5 }], drives: [] }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
  }
  const run = async (lines: string[]) => {
    restore = inWindowOf("drevan");
    const h = heartbeatCtx({ companionId: "drevan", palette: [row("nothing", "stay quiet")], choose: "make", lines });
    await runHeartbeat(h.ctx);
    restore();
    return h;
  };

  it("on: the make prompt names the locked kind; a reply choosing it gets one re-ask; a second pick lands nothing", async () => {
    process.env["GUARD3_MODE"] = "on";
    stubHalseth();
    const h = await run([PAGE, PAGE]);
    const makePrompts = h.prompts.slice(1);
    expect(makePrompts).toHaveLength(2);
    expect(makePrompts[0]).toContain(lockedKindLine("page"));
    expect(makePrompts[0]).not.toMatch(/^- page: ONE self-contained/m);
    expect(makePrompts[1]).toContain("page is the shut door tonight");
    expect(menuWithout("page")).not.toContain("page");
    expect(posts).toHaveLength(0);
    expect(logs.some(l => /chose the locked kind twice/.test(l))).toBe(true);
    expect(g3Lines().some(l => /make mode=on locked_kind=page chose_locked=1/.test(l))).toBe(true);
  });

  it("on: the re-ask's open answer lands", async () => {
    process.env["GUARD3_MODE"] = "on";
    stubHalseth();
    await run([PAGE, WRITING]);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ kind: "writing", title: "A Fresh Thing" });
    expect(posts[0]!["parent_id"]).toBeUndefined();
  });

  it("on: a near-duplicate title posts with parent_id", async () => {
    process.env["GUARD3_MODE"] = "on";
    stubHalseth();
    await run([VERSIONED]);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ kind: "writing", parent_id: "p".repeat(32) });
  });

  it("shadow: prompt, parse and POST are exactly those of off (locked kind stays on the menu, no parent_id)", async () => {
    stubHalseth();
    process.env["GUARD3_MODE"] = "off";
    const off = await run([PAGE]);
    const offPosts = posts;
    stubHalseth();
    process.env["GUARD3_MODE"] = "shadow";
    const sh = await run([PAGE]);
    expect(sh.prompts).toEqual(off.prompts);
    expect(posts).toEqual(offPosts);
    expect(posts).toHaveLength(1);
    expect(posts[0]!["parent_id"]).toBeUndefined();
    expect(sh.prompts[1]).toMatch(/^- page: ONE self-contained/m);
    expect(g3Lines().some(l => /make mode=shadow would_lock_kind=page chose_locked=1/.test(l))).toBe(true);
  });
});
