import { jest, describe, it, expect } from "@jest/globals";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
const here = dirname(fileURLToPath(import.meta.url));
import {
  hermesRouteTier, hermesPortFor, parseGuestUrl, readGuestUrlRaw, guestUrlEnvKey, buildGuestAdapter,
  createHermesRouter, hermesRouteLine, routedSessionId, routedChannelKey, guestBootLines,
  type RouteSpeaker,
} from "../hermes-route.js";
import { createAdapter, type InferenceAdapter } from "../inference.js";
import { hermesDelta, CROSS_GATEWAY_LABEL, SELF_INITIATED_LABEL } from "../prompt-assembly.js";
import { applyPerBotOverrides } from "../env-file.js";

// H3 guest port (2026-11-10). Owner turns keep the full-tool gateway; every other human turn, and any
// identity that did not resolve, goes to the restricted guest gateway. Unset url = old behaviour.

const OWNER_URL = "http://127.0.0.1:8642/v1";
const GUEST_URL = "http://127.0.0.1:8652/v1";

const ok = (content: string) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) }) as any;

function speaker(p: Partial<RouteSpeaker>): RouteSpeaker {
  return { isOwner: false, isSibling: false, isSol: false, userTier: "guest", ...p };
}

describe("hermesRouteTier / hermesPortFor", () => {
  const cases: Array<[string, RouteSpeaker, string, string]> = [
    ["verified owner", speaker({ isOwner: true, userTier: "owner" }), "owner", "owner"],
    ["Spouse (intimate) is family: owner gateway (Principal 11-10)", speaker({ userTier: "intimate" }), "intimate", "owner"],
    ["guest", speaker({ userTier: "guest" }), "guest", "guest"],
    ["sibling companion bot", speaker({ isSibling: true }), "sibling", "owner"],
    ["Sol", speaker({ isSol: true }), "sol", "owner"],
    // Fail closed: the owner tier without the verified flag (or the reverse) is not the owner.
    ["owner tier, not verified", speaker({ isOwner: false, userTier: "owner" }), "guest", "guest"],
    ["verified flag, guest tier", speaker({ isOwner: true, userTier: "guest" }), "guest", "guest"],
    ["unverified PK proxy (resolves to guest tier)", speaker({ userTier: "guest" }), "guest", "guest"],
  ];
  for (const [name, s, tier, port] of cases) {
    it(`${name} -> tier=${tier} port=${port}`, () => {
      const t = hermesRouteTier(s);
      expect(t).toBe(tier);
      expect(hermesPortFor(t)).toBe(port);
    });
  }
});

describe("parseGuestUrl", () => {
  it("unset / blank", () => {
    expect(parseGuestUrl(undefined, OWNER_URL)).toEqual({ kind: "unset" });
    expect(parseGuestUrl("   ", OWNER_URL)).toEqual({ kind: "unset" });
  });
  it("ok, trailing slash stripped", () => {
    expect(parseGuestUrl(`${GUEST_URL}/`, OWNER_URL)).toEqual({ kind: "ok", url: GUEST_URL });
  });
  it("invalid: not a url, not http(s)", () => {
    expect(parseGuestUrl("8652", OWNER_URL).kind).toBe("invalid");
    expect(parseGuestUrl("ftp://127.0.0.1:8652/v1", OWNER_URL).kind).toBe("invalid");
  });
  it("invalid: the SAME url as the owner gateway (case and trailing slash ignored)", () => {
    const r = parseGuestUrl("HTTP://127.0.0.1:8642/v1/", OWNER_URL);
    expect(r).toEqual({ kind: "invalid", reason: "same as the owner gateway url" });
  });
});

describe("env: only the prefixed key", () => {
  it("reads <BOT>_HERMES_GUEST_API_URL and ignores a generic line", () => {
    expect(guestUrlEnvKey("drevan")).toBe("DREVAN_HERMES_GUEST_API_URL");
    expect(readGuestUrlRaw("drevan", { HERMES_GUEST_API_URL: GUEST_URL } as any)).toBeUndefined();
    expect(readGuestUrlRaw("drevan", { DREVAN_HERMES_GUEST_API_URL: ` =${GUEST_URL} ` } as any)).toBe(GUEST_URL);
  });
  it("the .env loader never folds one bot's guest url onto a generic key", () => {
    const env: NodeJS.ProcessEnv = { CYPHER_HERMES_GUEST_API_URL: GUEST_URL };
    const taken = applyPerBotOverrides(["CYPHER_HERMES_GUEST_API_URL"], env, "DREVAN", () => {});
    expect(taken).toEqual([]);
    expect(env["HERMES_GUEST_API_URL"]).toBeUndefined();
    const taken2 = applyPerBotOverrides(["CYPHER_HERMES_GUEST_API_URL"], env, "CYPHER", () => {});
    expect(taken2).toEqual([]);
    expect(env["HERMES_GUEST_API_URL"]).toBeUndefined();
  });
  it("boot warns about a generic line and an invalid url", () => {
    const lines = guestBootLines("gaia", { kind: "invalid", reason: "not a url" }, true, { HERMES_GUEST_API_URL: "x" } as any);
    expect(lines.filter(l => l.level === "warn")).toHaveLength(2);
    expect(lines.map(l => l.text).join("\n")).toMatch(/REFUSED, never sent to the owner gateway/);
  });
});

function ownerAdapter(fetchFn: any): InferenceAdapter {
  return createAdapter("deepseek", "", { hermes: "k" }, { hermes: OWNER_URL, forceHermes: true }, fetchFn, "cypher");
}

describe("router", () => {
  it("guest url unset: every tier on the owner adapter (old behaviour), guest tiers say guest=unset", () => {
    const owner = ownerAdapter(jest.fn());
    const router = createHermesRouter({ companionId: "cypher", owner: () => owner, guest: buildGuestAdapter("cypher", { kind: "unset" }, true, "k"), enabled: true });
    expect(router.guestConfigured).toBe(false);
    const g = router.route("guest");
    expect(g.port).toBe("owner");
    expect(g.adapter).toBe(owner);
    expect(g.guestUnset).toBe(true);
    expect(hermesRouteLine("cypher", g)).toBe("[hermes-route] cypher tier=guest port=owner guest=unset");
    expect(router.route("owner").guestUnset).toBe(false);
  });

  it("direct mode (not hermes): no guest adapter, nothing routed", () => {
    expect(buildGuestAdapter("cypher", { kind: "ok", url: GUEST_URL }, false, "k")).toBeNull();
    const owner = ownerAdapter(jest.fn());
    const router = createHermesRouter({ companionId: "cypher", owner: () => owner, guest: null, enabled: false });
    expect(router.route("guest")).toMatchObject({ port: "owner", guestUnset: false });
  });

  it("guest url set: non-owner turns call the GUEST url, owner/sibling/Sol call the owner url", async () => {
    const fetchFn = jest.fn(async (_url: string, _init: any) => ok("hi"));
    const owner = ownerAdapter(fetchFn);
    const guest = buildGuestAdapter("cypher", parseGuestUrl(GUEST_URL, OWNER_URL), true, "k", fetchFn as any);
    const router = createHermesRouter({ companionId: "cypher", owner: () => owner, guest, enabled: true });
    expect(router.guestConfigured).toBe(true);

    for (const tier of ["guest"] as const) {
      fetchFn.mockClear();
      const r = router.route(tier);
      expect(r.port).toBe("guest");
      expect(hermesRouteLine("cypher", r)).toBe(`[hermes-route] cypher tier=${tier} port=guest`);
      await r.adapter.generate("sys", [{ role: "user", content: "x" }]);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(String(fetchFn.mock.calls[0]![0])).toBe(`${GUEST_URL}/chat/completions`);
    }
    for (const tier of ["owner", "intimate", "sibling", "sol"] as const) {
      fetchFn.mockClear();
      const r = router.route(tier);
      expect(r.port).toBe("owner");
      await r.adapter.generate("sys", [{ role: "user", content: "x" }]);
      expect(String(fetchFn.mock.calls[0]![0])).toBe(`${OWNER_URL}/chat/completions`);
    }
  });

  it("FAIL CLOSED: guest gateway erroring returns null and never retries on the owner gateway", async () => {
    const fetchFn = jest.fn(async (url: string, _init: any) =>
      url.startsWith(GUEST_URL) ? ({ ok: false, status: 502, json: async () => ({}) } as any) : ok("owner"));
    const owner = ownerAdapter(fetchFn);
    const guest = buildGuestAdapter("cypher", parseGuestUrl(GUEST_URL, OWNER_URL), true, "k", fetchFn as any);
    const router = createHermesRouter({ companionId: "cypher", owner: () => owner, guest, enabled: true });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const out = await router.route("guest").adapter.generate("sys", [{ role: "user", content: "x" }]);
    warn.mockRestore();
    expect(out).toBeNull();
    expect(fetchFn.mock.calls.every(c => String(c[0]).startsWith(GUEST_URL))).toBe(true);
  });

  it("FAIL CLOSED: a set-but-invalid url (incl. the owner's own) refuses non-owner turns, no fetch at all", async () => {
    const fetchFn = jest.fn(async () => ok("owner"));
    const owner = ownerAdapter(fetchFn);
    for (const raw of ["not a url", OWNER_URL]) {
      const guest = buildGuestAdapter("cypher", parseGuestUrl(raw, OWNER_URL), true, "k", fetchFn as any);
      const router = createHermesRouter({ companionId: "cypher", owner: () => owner, guest, enabled: true });
      const r = router.route("guest");
      expect(r.port).toBe("guest");
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      expect(await r.adapter.generate("sys", [{ role: "user", content: "x" }])).toBeNull();
      warn.mockRestore();
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("owner adapter is read live (a model switch rebuild still takes effect)", () => {
    const a = ownerAdapter(jest.fn()); const b = ownerAdapter(jest.fn());
    const ref = { current: a };
    const router = createHermesRouter({ companionId: "cypher", owner: () => ref.current, guest: null, enabled: true });
    ref.current = b;
    expect(router.route("owner").adapter).toBe(b);
  });
});

describe("per-gateway transcript keys", () => {
  it("guest ids and channel keys are suffixed; owner ones are untouched", () => {
    expect(routedSessionId("cypher:123:w2900", "owner")).toBe("cypher:123:w2900");
    expect(routedSessionId("cypher:123:w2900", "guest")).toBe("cypher:123:w2900:guest");
    expect(routedChannelKey("123", "owner")).toBe("123");
    expect(routedChannelKey("123", "guest")).toBe("123#guest");
  });
});

describe("hermesDelta across two gateways", () => {
  // Principal, my reply on the OWNER gateway, Spouse, my reply on the GUEST gateway, then the live line.
  const hist = [
    { role: "user", content: "r1", authorName: "Principal", timestamp: 1000 },
    { role: "assistant", content: "owner-reply", timestamp: 1100 },
    { role: "user", content: "b1", authorName: "Spouse", timestamp: 1200 },
    { role: "assistant", content: "guest-reply", timestamp: 1300, hermesPort: "guest" as const },
    { role: "user", content: "r2", authorName: "Principal", timestamp: 1400 },
  ];
  const text = (r: { messages: Array<{ content: string }> }) => r.messages.map(m => m.content).join("\n");

  it("no port option: the old rule (own replies are never folded)", () => {
    const out = text(hermesDelta(hist, 1000, 2000));
    expect(out).not.toContain("guest-reply");
    expect(out).not.toContain("owner-reply");
  });

  it("owner gateway (mark after r1): gets Spouse's line AND the guest gateway's reply, not its own", () => {
    const r = hermesDelta(hist, 1000, 2000, false, null, { port: "owner" });
    const out = text(r);
    expect(out).toContain("[Spouse]: b1");
    expect(out).toContain(`${CROSS_GATEWAY_LABEL}: guest-reply`);
    expect(out).not.toContain("owner-reply");
    expect(r.deliveredThroughTs).toBe(1400);
  });

  it("guest gateway, first turn (mark 0): gets the room AND the owner gateway's reply, not its own", () => {
    const out = text(hermesDelta(hist, 0, 2000, false, null, { port: "guest" }));
    expect(out).toContain("[Principal]: r1");
    expect(out).toContain(`${CROSS_GATEWAY_LABEL}: owner-reply`);
    expect(out).toContain("[Spouse]: b1");
    expect(out).not.toContain("guest-reply");
  });

  it("a cross-gateway reply is never the 'last assistant' boundary (null mark)", () => {
    // Owner gateway with no mark: the boundary is ITS last reply (owner-reply), so b1 and the guest reply fold.
    const out = text(hermesDelta(hist, null, 2000, false, null, { port: "owner" }));
    expect(out).toContain("[Spouse]: b1");
    expect(out).toContain(`${CROSS_GATEWAY_LABEL}: guest-reply`);
    expect(out).not.toContain("[Principal]: r1");
  });

  it("a self-initiated line keeps its own label under a port", () => {
    const h = [
      { role: "assistant", content: "dm-preview", timestamp: 900, selfInitiated: true as const },
      { role: "user", content: "r2", authorName: "Principal", timestamp: 1400 },
    ];
    expect(text(hermesDelta(h, 0, 2000, false, null, { port: "owner" }))).toContain(`${SELF_INITIATED_LABEL}: dm-preview`);
  });
});

describe("source guard: every in-turn Hermes call is routed", () => {
  const src = readFileSync(resolve(here, "../bot-message-handler.ts"), "utf8");
  const core = readFileSync(resolve(here, "../bot-core.ts"), "utf8");

  it("the handler calls Hermes through turnAdapter(); the only direct owner call is the owner-only search read-in", () => {
    const direct = src.match(/adapterRef\.current\.generate\(/g) ?? [];
    expect(direct).toHaveLength(1);
    const idx = src.indexOf("adapterRef.current.generate(");
    // That one call sits inside the `if (attribution.isOwner && SEARCH_TRIGGER)` block.
    expect(src.lastIndexOf("if (attribution.isOwner && SEARCH_TRIGGER)", idx)).toBeGreaterThan(-1);
    expect(src.slice(src.lastIndexOf("if (attribution.isOwner && SEARCH_TRIGGER)", idx), idx)).not.toMatch(/\n    }\n/);
    expect((src.match(/turnAdapter\(\)\.generate\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
    // The judge / distill / writeback fallbacks used when no direct key exists are routed too.
    expect(src).not.toMatch(/\?\? adapterRef\.current/);
    expect(src).not.toMatch(/\?\? deps\.adapterRef\.current/);
    expect(src).toMatch(/runDistillation\(message\.channelId, stmStore, librarian, turnAdapter\(\)/);
  });

  it("the guest reply is tagged in STM and the delivered mark is port-scoped", () => {
    expect(src).toMatch(/hermesPort: "guest" as const/);
    expect(src).not.toMatch(/hermesDeliveredMark\.(get|set)\(message\.channelId/);
    expect(src).not.toMatch(/hermesLastSessionId\.(get|set)\(message\.channelId/);
    expect(src).not.toMatch(/crossRoomMark\.(get|set)\(message\.channelId/);
  });

  it("voice routes by the speaker's Discord id", () => {
    expect(core).toMatch(/hermesRouter\.route\(userId === env\.ownerDiscordId \? "owner" : "guest"\)/);
    expect(core).not.toMatch(/adapterRef\.current\.generate\(bootCtx\.systemPrompt, \[\{ role: "user", content: transcript \}\]/);
  });
});
