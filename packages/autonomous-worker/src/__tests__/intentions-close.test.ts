// Halseth mig 0179: a run that pursued a DUE intention closes the date even when nothing landed, so the
// same intention cannot win the seed every night and spend a credit each time.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../halseth-client.js", () => ({
  writeJournalEntry: vi.fn(), writePattern: vi.fn(), writeMarker: vi.fn(), writeWmNote: vi.fn(),
  examineDream: vi.fn(), appendLog: vi.fn(async () => {}), logProjectWork: vi.fn(async () => {}),
}));

import { closeUnloggedPursuit } from "../phases/write.js";
import { logProjectWork } from "../halseth-client.js";
import type { PipelineContext } from "../types.js";

const ctxOf = (project: PipelineContext["project"], logged = false) =>
  ({ companionId: "drevan", runId: "r1", project, projectLogged: logged } as unknown as PipelineContext);

describe("closeUnloggedPursuit", () => {
  beforeEach(() => { vi.mocked(logProjectWork).mockReset().mockResolvedValue(undefined); });

  it("closes an unlogged due pursuit with a plain 'nothing landed' line and pursued:true", async () => {
    const ctx = ctxOf({ id: "p1", title: "t", intention: "i", pursuingDue: true });
    await closeUnloggedPursuit(ctx, "no journal entry");
    expect(vi.mocked(logProjectWork)).toHaveBeenCalledWith(
      "p1", "drevan", expect.stringContaining("nothing landed (no journal entry)"), { pursued: true });
    expect(ctx.projectLogged).toBe(true);
  });

  it("does nothing when the work already logged, or the run was not a due pursuit", async () => {
    await closeUnloggedPursuit(ctxOf({ id: "p1", title: "t", intention: "i", pursuingDue: true }, true), "x");
    await closeUnloggedPursuit(ctxOf({ id: "p1", title: "t", intention: "i" }), "x");
    await closeUnloggedPursuit(ctxOf(null), "x");
    expect(vi.mocked(logProjectWork)).not.toHaveBeenCalled();
  });

  it("never throws when Halseth is down (the date stays; tomorrow's run tries again)", async () => {
    vi.mocked(logProjectWork).mockRejectedValue(new Error("down"));
    const ctx = ctxOf({ id: "p1", title: "t", intention: "i", pursuingDue: true });
    await expect(closeUnloggedPursuit(ctx, "the run failed")).resolves.toBeUndefined();
    expect(ctx.projectLogged).toBe(false);
  });
});
