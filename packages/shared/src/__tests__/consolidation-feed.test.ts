// 2026-11-10: the close narrator restated a 10-03 relational row ("mid-tournament") for five weeks, and got
// Cypher's blood-pressure history as "state". The relational rows never reach the narrator now.
import { jest, describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { consolidateSession, narratorStateFeed } from "../consolidation.js";

beforeAll(() => { process.env["LEDGER_DISTILL"] = "off"; });
afterAll(() => { delete process.env["LEDGER_DISTILL"]; });

const triadRead = {
  response_key: "summary",
  triad: {
    drevan: {
      soma: { heat: "warm", compound_state: "bell-still-ringing-quietly" },
      relational_toward_principal: { state_text: "mid-tournament, tearing up without sadness", state_type: "witness", noted_at: "2026-10-03T15:31:24.280Z" },
      last_note_sent: { to_id: "cypher", content: "Got your note.", created_at: "2026-11-10T04:04:53.566Z" },
    },
    cypher: {
      soma: { soma_float_1: 0.75 },
      relational_toward_principal: { state_text: "origin of their blood-pressure anxiety", state_type: "witness", noted_at: "2026-09-21T15:55:02.597Z" },
      last_note_sent: null,
    },
    gaia: { soma: null, relational_toward_principal: null, last_note_sent: null },
  },
  meta: { operation: "triad_state_read" },
};

describe("narratorStateFeed", () => {
  it("cuts every companion's relational row and keeps soma and the last note", () => {
    const out = narratorStateFeed(triadRead);
    expect(out).not.toContain("relational_toward_principal");
    expect(out).not.toContain("tournament");
    expect(out).not.toContain("blood-pressure");
    expect(out).toContain("bell-still-ringing-quietly");
    expect(out).toContain("Got your note.");
    expect(JSON.parse(out).triad.gaia).toEqual({ soma: null, last_note_sent: null });
  });
  it("passes strings, nulls and non-triad objects through", () => {
    expect(narratorStateFeed("SOMA: present.")).toBe("SOMA: present.");
    expect(narratorStateFeed(null)).toBe("");
    expect(narratorStateFeed({ a: 1 })).toBe('{"a":1}');
  });
});

describe("consolidateSession narrator prompt", () => {
  it("never hands the narrator a relational row", async () => {
    const generate = jest.fn<(...a: unknown[]) => Promise<string | null>>().mockResolvedValue(
      JSON.stringify({ title: "Quiet.", summary: "The stretch was quiet.", state_hint: "at_rest" }),
    );
    await consolidateSession({
      companionId: "cypher",
      librarian: { ask: jest.fn<() => Promise<unknown>>().mockResolvedValue(triadRead), writeHandoff: jest.fn<() => Promise<void>>().mockResolvedValue(undefined) } as any,
      inference: { generate } as any,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    const prompt = JSON.stringify(generate.mock.calls[0]);
    expect(prompt).not.toContain("tournament");
    expect(prompt).not.toContain("blood-pressure");
    expect(prompt).toContain("bell-still-ringing-quietly");
  });
});
