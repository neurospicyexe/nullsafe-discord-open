import { jest, describe, it, expect } from "@jest/globals";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  TurnTrace, runWithTurn, currentTurn, mintTurnId, turnFields, turnToken, runAutonomousTurn,
} from "../turn-telemetry.js";
import { appendTurnRow, turnLogPath, type TurnHubRow } from "../turn-hub.js";
import { railSuppressed } from "../rail-telemetry.js";
import { voiceGateLine, judgeVoice } from "../voice-gate.js";
import { buildServedRow } from "../served-memory.js";

function mk(over: Record<string, unknown> = {}) {
  const hub: TurnHubRow[] = [];
  const lines: string[] = [];
  const trace = new TurnTrace({
    companionId: "drevan", channelId: "chan-1", messageId: "m-1", side: "principal",
    createdAt: null, enqueuedAt: 1_000, startedAt: 1_000, queueMs: 0, settleMs: 0, gathered: 0, catchup: false,
    now: () => 1_000, log: (l: string) => lines.push(l), hub: (r) => { hub.push(r); }, auditEnabled: false,
    ...over,
  });
  return { trace, hub, lines };
}

describe("mintTurnId", () => {
  it("is <companion>-<YYYYMMDDTHHMMSS UTC>-<4 base36>", () => {
    const id = mintTurnId("drevan", Date.UTC(2026, 10, 11, 21, 4, 9, 321), () => 0.123456);
    expect(id).toMatch(/^drevan-20261111T210409-[0-9a-z]{4}$/);
  });
  it("differs across calls at the same instant", () => {
    const ids = new Set(Array.from({ length: 50 }, () => mintTurnId("cypher", 5_000)));
    expect(ids.size).toBeGreaterThan(40);
  });
});

describe("one id per run", () => {
  it("a reply, a lull release and a pass on the SAME message get distinct ids and their kinds", () => {
    const a = mk({ kind: "reply" });
    const b = mk({ kind: "lull_release" });
    const c = mk({ kind: "pass" });
    expect(new Set([a.trace.turnId, b.trace.turnId, c.trace.turnId]).size).toBe(3);
    for (const t of [a, b, c]) { t.trace.setOutcome("posted"); t.trace.emit(); }
    expect(a.hub[0]!.kind).toBe("reply");
    expect(b.hub[0]!.kind).toBe("lull_release");
    expect(c.hub[0]!.kind).toBe("pass");
    // all three answered the same Discord message
    expect([a, b, c].map((t) => t.hub[0]!.answered)).toEqual(["m-1", "m-1", "m-1"]);
  });

  it("an earlier burst message that was absorbed is kind=absorb with its own id; the answering run lists it", () => {
    const absorbed = mk({ messageId: "m-early" });
    absorbed.trace.finish({ superseded: true });
    expect(absorbed.hub[0]!.kind).toBe("absorb");
    expect(absorbed.hub[0]!.answered).toBeNull();

    const answering = mk({ messageId: "m-late", absorbed: ["m-early", "m-mid"] });
    answering.trace.setOutcome("posted");
    answering.trace.addSent(["s-1", "s-2", "s-1"]);
    answering.trace.finish({ superseded: false });
    expect(answering.hub[0]!.absorbed).toEqual(["m-early", "m-mid"]);
    expect(answering.hub[0]!.sent).toEqual(["s-1", "s-2"]);
    expect(answering.trace.turnId).not.toBe(absorbed.trace.turnId);
  });

  it("the [turn] line carries the same id and kind", () => {
    const { trace, lines } = mk();
    trace.setOutcome("posted");
    trace.emit();
    const j = JSON.parse(lines[0]!.replace(/^\[turn\] /, ""));
    expect(j.turn).toBe(trace.turnId);
    expect(j.kind).toBe("reply");
  });
});

describe("stamp helpers", () => {
  it("turnFields / turnToken are empty outside a run and carry the id inside", () => {
    expect(turnFields()).toEqual({});
    expect(turnToken()).toBe("");
    const { trace } = mk();
    runWithTurn(trace, () => {
      expect(turnFields()).toEqual({ turn: trace.turnId });
      expect(turnToken()).toBe(` turn=${trace.turnId}`);
    });
  });

  it("survives awaits and detached work started inside the run", async () => {
    const { trace } = mk();
    const seen: Array<string | undefined> = [];
    await runWithTurn(trace, async () => {
      await new Promise((r) => setTimeout(r, 1));
      void Promise.resolve().then(() => seen.push(turnFields().turn));
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(seen).toEqual([trace.turnId]);
  });

  it("[rail] gets turn appended and keeps every existing field", () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      railSuppressed("drevan", "echo" as never, { channelId: "c1", score: 0.5, threshold: 0.4 });
      const outside = JSON.parse(String(log.mock.calls.at(-1)![0]).replace(/^\[rail\] /, ""));
      expect(outside.turn).toBeUndefined();
      expect(outside).toMatchObject({ c: "drevan", rail: "echo", ch: "c1", score: 0.5, thr: 0.4 });
      const { trace } = mk();
      runWithTurn(trace, () => railSuppressed("drevan", "echo" as never, { channelId: "c1" }));
      const inside = JSON.parse(String(log.mock.calls.at(-1)![0]).replace(/^\[rail\] /, ""));
      expect(inside.turn).toBe(trace.turnId);
      expect(inside.rail).toBe("echo");
    } finally { log.mockRestore(); }
  });

  it("[voice-gate] line ends with turn= inside a run and is byte-identical outside", () => {
    const v = judgeVoice("A plain reply with nothing generic.");
    const plain = voiceGateLine("drevan", "shadow", v, 12);
    expect(plain).not.toContain("turn=");
    const { trace } = mk();
    const stamped = runWithTurn(trace, () => voiceGateLine("drevan", "shadow", v, 12));
    expect(stamped).toBe(`${plain} turn=${trace.turnId}`);
  });

  it("served-memory rows carry turn and only add the field", () => {
    const row = buildServedRow({ at: "t", companion: "c", channelId: "ch", messageId: "m", transcriptId: null, outcome: "posted", served: new Map(), turn: "c-1-abcd" });
    expect(row.turn).toBe("c-1-abcd");
    const bare = buildServedRow({ at: "t", companion: "c", channelId: "ch", messageId: "m", transcriptId: null, outcome: "posted", served: new Map() });
    expect("turn" in bare).toBe(false);
  });
});

describe("autonomous runs", () => {
  it.each(["heartbeat", "make", "interest_offer", "consolidation", "spouse_note", "med"] as const)(
    "%s runs inside a trace of its own kind and writes one hub row",
    async (kind) => {
      const hub: TurnHubRow[] = [];
      let seen: string | undefined;
      const out = await runAutonomousTurn(kind, "cypher", async () => { seen = currentTurn()?.turnId; return 7; }, { init: { hub: (r) => { hub.push(r); }, now: () => 1_000 } });
      expect(out).toBe(7);
      expect(seen).toMatch(/^cypher-/);
      expect(hub).toHaveLength(1);
      expect(hub[0]).toMatchObject({ kind, c: "cypher", turn: seen, answered: null, outcome: "ok", ch: null });
    },
  );

  it("a throw is recorded as outcome=error and still propagates", async () => {
    const hub: TurnHubRow[] = [];
    await expect(runAutonomousTurn("heartbeat", "gaia", async () => { throw new Error("boom"); }, { init: { hub: (r) => { hub.push(r); } } })).rejects.toThrow("boom");
    expect(hub[0]!.outcome).toBe("error");
  });

  it("inside an existing run it does not mint a second id (a typed dry run belongs to that turn)", async () => {
    const { trace, hub } = mk();
    let inner: string | undefined;
    await runWithTurn(trace, () => runAutonomousTurn("heartbeat", "drevan", async () => { inner = currentTurn()?.turnId; }));
    expect(inner).toBe(trace.turnId);
    expect(hub).toHaveLength(0);
  });

  it("record=false (an idle poll) writes no hub row", async () => {
    const hub: TurnHubRow[] = [];
    await runAutonomousTurn("med", "drevan", async () => [] as string[], { record: (r) => r.length > 0, init: { hub: (r) => { hub.push(r); } } });
    expect(hub).toHaveLength(0);
  });

  it("writes no [turn] line (the turn report counts replies only)", async () => {
    const lines: string[] = [];
    await runAutonomousTurn("heartbeat", "drevan", async () => {}, { init: { log: (l) => lines.push(l), hub: () => {} } });
    expect(lines).toHaveLength(0);
  });
});

describe("hub row shape", () => {
  it("is ids and counts only: exact key set, no text field, no text values", () => {
    const { trace, hub } = mk({ pkOriginal: "pk-orig-1", absorbed: ["a1"] });
    trace.setReplyTarget("reply-9");
    trace.setTranscript("drevan:chan-1:2026w46");
    trace.addHermesCall(); trace.addHermesCall(); trace.addRegenerate();
    trace.addUsage(1000, 200); trace.addUsage(50, 10);
    trace.addSent(["s1"]);
    trace.setOutcome("posted");
    trace.emit();
    const row = hub[0]!;
    expect(Object.keys(row).sort()).toEqual([
      "absorbed", "answered", "at", "c", "ch", "hermes_calls", "kind", "outcome", "pk_original",
      "regenerates", "reply_target", "sent", "tokens_in", "tokens_out", "transcript", "turn",
    ]);
    for (const banned of ["content", "text", "message", "reply", "body", "fact", "note"]) expect(Object.keys(row)).not.toContain(banned);
    expect(row).toMatchObject({
      c: "drevan", ch: "chan-1", answered: "m-1", absorbed: ["a1"], pk_original: "pk-orig-1", reply_target: "reply-9",
      transcript: "drevan:chan-1:2026w46", hermes_calls: 2, regenerates: 1, sent: ["s1"], outcome: "posted", tokens_in: 1050, tokens_out: 210,
    });
    // every value is an id, a count, a timestamp or an enum: short and prose-free
    for (const v of Object.values(row).flat()) {
      if (typeof v === "string") expect(v.length).toBeLessThan(60);
    }
  });

  it("a run that did not post has answered=null", () => {
    const { trace, hub } = mk();
    trace.setOutcome("skipped:echo");
    trace.emit();
    expect(hub[0]!.answered).toBeNull();
  });

  it("emits exactly once", () => {
    const { trace, hub } = mk();
    trace.emit(); trace.emit();
    expect(hub).toHaveLength(1);
  });
});

describe("hub log writer (fail-open)", () => {
  const row = (): TurnHubRow => ({
    turn: "t-1", at: "x", c: "drevan", kind: "reply", ch: null, answered: null, absorbed: [], pk_original: null,
    reply_target: null, transcript: null, hermes_calls: 0, regenerates: 0, sent: [], outcome: "posted", tokens_in: 0, tokens_out: 0,
  });

  it("appends one JSON line per row to TURN_LOG", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "turnlog-")), "sub", "turns.jsonl");
    await appendTurnRow(row(), { TURN_LOG: file });
    await appendTurnRow({ ...row(), turn: "t-2" }, { TURN_LOG: file });
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.turn)).toEqual(["t-1", "t-2"]);
  });

  it("an unwritable path resolves without throwing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "turnlog-"));
    // the target is a directory: appendFile fails
    await expect(appendTurnRow(row(), { TURN_LOG: dir })).resolves.toBeUndefined();
  });

  it("a throwing sink never reaches the turn", () => {
    const { trace } = mk({ hub: () => { throw new Error("disk on fire"); } });
    trace.setOutcome("posted");
    expect(() => trace.emit()).not.toThrow();
  });

  it("a rejecting sink never reaches the turn", async () => {
    const { trace } = mk({ hub: () => Promise.reject(new Error("nope")) });
    trace.setOutcome("posted");
    expect(() => trace.emit()).not.toThrow();
    await new Promise((r) => setTimeout(r, 1));
  });

  it("TURN_LOG=off disables; unset under test does not touch the default path", async () => {
    expect(turnLogPath({ TURN_LOG: "off" })).toBeNull();
    expect(turnLogPath({})).toBe("/app/logs/turns.jsonl");
    await appendTurnRow(row(), { NODE_ENV: "test" });
    expect(existsSync("/app/logs/turns.jsonl")).toBe(false);
  });
});
