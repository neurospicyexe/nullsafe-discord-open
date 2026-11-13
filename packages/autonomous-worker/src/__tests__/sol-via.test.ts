import { describe, it, expect, vi, afterEach } from "vitest";
import { tendCreatureAs, recordSolAppearance } from "../halseth-client.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mock(json: unknown = {}) {
  const bodies: any[] = [];
  globalThis.fetch = vi.fn(async (_u: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify(json));
  }) as any;
  return bodies;
}

describe("Sol via tags (B64)", () => {
  it("a worker tend is autonomous", async () => {
    const b = mock({});
    await tendCreatureAs("c1", "cypher", "feed", "n");
    expect(b[0]).toMatchObject({ actor: "cypher", action: "feed", via: "autonomous" });
  });
  it("Sol's appearance is appear", async () => {
    const b = mock({});
    await recordSolAppearance("c1", "he lands");
    expect(b[0]).toMatchObject({ actor: "sol", action: "appear", via: "appear" });
    expect("ref" in b[0]).toBe(false);
  });
  it("the appearance carries the Discord message id as ref when known (B64.1)", async () => {
    const b = mock({});
    await recordSolAppearance("c1", "he lands", "0000000000000000002");
    expect(b[0]).toMatchObject({ actor: "sol", action: "appear", via: "appear", ref: "0000000000000000002" });
  });
});
