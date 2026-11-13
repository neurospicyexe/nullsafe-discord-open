// Dated intentions (Halseth mig 0179): the worker's two Halseth calls. The due read is a pure GET that
// fails to null (an older Halseth 404s and the run picks its seed as before); the log write carries
// `pursued` only when this run pursued a due intention.
import { describe, it, expect, vi, afterEach } from "vitest";
import { getDueIntention, logProjectWork } from "../halseth-client.js";

afterEach(() => { vi.unstubAllGlobals(); });

function stubFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

describe("getDueIntention", () => {
  it("reads mode / due / would", async () => {
    const due = { id: "i1", title: "t", intention: "x", status: "open", created_at: "c", due_at: "d", next_step: null };
    const calls = stubFetch(200, { mode: "on", due, would: null });
    expect(await getDueIntention("drevan")).toEqual({ mode: "on", due, would: null });
    expect(calls[0]!.url).toMatch(/\/mind\/intentions\/drevan\/due$/);
    expect(calls[0]!.init.method).toBe("GET");
  });
  it("an older Halseth (404) or any failure is null", async () => {
    stubFetch(404, { error: "not found" });
    expect(await getDueIntention("drevan")).toBeNull();
  });
});

describe("logProjectWork", () => {
  it("sends pursued:true only for a due-intention run", async () => {
    const calls = stubFetch(200, { ok: true });
    await logProjectWork("p1", "drevan", "entry", { pursued: true });
    await logProjectWork("p1", "drevan", "entry");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ companion_id: "drevan", entry: "entry", source: "worker", pursued: true });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ companion_id: "drevan", entry: "entry", source: "worker" });
  });
});
