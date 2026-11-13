import { jest, describe, it, expect } from "@jest/globals";
import { PkRoster, pkSystemsFromEnv } from "../pk-roster.js";
import { resolveAttribution, PLURALKIT_APP_ID, lookupPkMessage, peekPkMessage, verifiedRosterMember } from "../pluralkit.js";

const OWNER = "owner-1";
const SPOUSE = "spouse-1";
const OWNER_SYS = "abcdef";
const SPOUSE_SYS = "szplj";

const SYSTEMS = [
  { systemId: OWNER_SYS, discordUserId: OWNER, isOwner: true },
  { systemId: SPOUSE_SYS, discordUserId: SPOUSE, isOwner: false },
];

function memberApi(bySystem: Record<string, Array<{ name?: string; display_name?: string }>>, tags: Record<string, string> = { [OWNER_SYS]: "| Nullsafe" }): typeof fetch {
  return jest.fn().mockImplementation(async (url: unknown) => {
    const bare = String(url).match(/systems\/([^/]+)$/)?.[1];
    if (bare) return tags[bare] ? { ok: true, json: async () => ({ tag: tags[bare] }) } : { ok: true, json: async () => ({ tag: null }) };
    const sys = String(url).match(/systems\/([^/]+)\/members/)?.[1] ?? "";
    const rows = bySystem[sys];
    if (!rows) return { ok: false, status: 403 };
    return { ok: true, json: async () => rows };
  }) as unknown as typeof fetch;
}

async function loadedRoster(): Promise<PkRoster> {
  const r = new PkRoster(SYSTEMS, memberApi({
    [OWNER_SYS]: [
      { name: "ashwood", display_name: "MemberB" },
      { name: "MemberK" },
      { name: "shared-name" },
    ],
    [SPOUSE_SYS]: [
      { name: "MemberJ", display_name: "MemberJ" },
      { name: "shared-name" },
    ],
  }));
  await r.ensureLoaded();
  return r;
}

describe("PkRoster.identify()", () => {
  it("resolves the display name PluralKit puts on the webhook", async () => {
    const r = await loadedRoster();
    expect(r.identify("MemberB")).toMatchObject({ memberName: "MemberB", isOwner: true, discordUserId: OWNER });
  });

  it("resolves the raw member name too (member with no display name)", async () => {
    const r = await loadedRoster();
    expect(r.identify("MemberK")).toMatchObject({ isOwner: true, discordUserId: OWNER });
  });

  it("still resolves the underlying name when a display name exists", async () => {
    const r = await loadedRoster();
    expect(r.identify("ashwood")).toMatchObject({ memberName: "MemberB", isOwner: true });
  });

  it("is case- and whitespace-insensitive", async () => {
    const r = await loadedRoster();
    expect(r.identify("  ASH  ")).toMatchObject({ isOwner: true });
  });

  it("absorbs an appended system tag", async () => {
    const r = await loadedRoster();
    expect(r.identify("Ash | Nullsafe")).toMatchObject({ memberName: "MemberB", isOwner: true });
  });

  it("a suffix that is not the member's system tag is a miss (no bare prefix match)", async () => {
    const r = await loadedRoster();
    expect(r.identify("Ash Hunter")).toBeNull();
    expect(r.identify("Ash | Other")).toBeNull();
  });

  it("a system with no tag matches exact names only", async () => {
    const r = new PkRoster(SYSTEMS, memberApi({ [OWNER_SYS]: [{ name: "MemberB" }] }, {}));
    await r.ensureLoaded();
    expect(r.identify("MemberB")).toMatchObject({ isOwner: true });
    expect(r.identify("Ash | Nullsafe")).toBeNull();
  });

  it("Spouse's member resolves to Spouse, never to owner", async () => {
    const r = await loadedRoster();
    expect(r.identify("MemberJ")).toMatchObject({ isOwner: false, discordUserId: SPOUSE });
  });

  it("a name registered in BOTH systems is refused rather than guessed", async () => {
    // Guessing here would hand one system's tier to the other's member.
    const r = await loadedRoster();
    expect(r.identify("shared-name")).toBeNull();
  });

  it("unknown name and empty input return null", async () => {
    const r = await loadedRoster();
    expect(r.identify("SomeGuest")).toBeNull();
    expect(r.identify("")).toBeNull();
    expect(r.identify(null)).toBeNull();
  });

  it("a private member list (403) leaves the roster empty rather than throwing", async () => {
    const r = new PkRoster(SYSTEMS, memberApi({}));
    await r.ensureLoaded();
    expect(r.loaded).toBe(false);
    expect(r.identify("MemberB")).toBeNull();
  });

  it("a failed refresh keeps the previously loaded roster instead of blanking it", async () => {
    const r = await loadedRoster();
    const before = r.size;
    const dead = new PkRoster(SYSTEMS, (() => { throw new Error("network down"); }) as unknown as typeof fetch);
    await dead.ensureLoaded(); // separate instance: proves failure is survivable
    expect(dead.loaded).toBe(false);
    expect(r.size).toBe(before);
  });

  it("uses the shared cache when present and does not hit the API", async () => {
    const seeded = await loadedRoster();
    const store = new Map<string, string>();
    const cache = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => { store.set(k, v); return "OK"; },
    };
    const writer = new PkRoster(SYSTEMS, memberApi({
      [OWNER_SYS]: [{ name: "ashwood", display_name: "MemberB" }],
    }), cache);
    await writer.ensureLoaded();
    expect(writer.loaded).toBe(true);

    const apiThatMustNotRun = jest.fn(async () => { throw new Error("API must not be called"); });
    const reader = new PkRoster(SYSTEMS, apiThatMustNotRun as unknown as typeof fetch, cache);
    await reader.ensureLoaded();
    expect(reader.identify("MemberB")).toMatchObject({ isOwner: true });
    expect(apiThatMustNotRun).not.toHaveBeenCalled();
    expect(seeded.loaded).toBe(true);
  });
});

describe("pkSystemsFromEnv()", () => {
  it("drops systems with no id, keeps the owner system", () => {
    expect(pkSystemsFromEnv({ ownerSystemId: OWNER_SYS, ownerDiscordId: OWNER })).toEqual([
      { systemId: OWNER_SYS, discordUserId: OWNER, isOwner: true },
    ]);
  });

  it("requires both id and discord id for Spouse", () => {
    expect(pkSystemsFromEnv({ ownerSystemId: OWNER_SYS, ownerDiscordId: OWNER, spouseSystemId: SPOUSE_SYS })).toHaveLength(1);
    expect(pkSystemsFromEnv({ ownerSystemId: OWNER_SYS, ownerDiscordId: OWNER, spouseSystemId: SPOUSE_SYS, spouseDiscordId: SPOUSE })).toHaveLength(2);
  });

  it("no PK system configured at all -> empty (roster disabled, API path unchanged)", () => {
    expect(pkSystemsFromEnv({ ownerDiscordId: OWNER })).toEqual([]);
  });
});

describe("resolveAttribution() with a roster", () => {
  const proxied = (username: string) =>
    ({ webhookId: "wh1", applicationId: PLURALKIT_APP_ID, author: { id: "wh1", bot: true, username }, id: "m1" }) as never;

  const deadApi = jest.fn(async () => { throw new Error("PK API down"); }) as unknown as typeof fetch;

  // 2026-11-10: the roster is a hint. A roster hit is granted only after /v2/messages confirms the
  // message's system; with the API down the tier comes from the dedup pairing alone (fail closed).
  it("owner's front with the PK API down and the dedup pairing naming the owner -> owner, roster name kept", async () => {
    const r = await loadedRoster();
    const got = await resolveAttribution(proxied("MemberB"), OWNER, OWNER, deadApi, SPOUSE, SPOUSE_SYS, r);
    expect(got).toMatchObject({
      isOwner: true, discordUserId: OWNER, frontMember: "MemberB", frontState: "known", source: "fallback",
    });
  });

  it("owner-named roster hit with the PK API down and NO pairing -> not owner (fail closed)", async () => {
    const r = await loadedRoster();
    const got = await resolveAttribution(proxied("MemberB"), OWNER, undefined, deadApi, SPOUSE, SPOUSE_SYS, r);
    expect(got).toMatchObject({ isOwner: false, discordUserId: "unknown", frontMember: null, source: "fallback" });
  });

  it("a roster hit is verified with exactly one message lookup", async () => {
    const r = await loadedRoster();
    const spy = jest.fn(async () => ({ ok: true, json: async () => ({ sender: OWNER, system: { id: OWNER_SYS } }) })) as unknown as typeof fetch;
    const got = await resolveAttribution(proxied("MemberB"), OWNER, undefined, spy, SPOUSE, SPOUSE_SYS, r);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(got).toMatchObject({ isOwner: true, discordUserId: OWNER, frontMember: "MemberB", source: "pluralkit" });
  });

  it("Spouse's front is never promoted to owner", async () => {
    const r = await loadedRoster();
    const api = jest.fn(async () => ({ ok: true, json: async () => ({ sender: SPOUSE, system: { id: SPOUSE_SYS } }) })) as unknown as typeof fetch;
    const got = await resolveAttribution(proxied("MemberJ"), OWNER, undefined, api, SPOUSE, SPOUSE_SYS, r);
    expect(got).toMatchObject({ isOwner: false, discordUserId: SPOUSE, frontMember: "MemberJ" });
    const down = await resolveAttribution(proxied("MemberJ"), OWNER, undefined, deadApi, SPOUSE, SPOUSE_SYS, r);
    expect(down.isOwner).toBe(false);
  });

  it("roster miss + dead API + captured sender id still identifies the owner", async () => {
    const r = await loadedRoster();
    const got = await resolveAttribution(proxied("BrandNewAlter"), OWNER, OWNER, deadApi, SPOUSE, SPOUSE_SYS, r);
    expect(got).toMatchObject({ isOwner: true, discordUserId: OWNER, source: "fallback" });
  });

  it("roster miss + dead API + nothing captured stays unknown, never owner", async () => {
    const r = await loadedRoster();
    const got = await resolveAttribution(proxied("Stranger"), OWNER, undefined, deadApi, SPOUSE, SPOUSE_SYS, r);
    expect(got).toMatchObject({ isOwner: false, discordUserId: "unknown", source: "fallback" });
  });

  it("no roster passed: behavior is exactly the previous API path", async () => {
    const api = jest.fn(async () => ({ ok: true, json: async () => ({ sender: OWNER, member: { name: "MemberB" } }) })) as unknown as typeof fetch;
    const got = await resolveAttribution(proxied("MemberB"), OWNER, undefined, api, SPOUSE, SPOUSE_SYS, null);
    expect(got).toMatchObject({ isOwner: true, frontMember: "MemberB", source: "pluralkit" });
  });

  it("retries the message API once when the first call loses the race with PK's own write", async () => {
    let calls = 0;
    const flaky = jest.fn(async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 404 };
      return { ok: true, json: async () => ({ sender: OWNER, member: { name: "MemberB" } }) };
    }) as unknown as typeof fetch;
    const got = await resolveAttribution(proxied("MemberB"), OWNER, undefined, flaky, SPOUSE, SPOUSE_SYS, null);
    expect(calls).toBe(2);
    expect(got).toMatchObject({ isOwner: true, frontMember: "MemberB", source: "pluralkit" });
  });
});

describe("resolveAttribution() owner-impersonation guard (2026-11-10)", () => {
  const hook = (username: string, applicationId: string | null | undefined, id = "m9") =>
    ({ webhookId: "wh1", applicationId, author: { id: "wh1", bot: true, username }, id }) as never;
  const apiSays = (sender: string) => jest.fn(async () => ({ ok: true, json: async () => ({ sender, member: { name: "MemberB" } }) })) as unknown as typeof fetch;
  const notFound = () => jest.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;

  it("non-PK webhook (other app id) named like an owner member -> not owner, no lookups", async () => {
    const r = await loadedRoster();
    const spy = apiSays(OWNER);
    const got = await resolveAttribution(hook("MemberB", "999000111"), OWNER, OWNER, spy, SPOUSE, SPOUSE_SYS, r);
    expect(got).toMatchObject({ isOwner: false, discordUserId: "unknown", frontMember: null, source: "fallback" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("same for a tag-suffixed owner member name from a non-PK webhook", async () => {
    const r = await loadedRoster();
    const got = await resolveAttribution(hook("Ash | Nullsafe", "999000111"), OWNER, undefined, apiSays(OWNER), SPOUSE, SPOUSE_SYS, r);
    expect(got.isOwner).toBe(false);
  });

  it("PK webhook (PK app id) with an owner member name but PK says another sender -> NOT owner", async () => {
    const r = await loadedRoster();
    const spy = apiSays("someone-else");
    const got = await resolveAttribution(hook("MemberB", PLURALKIT_APP_ID), OWNER, undefined, spy, SPOUSE, SPOUSE_SYS, r);
    expect(got).toMatchObject({ isOwner: false, discordUserId: "someone-else" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("null applicationId -> no roster shortcut; the API decides (owner)", async () => {
    const r = await loadedRoster();
    const spy = apiSays(OWNER);
    const got = await resolveAttribution(hook("MemberB", null), OWNER, undefined, spy, SPOUSE, SPOUSE_SYS, r);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(got).toMatchObject({ isOwner: true, source: "pluralkit" });
  });

  it("null applicationId, API says another sender -> not owner even with an owner member name", async () => {
    const r = await loadedRoster();
    const got = await resolveAttribution(hook("MemberB", undefined), OWNER, undefined, apiSays("guest-9"), SPOUSE, SPOUSE_SYS, r);
    expect(got).toMatchObject({ isOwner: false, discordUserId: "guest-9" });
  });

  it("null applicationId, API 404 (not a PK message) and no captured sender -> not owner", async () => {
    const r = await loadedRoster();
    const got = await resolveAttribution(hook("MemberB", null), OWNER, undefined, notFound(), SPOUSE, SPOUSE_SYS, r);
    expect(got).toMatchObject({ isOwner: false, discordUserId: "unknown", source: "fallback" });
  });

  it("triad/companion-style webhook (own app id, name not in roster) is unchanged: unknown guest", async () => {
    const r = await loadedRoster();
    const got = await resolveAttribution(hook("Drevan", "123123123"), OWNER, undefined, notFound(), SPOUSE, SPOUSE_SYS, r);
    expect(got).toMatchObject({ isOwner: false, discordUserId: "unknown", frontState: "unknown", source: "fallback" });
  });
});

describe("PkRoster -- pronouns (2026-10-07)", () => {
  // Drevan's judge notes called MemberA (they/them on PK) and Jude (he/him) "she": the roster
  // fetched the member list and dropped `pronouns` on the floor, so nothing downstream knew.
  async function pronounRoster(): Promise<PkRoster> {
    const r = new PkRoster(SYSTEMS, memberApi({
      [OWNER_SYS]: [
        { name: "MemberA", display_name: "MemberA M.", pronouns: "they/them" } as never,
        { name: "MemberL", display_name: "Jude Vega Merlin", pronouns: " he/him " } as never,
        { name: "Quiet", pronouns: "" } as never,
        { name: "Private" },
      ],
    }));
    await r.ensureLoaded();
    return r;
  }

  it("carries the member's PK pronouns, trimmed", async () => {
    const r = await pronounRoster();
    expect(r.identify("MemberA M.")?.pronouns).toBe("they/them");
    expect(r.identify("Jude Vega Merlin")?.pronouns).toBe("he/him");
  });

  it("treats blank or missing pronouns as unknown (null), never a default", async () => {
    const r = await pronounRoster();
    expect(r.identify("Quiet")?.pronouns).toBeNull();
    expect(r.identify("Private")?.pronouns).toBeNull();
  });

  it("resolveAttribution's verified roster path hands the pronouns on as frontPronouns", async () => {
    const r = await pronounRoster();
    // PK displays hids uppercase and dash-split; the comparison must not care.
    const api = jest.fn(async () => ({ ok: true, json: async () => ({ sender: "someone", system: { id: "ABC-DEF" }, member: { name: "MemberA" } }) })) as unknown as typeof fetch;
    const a = await resolveAttribution(
      { id: "m1", webhookId: "wh", applicationId: PLURALKIT_APP_ID, author: { id: "wh", bot: true, username: "MemberA M." } },
      OWNER, undefined, api, SPOUSE, SPOUSE_SYS, r,
    );
    expect(a).toMatchObject({ isOwner: true, frontMember: "MemberA M.", frontPronouns: "they/them", source: "pluralkit" });
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("round-trips pronouns through the cache", async () => {
    const store = new Map<string, string>();
    const cache = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => { store.set(k, v); return "OK"; },
    };
    const first = new PkRoster(SYSTEMS, memberApi({
      [OWNER_SYS]: [{ name: "MemberA", display_name: "MemberA M.", pronouns: "they/them" } as never],
    }), cache);
    await first.ensureLoaded();
    expect([...store.keys()]).toEqual(["ns:pk:roster:v4", "ns:pk:profiles:v1"]);
    const second = new PkRoster(SYSTEMS, jest.fn() as unknown as typeof fetch, cache);
    await second.ensureLoaded();
    expect(second.identify("MemberA M.")?.pronouns).toBe("they/them");
  });
});

describe("roster is a hint: PK must confirm the system (2026-11-10, item a)", () => {
  const pkHook = (username: string, id: string) =>
    ({ webhookId: "wh1", applicationId: PLURALKIT_APP_ID, author: { id: "wh1", bot: true, username }, id }) as never;
  const pkSays = (body: unknown) => jest.fn(async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;

  it("a GUEST's real PK member whose name equals an owner member's -> NOT owner", async () => {
    const r = await loadedRoster();
    const api = pkSays({ sender: "guest-9", system: { id: "gstsy", uuid: "11111111-2222-3333-4444-555555555555" }, member: { name: "MemberB" } });
    const got = await resolveAttribution(pkHook("MemberB", "g1"), OWNER, undefined, api, SPOUSE, SPOUSE_SYS, r);
    expect(got.isOwner).toBe(false);
    expect(got.discordUserId).toBe("guest-9");
  });

  it("same guest, tag-suffixed name, and even with a dedup sender that is not the owner -> NOT owner", async () => {
    const r = await loadedRoster();
    const api = pkSays({ sender: "guest-9", system: { id: "gstsy" } });
    const got = await resolveAttribution(pkHook("Ash | Nullsafe", "g2"), OWNER, "guest-9", api, SPOUSE, SPOUSE_SYS, r);
    expect(got.isOwner).toBe(false);
  });

  it("a guest named like one of Spouse's members is not Spouse either", async () => {
    const r = await loadedRoster();
    const got = await resolveAttribution(pkHook("MemberJ", "g3"), OWNER, undefined, pkSays({ sender: "guest-9", system: { id: "gstsy" } }), SPOUSE, SPOUSE_SYS, r);
    expect(got).toMatchObject({ isOwner: false, discordUserId: "guest-9" });
  });

  it("the owner system's member -> owner (by system id, by uuid, or by sender)", async () => {
    const r = await loadedRoster();
    const bySys = await resolveAttribution(pkHook("MemberB", "o1"), OWNER, undefined, pkSays({ sender: "alt-acct", system: { id: OWNER_SYS } }), SPOUSE, SPOUSE_SYS, r);
    expect(bySys).toMatchObject({ isOwner: true, discordUserId: OWNER, frontMember: "MemberB", source: "pluralkit" });
    const bySender = await resolveAttribution(pkHook("MemberK", "o2"), OWNER, undefined, pkSays({ sender: OWNER }), SPOUSE, SPOUSE_SYS, r);
    expect(bySender).toMatchObject({ isOwner: true, frontMember: "MemberK", source: "pluralkit" });
  });

  it("API down (timeouts/5xx) -> fail closed: owner ONLY when the dedup pairing names the owner", async () => {
    const r = await loadedRoster();
    const down = jest.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    const noPair = await resolveAttribution(pkHook("MemberB", "d1"), OWNER, undefined, down, SPOUSE, SPOUSE_SYS, r);
    expect(noPair).toMatchObject({ isOwner: false, discordUserId: "unknown", source: "fallback" });
    const guestPair = await resolveAttribution(pkHook("MemberB", "d2"), OWNER, "guest-9", down, SPOUSE, SPOUSE_SYS, r);
    expect(guestPair).toMatchObject({ isOwner: false, discordUserId: "guest-9", frontMember: null });
    const ownerPair = await resolveAttribution(pkHook("MemberB", "d3"), OWNER, OWNER, down, SPOUSE, SPOUSE_SYS, r);
    expect(ownerPair).toMatchObject({ isOwner: true, discordUserId: OWNER, frontMember: "MemberB", source: "fallback" });
  });

  it("one message is looked up once: concurrent and later callers share the answer", async () => {
    const api = pkSays({ sender: OWNER, system: { id: OWNER_SYS } });
    const [a, b] = await Promise.all([lookupPkMessage("c1", api), lookupPkMessage("c1", api)]);
    expect(a.status).toBe("found");
    expect(b.status).toBe("found");
    const r = await loadedRoster();
    await resolveAttribution(pkHook("MemberB", "c1"), OWNER, undefined, api, SPOUSE, SPOUSE_SYS, r);
    expect(peekPkMessage("c1", api)?.sender).toBe(OWNER);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("a 404 is not cached (PK's write race): a later caller asks again", async () => {
    let calls = 0;
    const api = jest.fn(async () => {
      calls++;
      return calls <= 2 ? { ok: false, status: 404 } : { ok: true, json: async () => ({ sender: OWNER, system: { id: OWNER_SYS } }) };
    }) as unknown as typeof fetch;
    expect((await lookupPkMessage("r1", api)).status).toBe("absent");
    expect((await lookupPkMessage("r1", api)).status).toBe("found");
  });

  it("verifiedRosterMember: a name alone is nothing; app id + verified system makes it a member", async () => {
    const r = await loadedRoster();
    const api = pkSays({ sender: "guest-9", system: { id: "gstsy" } });
    const msg = (id: string, applicationId: string | null) => ({ id, webhookId: "wh1", applicationId, author: { username: "MemberB" } });
    expect(verifiedRosterMember(msg("v1", PLURALKIT_APP_ID), r, api)).toBeNull(); // not verified yet
    await lookupPkMessage("v1", api);
    expect(verifiedRosterMember(msg("v1", PLURALKIT_APP_ID), r, api)).toBeNull(); // verified: a guest's
    const own = pkSays({ sender: OWNER, system: { id: OWNER_SYS } });
    await lookupPkMessage("v2", own);
    expect(verifiedRosterMember(msg("v2", PLURALKIT_APP_ID), r, own)).toMatchObject({ isOwner: true, memberName: "MemberB" });
    expect(verifiedRosterMember(msg("v2", null), r, own)).toMatchObject({ isOwner: true });
    expect(verifiedRosterMember(msg("v2", "999000111"), r, own)).toBeNull(); // another app: never
    expect(verifiedRosterMember({ ...msg("v2", PLURALKIT_APP_ID), webhookId: null }, r, own)).toBeNull();
  });
});
