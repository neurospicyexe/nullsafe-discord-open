// 2026-11-05 quiet-drop sweep: items 7 (Sol moment post) and 8 (worker-side forage consume).
import { describe, it, expect, vi, afterEach } from "vitest";
import { postSolMoment } from "../sol-presence.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("postSolMoment", () => {
  it("posts with ?wait=true and returns the Discord message id (B64.1)", async () => {
    const f = vi.fn(async (_u: string) => new Response(JSON.stringify({ id: "0000000000000000003", content: "hello" }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    expect(await postSolMoment("https://discord.com/api/webhooks/1/tok", "hello", 0)).toEqual({ id: "0000000000000000003" });
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0]![0])).toBe("https://discord.com/api/webhooks/1/tok?wait=true");
  });
  it("keeps an existing query (thread_id) and adds wait=true", async () => {
    const f = vi.fn(async (_u: string) => new Response(JSON.stringify({ id: "0000000000000000003" }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    await postSolMoment("https://discord.com/api/webhooks/1/tok?thread_id=77", "hello", 0);
    const u = new URL(String(f.mock.calls[0]![0]));
    expect(u.searchParams.get("thread_id")).toBe("77");
    expect(u.searchParams.get("wait")).toBe("true");
  });
  it("a 204 (no body) still counts as posted, with no id", async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", f);
    expect(await postSolMoment("https://w.test/x", "hello", 0)).toEqual({ id: null });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("a 200 with an unreadable body still counts as posted, with no id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200 })));
    expect(await postSolMoment("https://w.test/x", "hello", 0)).toEqual({ id: null });
  });
  it("retries once after a network error and lands", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = vi.fn()
      .mockRejectedValueOnce(new Error("net"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", f);
    expect(await postSolMoment("https://w.test/x", "hello", 0)).toEqual({ id: null });
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("logs status (never the text) and gives up after one retry on 500", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = vi.fn(async () => new Response("x", { status: 500 }));
    vi.stubGlobal("fetch", f);
    expect(await postSolMoment("https://w.test/x", "SECRET-MOMENT", 0)).toBeNull();
    expect(f).toHaveBeenCalledTimes(2);
    const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("status 500");
    expect(logged).toContain("dropped");
    expect(logged).not.toContain("SECRET-MOMENT");
  });
  it("does not retry a 404 (dead webhook)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = vi.fn(async () => new Response("x", { status: 404 }));
    vi.stubGlobal("fetch", f);
    expect(await postSolMoment("https://w.test/x", "t", 0)).toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("worker consumeForageFind", () => {
  it("retries a 503 then lands; 404 is final", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { consumeForageFind } = await import("../halseth-client.js");
    const f = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", f);
    expect(await consumeForageFind("f1", "cypher")).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
    const g = vi.fn(async () => new Response("gone", { status: 404 }));
    vi.stubGlobal("fetch", g);
    expect(await consumeForageFind("f1", "cypher")).toBe(false);
    expect(g).toHaveBeenCalledTimes(1);
  });
});
