// B65 step 7: the palette sorted by the loudest need (need-sort.ts). Pure sort + the real runHeartbeat wiring.
import { describe, it, expect, afterEach, beforeEach, jest } from "@jest/globals";
import { needSortMode, servesOf, rankNeeds, sortPaletteByNeed, needSortLogLine, DEFAULT_SERVES, REACH_DM_MIRROR } from "../need-sort.js";
import { DM_LANE_ACTIONS } from "../reach-dm.js";
import { runHeartbeat } from "../autonomous-core.js";
import { setCareState } from "../care-state.js";
import { heartbeatCtx, inWindowOf, row } from "./fixtures/heartbeat-ctx.js";

const a = (action_type: string, serves?: string | null) => ({ action_type, ...(serves !== undefined ? { serves } : {}) });
const drive = (drive_key: string, level: number, threshold: number) => ({ drive_key, level, threshold });

describe("needSortMode", () => {
  it("default shadow; per-companion wins; junk is shadow; off is off", () => {
    expect(needSortMode({})).toBe("shadow");
    expect(needSortMode({ PALETTE_NEED_SORT: "on" })).toBe("on");
    expect(needSortMode({ PALETTE_NEED_SORT: "on", PALETTE_NEED_SORT_GAIA: "off" }, "gaia")).toBe("off");
    expect(needSortMode({ PALETTE_NEED_SORT: "banana" })).toBe("shadow");
    expect(needSortMode({ PALETTE_NEED_SORT: "0" })).toBe("off");
  });
});

describe("serves + needs", () => {
  it("the row's value wins; NULL/absent falls back to the type default; unknown is none", () => {
    expect(servesOf(a("make"))).toBe("expression");
    expect(servesOf(a("make", "novelty"))).toBe("novelty");
    expect(servesOf(a("nothing", null))).toBe("rest");
    expect(servesOf(a("mystery", "junk"))).toBe("none");
    expect(DEFAULT_SERVES["offer_presence"]).toBe("relational");
  });
  it("ranks by pressure (level over the drive's own threshold), ignores unknown drives", () => {
    const n = rankNeeds([drive("rest_need", 0.5, 0.75), drive("expression_need", 0.6, 0.65), drive("novelty_need", 0.7, 0.65), drive("weird", 1, 1)]);
    expect(n.map(x => x.need)).toEqual(["novelty", "expression", "rest"]);
    expect(rankNeeds(null)).toEqual([]);
  });
});

describe("sortPaletteByNeed", () => {
  const palette = [a("write_journal"), a("offer_presence"), a("share_media"), a("send_reminder"), a("nothing"), a("make")];

  it("orders rest/novelty/expression moves by the loudest need and pins every reach-class move to its slot", () => {
    const v = sortPaletteByNeed(palette, [drive("novelty_need", 0.9, 0.65), drive("expression_need", 0.3, 0.7), drive("rest_need", 0.1, 0.75)]);
    expect(v.loudest).toBe("novelty");
    expect(v.ordered.map(x => x.action_type)).toEqual(["write_journal", "offer_presence", "share_media", "send_reminder", "make", "nothing"]);
    expect(v.ordered.indexOf(palette[1]!)).toBe(1); // offer_presence pinned
    expect(v.ordered.indexOf(palette[3]!)).toBe(3); // send_reminder pinned
    expect(v.ordered.indexOf(palette[2]!)).toBe(2); // share_media reaches Principal: pinned
    expect(v.moved).toBe(true);
    expect(v.pinned).toBe(3);
  });
  it("moves that reach Principal stay pinned even when the need they are tagged with is loudest", () => {
    const a = (action_type: string) => ({ action_type });
    const palette = [a("nothing"), a("share_media"), a("make"), a("show_made"), a("write_note_to_principal"), a("share_observation"), a("write_journal")];
    const v = sortPaletteByNeed(palette, [drive("expression_need", 2, 0.5), drive("novelty_need", 0.1, 1), drive("rest_need", 0.1, 1)]);
    for (const t of ["share_media", "show_made", "write_note_to_principal", "share_observation"]) {
      expect(v.ordered.findIndex(x => x.action_type === t)).toBe(palette.findIndex(x => x.action_type === t));
    }
    expect(v.ordered[0]!.action_type).toBe("make");
  });
  it("the pin mirror matches reach-dm DM_LANE_ACTIONS exactly", () => {
    expect([...REACH_DM_MIRROR].sort()).toEqual([...DM_LANE_ACTIONS].sort());
  });
  it("is a permutation: nothing is added or removed", () => {
    const v = sortPaletteByNeed(palette, [drive("expression_need", 1, 0.65)]);
    expect([...v.ordered].sort((x, y) => x.action_type.localeCompare(y.action_type))).toEqual([...palette].sort((x, y) => x.action_type.localeCompare(y.action_type)));
  });
  it("a loud relational need does NOT pull relational moves forward (reach is never paced by need)", () => {
    const v = sortPaletteByNeed(palette, [drive("relational_need", 1, 0.5), drive("expression_need", 0.2, 0.65)]);
    expect(v.loudest).toBe("relational");
    expect(v.ordered.indexOf(palette[1]!)).toBe(1);
    expect(v.ordered.slice(0, 1)[0]!.action_type).toBe("write_journal"); // expression (rank 1) still beats rest/novelty (unranked)
  });
  it("Gaia unmarked: expression sits at zero pressure and ranks after a risen need", () => {
    const v = sortPaletteByNeed([a("write_feeling"), a("nothing")], [drive("expression_need", 0, 0.6), drive("rest_need", 0.5, 0.8)]);
    expect(v.ordered.map(x => x.action_type)).toEqual(["nothing", "write_feeling"]);
  });
  it("unreadable drives leave the palette untouched; stable on ties", () => {
    const v = sortPaletteByNeed(palette, null);
    expect(v.moved).toBe(false);
    expect(v.ordered).toEqual(palette);
    const t = sortPaletteByNeed([a("share_observation"), a("write_journal")], [drive("expression_need", 0.5, 0.5)]);
    expect(t.ordered.map(x => x.action_type)).toEqual(["share_observation", "write_journal"]);
    expect(t.moved).toBe(false);
  });
  it("a row's own serves is honoured by the sort", () => {
    const v = sortPaletteByNeed([a("write_journal"), a("make", "novelty")], [drive("novelty_need", 0.9, 0.65), drive("expression_need", 0.1, 0.65)]);
    expect(v.ordered.map(x => x.action_type)).toEqual(["make", "write_journal"]);
  });
  it("the log line carries names and numbers only", () => {
    const v = sortPaletteByNeed(palette, [drive("rest_need", 0.9, 0.65)]);
    const l = needSortLogLine("cypher", "shadow", v);
    expect(l).toMatch(/^\[need-sort\] cypher mode=shadow loudest=rest needs=rest:0\.90 pinned=3 would_reorder=1 order=/);
    expect(needSortLogLine("cypher", "on", v)).toContain("reordered=1");
  });
});

// ── through the real runHeartbeat ────────────────────────────────────────────────────────────────────

let restore: () => void = () => {};
let logs: string[] = [];
const realFetch = globalThis.fetch;
const ENV_KEYS = ["REACH_DM", "PALETTE_NEED_SORT", "PALETTE_NEED_SORT_CYPHER", "GUARD3_MODE", "HALSETH_URL", "MAKE_MOVE"];

beforeEach(() => {
  process.env["REACH_DM"] = "on";
  process.env["GUARD3_MODE"] = "off";
  logs = [];
  jest.spyOn(console, "log").mockImplementation((...x: unknown[]) => { logs.push(x.map(String).join(" ")); });
});
afterEach(() => {
  restore();
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) delete process.env[k];
  for (const c of ["cypher", "drevan", "gaia"]) setCareState(c, null);
  jest.restoreAllMocks();
});

describe("the heartbeat wiring", () => {
  const extra = [drive("novelty_need", 0.2, 0.65), drive("expression_need", 0.95, 0.7), drive("rest_need", 0.1, 0.75)];
  const nsLines = () => logs.filter(l => l.startsWith("[need-sort]"));

  it("on: the decision prompt lists the loudest-need move first; the reach move keeps its slot; nothing is removed", async () => {
    process.env["PALETTE_NEED_SORT"] = "on";
    restore = inWindowOf("cypher");
    const base = [row("nothing", "stay quiet"), row("share_observation", "the share"), row("offer_presence", "I am here"), row("write_journal", "a page")];
    const h = heartbeatCtx({ companionId: "cypher", palette: base, choose: "stay quiet", extraDrives: extra });
    await runHeartbeat(h.ctx);
    const p = h.prompts[0]!;
    for (const t of ["share_observation", "offer_presence", "write_journal", "nothing"]) expect(p).toContain(`(type: ${t}`);
    // expression moves (share_observation, write_journal) outrank rest (nothing), which gave up the first slot
    expect(p.indexOf("(type: share_observation")).toBeLessThan(p.indexOf("(type: nothing"));
    expect(p.indexOf("(type: offer_presence")).toBeGreaterThan(p.indexOf("(type: share_observation"));
    expect(nsLines().some(l => /mode=on loudest=expression .*reordered=1/.test(l))).toBe(true);
  });

  it("shadow (and unset): byte-identical prompt to off; would_reorder logged", async () => {
    restore = inWindowOf("cypher");
    const mk = () => [row("nothing", "stay quiet"), row("share_observation", "the share"), row("offer_presence", "I am here"), row("write_journal", "a page")];
    process.env["PALETTE_NEED_SORT"] = "off";
    const off = heartbeatCtx({ companionId: "cypher", palette: mk(), choose: "stay quiet", extraDrives: extra });
    await runHeartbeat(off.ctx);
    expect(nsLines()).toEqual([]);
    delete process.env["PALETTE_NEED_SORT"];
    const sh = heartbeatCtx({ companionId: "cypher", palette: mk(), choose: "stay quiet", extraDrives: extra });
    await runHeartbeat(sh.ctx);
    expect(sh.prompts[0]).toBe(off.prompts[0]);
    expect(nsLines().some(l => /mode=shadow loudest=expression .*would_reorder=1/.test(l))).toBe(true);
  });

  it("no extra drives (an older Halseth): the order is unchanged even when on", async () => {
    process.env["PALETTE_NEED_SORT"] = "on";
    restore = inWindowOf("cypher");
    const mk = () => [row("nothing", "stay quiet"), row("share_observation", "the share"), row("write_journal", "a page")];
    const withDrives = heartbeatCtx({ companionId: "cypher", palette: mk(), choose: "stay quiet" });
    await runHeartbeat(withDrives.ctx);
    const p = withDrives.prompts[0]!;
    expect(p.indexOf("(type: nothing")).toBeLessThan(p.indexOf("(type: share_observation"));
  });
});
