// The Discord render of conversation ENDINGS (halseth contract 0.15.0, 2026-09-23).
//
// This surface is the one that matters most for this change: the threads are Discord threads,
// and the bot wire is built by a projection that never calls halseth's buildContinuityBlock --
// so shipping the field to the Claude.ai path alone would have left the bots exactly as blind
// as before. These tests pin the render itself.

import { formatRecentContext } from "../librarian.js";

const base = { synthesis_summary: null, ground_threads: [], ground_handoff: null, rag_excerpts: [] };

describe("formatRecentContext -- [Recently ended]", () => {
  it("quotes a landed resolution and names who closed it", () => {
    const out = formatRecentContext({
      ...base,
      closed_conversations: [{
        seed_author: "principal", seed_gist: "the floor", ending: "landed",
        resolution: "the quiet is the floor we both stand on.", landed_by: "gaia", turn_count: 6,
      }],
    });
    expect(out).toContain("[Recently ended");
    expect(out).toContain("the quiet is the floor we both stand on.");
    // Attribution is load-bearing: threads are triad-shared, so an unattributed closing line
    // reads to the next companion as their own conclusion.
    expect(out).toContain("closed by gaia");
  });

  it("never quotes a spent thread's bracketed reason code as prose", () => {
    const out = formatRecentContext({
      ...base,
      closed_conversations: [{
        seed_author: "cypher", seed_gist: "a topic", ending: "spent",
        resolution: "[faded: turn budget]", landed_by: null, turn_count: 22,
      }],
    });
    expect(out).toContain("retired on length");
    expect(out).not.toContain("[faded:");
  });

  it("reports a quiet thread as unclosed and invents nothing", () => {
    const out = formatRecentContext({
      ...base,
      closed_conversations: [{
        seed_author: "principal", seed_gist: "Dre im awake but at what cost", ending: "quiet",
        resolution: null, landed_by: null, turn_count: 39,
      }],
    });
    expect(out).toContain("went quiet");
    expect(out).toContain("Never closed");
    expect(out).toContain("39 turns");
  });

  it("renders no section at all when nothing ended recently", () => {
    // The anti-loop guard, at the render layer as well as the query: an empty week must be
    // silent rather than repeating the same endings at every boot.
    expect(formatRecentContext({ ...base, closed_conversations: [] })).not.toContain("Recently ended");
    expect(formatRecentContext({ ...base })).not.toContain("Recently ended");
  });
});

// ── The allowlist ────────────────────────────────────────────────────────────────
//
// botOrient does not spread the wire payload; it maps a fixed list of fields onto its
// result. A field can therefore be present on the wire AND on the DTO type and still be
// dropped at runtime, with TypeScript perfectly satisfied -- the same shape as the pm2 env
// allowlist trap, and the reason this file's render tests cannot catch it: they call
// formatRecentContext directly and never pass through the mapping.
//
// This was a real defect during the 0.15.0 build, found by reading the mapping rather than
// by a failing test. The assertion exists so it cannot come back quietly.
describe("botOrient -- field allowlist", () => {
  it("passes closed_conversations through to the render layer", async () => {
    const { LibrarianClient } = await import("../librarian.js");
    const client = new LibrarianClient({
      url: "https://example.invalid", secret: "x", companionId: "cypher",
    } as ConstructorParameters<typeof LibrarianClient>[0]);

    const ending = {
      seed_author: "principal", seed_gist: "a thread", ending: "landed",
      resolution: "it landed here.", landed_by: "gaia", turn_count: 6,
    };
    (client as unknown as { ask: (q: string) => Promise<unknown> }).ask =
      async () => ({ data: { closed_conversations: [ending] } });

    const orient = await client.botOrient();
    expect(orient?.closed_conversations).toEqual([ending]);

    // And it must survive all the way into the rendered prompt text.
    expect(formatRecentContext({ ...base, ...orient! })).toContain("it landed here.");
  });

  it("passes tray_nudge and open-loop ages through (halseth 0.32.0)", async () => {
    const { LibrarianClient } = await import("../librarian.js");
    const client = new LibrarianClient({
      url: "https://example.invalid", secret: "x", companionId: "drevan",
    } as ConstructorParameters<typeof LibrarianClient>[0]);
    const nudge = "[Tray] 20 drafts waiting in your tray, oldest 4d. Yours to decide; nothing is kept for you.";
    (client as unknown as { ask: (q: string) => Promise<unknown> }).ask =
      async () => ({ data: { tray_nudge: nudge, open_loops: [{ id: "abcdef12-0", loop_text: "finish the thing", opened_ago: "3 days ago" }] } });
    const orient = await client.botOrient();
    expect(orient?.tray_nudge).toBe(nudge);
    const text = formatRecentContext({ ...base, ...orient! });
    expect(text).toContain("20 drafts waiting in your tray, oldest 4d");
    expect(text).toContain("#abcdef12 finish the thing (opened 3 days ago)");
  });

  it("no tray_nudge or age on the wire renders neither", () => {
    const text = formatRecentContext({ ...base, open_loops: [{ id: "abcdef12-0", loop_text: "old loop" }] } as never);
    expect(text).not.toContain("[Tray]");
    expect(text).toContain("#abcdef12 old loop");
    expect(text).not.toContain("(opened");
  });
});
