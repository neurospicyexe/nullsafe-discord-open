// Turn key phase 2 (Hand-off/SPEC-turn-key-2026-11-11.md): every Halseth request made inside a run carries
// X-Turn-Id, and bot-written journal rows carry a `turn:<id>` tag captured BEFORE any retry queue.
import { describe, it, expect } from "@jest/globals";
import { TurnTrace, runWithTurn, turnTags, withTurnHeader, TURN_HEADER } from "../turn-telemetry.js";
import { LibrarianClient } from "../librarian.js";
import { dispatchWriteback } from "../writeback-gate.js";

function trace(): TurnTrace {
  return new TurnTrace({
    companionId: "drevan", channelId: "chan-1", messageId: "m-1", side: "principal",
    createdAt: null, enqueuedAt: 1_000, startedAt: 1_000, queueMs: 0, settleMs: 0, gathered: 0, catchup: false,
    now: () => 1_000, log: () => {}, hub: () => {}, auditEnabled: false,
  });
}

type Call = { url: string; init?: RequestInit };
function client(calls: Call[]) {
  const fetchFn = async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  return new LibrarianClient({ url: "https://h", secret: "s", companionId: "drevan", fetch: fetchFn as never });
}
const hdr = (init?: RequestInit) => new Headers(init?.headers).get(TURN_HEADER);
const bodyTags = (init?: RequestInit) => (JSON.parse(String(init?.body)) as { tags: string[] }).tags;

describe("turnTags", () => {
  it("is [] outside a run and [turn:<id>] inside one", () => {
    expect(turnTags()).toEqual([]);
    const t = trace();
    runWithTurn(t, () => expect(turnTags()).toEqual([`turn:${t.turnId}`]));
  });
});

describe("withTurnHeader", () => {
  it("returns the same init object outside a run", () => {
    const init = { headers: { A: "1" } };
    expect(withTurnHeader("https://h/x", init)).toBe(init);
    expect(withTurnHeader("https://h/x", undefined)).toBeUndefined();
  });
  it("adds the header to all three HeadersInit shapes and keeps the others", () => {
    const t = trace();
    runWithTurn(t, () => {
      const obj = withTurnHeader("https://h", { method: "POST", headers: { Authorization: "Bearer s" } })!;
      expect(obj.method).toBe("POST");
      expect(new Headers(obj.headers).get("authorization")).toBe("Bearer s");
      expect(hdr(obj)).toBe(t.turnId);
      const h = withTurnHeader("https://h", { headers: new Headers({ Authorization: "Bearer s" }) })!;
      expect(hdr(h)).toBe(t.turnId);
      expect(new Headers(h.headers).get("authorization")).toBe("Bearer s");
      const arr = withTurnHeader("https://h", { headers: [["Authorization", "Bearer s"]] })!;
      expect(hdr(arr)).toBe(t.turnId);
      expect(hdr(withTurnHeader("https://h", undefined))).toBe(t.turnId);
    });
  });
  it("leaves a Request input with no init alone (an init headers would replace its auth)", () => {
    const t = trace();
    runWithTurn(t, () => expect(withTurnHeader(new Request("https://h"), undefined)).toBeUndefined());
  });
});

describe("LibrarianClient sends X-Turn-Id", () => {
  it("inside a run, on the ask and on raw REST calls; never outside one", async () => {
    const calls: Call[] = [];
    const c = client(calls);
    await c.journalJudgeNote("x", "chan-1", "m-1");
    expect(hdr(calls[0]!.init)).toBeNull();
    const t = trace();
    await runWithTurn(t, () => c.journalJudgeNote("x", "chan-1", "m-1"));
    expect(hdr(calls[1]!.init)).toBe(t.turnId);
    expect(new Headers(calls[1]!.init?.headers).get("authorization")).toBe("Bearer s");
  });
});

describe("journal turn tag", () => {
  it("journalSpeech and journalJudgeNote carry extra tags; external_id never holds the turn", async () => {
    const calls: Call[] = [];
    const c = client(calls);
    await c.journalSpeech("hi", "chan-1", "d-9", null, ["reply_to:m-1", "turn:drevan-20261112T000000-abcd"]);
    await c.journalJudgeNote("note", "chan-1", "m-1", null, ["turn:drevan-20261112T000000-abcd"]);
    for (const k of calls) {
      expect(bodyTags(k.init)).toContain("turn:drevan-20261112T000000-abcd");
      expect(String((JSON.parse(String(k.init?.body)) as { external_id?: string }).external_id)).not.toContain("turn");
    }
  });
  it("dispatchWriteback passes the CAPTURED tag, even when the write runs after the run has ended", async () => {
    const seen: (readonly string[] | undefined)[] = [];
    const lib = {
      journalJudgeNote: async (_c: string, _ch?: string, _m?: string, _r?: string | null, extra?: readonly string[]) => { seen.push(extra); },
      addCompanionNote: async () => {},
    };
    const t = trace();
    const captured = runWithTurn(t, () => turnTags());
    // Simulates a queue retry: no run is active when dispatch executes.
    await dispatchWriteback({ type: "companion_note", content: "n" } as never, lib as never,
      { promoteToWm: false, channelId: "chan-1", messageId: "m-1", extraTags: captured });
    expect(seen[0]).toEqual([`turn:${t.turnId}`]);
  });
});
