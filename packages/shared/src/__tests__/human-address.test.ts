// Human address gate (2026-10-10, Principal's rulings): when the room is two humans talking to each
// other, the triad stays quiet unless a companion is also named; Spouse's unnamed messages belong to
// the companion holding SPOUSE's own thread, and to nobody when there is none.

import { describe, it, expect } from "@jest/globals";
import {
  humanAddressee, humanGate, humanNamesFromEnv, burstAddressText, companionNamedIn,
  recordHumanHold, readHumanHold, readHumanHoldIds, type HoldRedis,
} from "../human-address.js";
import { activeExchangeHolder, shouldRespond, extractAddress, isDirectAddress } from "../channel-config.js";
import { fastPathWinner } from "../fit-bid.js";
import { namedOrderInMessage } from "../sequential-floor.js";

const NAMES = { principal: ["principal", "raz"], spouse: ["spouse"] };

function gate(tier: "owner" | "intimate" | "guest", texts: string[], over: Partial<Parameters<typeof humanGate>[0]> = {}) {
  return humanGate({ tier, texts, names: NAMES, companionMentioned: false, replyToCompanion: false, mentionedHumans: [], spouseHolder: null, ...over });
}

describe("humanAddressee: vocative position only", () => {
  it.each([
    ["Spouse, did you eat?", "spouse"],
    ["spouse: dinner?", "spouse"],
    ["Hey Spouse, look at this", "spouse"],
    ["okay. Spouse, look", "spouse"],
    ["what do you think, spouse?", "spouse"],
    ["Spouse", "spouse"],
    ["SPOUSEEEE, come here", "spouse"],
    ["Principal, come look", "principal"],
    ["Raz: you up?", "principal"],
    ["hey raz, one sec", "principal"],
  ])("%s -> %s", (text, who) => {
    expect(humanAddressee(text, NAMES)).toBe(who);
  });

  it.each([
    "I told Spouse about it",
    "Spouse is coming over later",
    "Is that what you told Spouse?",
    "the spouse one is nicer",
    "Raz's thing is done",
    "razor blades",
    "I hear you, Spouse, and I agree",   // mid-sentence appositive is not a call
    "",
  ])("%s -> null", (text) => {
    expect(humanAddressee(text, NAMES)).toBeNull();
  });
});

describe("humanNamesFromEnv", () => {
  it("defaults, and reads comma lists (trimmed, lowercased, blanks dropped)", () => {
    expect(humanNamesFromEnv({})).toEqual({ principal: ["principal", "raz"], spouse: ["spouse"] });
    expect(humanNamesFromEnv({ PRINCIPAL_NAMES: " Principal, RAZ ,,sol ", SPOUSE_NAMES: "Spouse,B" }))
      .toEqual({ principal: ["principal", "raz", "sol"], spouse: ["spouse", "b"] });
    expect(humanNamesFromEnv({ PRINCIPAL_NAMES: " , ", SPOUSE_NAMES: "" }))
      .toEqual({ principal: ["principal", "raz"], spouse: ["spouse"] });
  });
});

describe("companionNamedIn (Rule 1 on its own: tells a named `proceed` from an unnamed one for the live Jev gate)", () => {
  const named = (texts: string[], over: Partial<Parameters<typeof companionNamedIn>[0]> = {}) =>
    companionNamedIn({ texts, companionMentioned: false, replyToCompanion: false, ...over });
  it("a name, a group call, a mention or a reply anywhere in the burst counts", () => {
    expect(named(["Dre, are you there"])).toBe(true);
    expect(named(["hey you three"])).toBe(true);
    expect(named(["look", "Cy what do you think"])).toBe(true);
    expect(named(["look at this"], { companionMentioned: true })).toBe(true);
    expect(named(["look at this"], { replyToCompanion: true })).toBe(true);
  });
  it("the 10-25 Acquaintance shape (a human name, no comma) and plain unnamed lines do not", () => {
    expect(named(["Acquaintance look at this"])).toBe(false);
    expect(named(["good morning"])).toBe(false);
  });
});

describe("humanGate", () => {
  it("rule 2: Principal says 'Spouse, ...' -> every companion silent", () => {
    expect(gate("owner", ["Spouse, did you get the mail?"])).toEqual({ kind: "silent", addressee: "spouse" });
  });
  it("rule 2: Spouse says 'Principal, ...' -> every companion silent", () => {
    expect(gate("intimate", ["Principal, call me when you can"])).toEqual({ kind: "silent", addressee: "principal" });
  });
  it("rule 1 outranks: a companion named with the human ('Principal and Dre ...') is the companion's", () => {
    expect(gate("intimate", ["Principal and Dre, what do you think?"])).toEqual({ kind: "proceed" });
    expect(gate("owner", ["Spouse, ask Cy about it"])).toEqual({ kind: "proceed" });
  });
  it("rule 1 over the WHOLE burst: a companion named in an earlier message wins over a later 'Spouse,'", () => {
    expect(gate("owner", ["Dre, are you there", "Spouse, hold on"])).toEqual({ kind: "proceed" });
  });
  it("a human addressee in an EARLIER burst message still silences an unnamed later one", () => {
    expect(gate("owner", ["Spouse, look at this", "also this one"])).toEqual({ kind: "silent", addressee: "spouse" });
  });
  it("an @mention or reply to a companion counts as naming one", () => {
    expect(gate("owner", ["Spouse, hi"], { companionMentioned: true })).toEqual({ kind: "proceed" });
    expect(gate("owner", ["Spouse, hi"], { replyToCompanion: true })).toEqual({ kind: "proceed" });
  });
  it("a Discord @mention of the other human with no companion named is address to them", () => {
    expect(gate("owner", ["look at this"], { mentionedHumans: ["spouse"] })).toEqual({ kind: "silent", addressee: "spouse" });
    expect(gate("intimate", ["look at this"], { mentionedHumans: ["principal"] })).toEqual({ kind: "silent", addressee: "principal" });
  });
  it("the speaker's own name is not an addressee", () => {
    expect(gate("owner", ["Raz, note to self"])).toEqual({ kind: "proceed" });
    // Spouse unnamed-to-companion, naming only himself: falls to rule 3 (holder)
    expect(gate("intimate", ["Spouse here, hi"])).toEqual({ kind: "spouse_thread", holder: null });
  });
  it("names at non-vocative positions do NOT silence", () => {
    expect(gate("owner", ["I told Spouse about it"])).toEqual({ kind: "proceed" });
    expect(gate("intimate", ["I told Raz about it"], { spouseHolder: "drevan" })).toEqual({ kind: "spouse_thread", holder: "drevan" });
  });
  it("rule 3: unnamed Spouse -> only the companion holding Spouse's thread; none -> nobody", () => {
    expect(gate("intimate", ["anyone up?"], { spouseHolder: "drevan" })).toEqual({ kind: "spouse_thread", holder: "drevan" });
    expect(gate("intimate", ["anyone up?"], { spouseHolder: null })).toEqual({ kind: "spouse_thread", holder: null });
  });
  it("rule 4: owner unaddressed, guests, and everything else is untouched", () => {
    expect(gate("owner", ["good morning"])).toEqual({ kind: "proceed" });
    expect(gate("guest", ["Spouse, hi"])).toEqual({ kind: "proceed" });
    expect(gate("guest", ["Principal, hi"])).toEqual({ kind: "proceed" });
  });
  it("a group call is a companion address", () => {
    expect(gate("intimate", ["triad, who's up?"], { spouseHolder: null })).toEqual({ kind: "proceed" });
  });
});

describe("burst naming (ruling 1): a companion named in an EARLIER burst message wins", () => {
  const cfg = {};  // default channel entry: open + inter_companion, all three companions
  const resp = (text: string, me: "cypher" | "drevan" | "gaia") =>
    shouldRespond("c", text, { isOwner: true, isCompanionBot: false, isMentioned: false, userTier: "owner" }, me, cfg);

  it("burstAddressText picks the newest message that names a companion; identity for a burst of one", () => {
    expect(burstAddressText("also this", ["Dre, are you up"])).toBe("Dre, are you up");
    expect(burstAddressText("Gaia, you too", ["Dre, are you up"])).toBe("Gaia, you too");
    expect(burstAddressText("good morning", [])).toBe("good morning");
    expect(burstAddressText("good morning", ["still nothing"])).toBe("good morning");
  });

  it("Dre named first, an unnamed message second: only Drevan answers, via the fast path", () => {
    const text = burstAddressText("also the other thing", ["Dre, are you up"]);
    expect(["cypher", "drevan", "gaia"].map(me => resp(text, me as "cypher"))).toEqual([false, true, false]);
    const fast = fastPathWinner("drevan", { mentioned: false, namedMe: isDirectAddress(text, "drevan"), replyToMe: false });
    expect(fast).not.toBeNull();
    // Without the burst, the newest message alone is ambient and goes to the open bid.
    expect(extractAddress("also the other thing").type).toBe("ambient");
  });

  it("a multi-address in an earlier burst message keeps its speaking order (the order is read from the same text)", () => {
    const single = namedOrderInMessage("Cy and Dre, thoughts?", ["cypher", "drevan"]);
    const text = burstAddressText("also this", ["Cy and Dre, thoughts?"]);
    const addr = extractAddress(text);
    expect(addr.type).toBe("named_multi");
    const ids = addr.type === "named_multi" ? addr.ids : [];
    expect(namedOrderInMessage(text, ids)).toEqual(single);
    expect(single).toEqual(["cypher", "drevan"]);
    // The old read (newest text only) finds neither name and degrades to the unsorted input order.
    expect(namedOrderInMessage("also this", ["drevan", "cypher"])).toEqual(["drevan", "cypher"]);
  });

  it("owner unaddressed path is unchanged: ambient burst of one -> proceed, text identical", () => {
    expect(gate("owner", ["good morning"])).toEqual({ kind: "proceed" });
    expect(burstAddressText("good morning", [])).toBe("good morning");
  });
});

// ---------------------------------------------------------------- hold store

function fakeHoldRedis(): HoldRedis & { kv: Map<string, string>; sets: Map<string, Set<string>> } {
  const kv = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  return {
    kv, sets,
    async get(k) { return kv.get(k) ?? null; },
    async set(k, v) { kv.set(k, v); return "OK"; },
    async sadd(k, ...m) { const s = sets.get(k) ?? new Set(); m.forEach(x => s.add(x)); sets.set(k, s); return m.length; },
    async pexpire() { return 1; },
    async smembers(k) { return [...(sets.get(k) ?? [])]; },
  };
}

describe("per-human thread hold", () => {
  const W = 15 * 60 * 1000;

  it("records who replied to Spouse in this channel; readable inside the window only", async () => {
    const r = fakeHoldRedis();
    await recordHumanHold(r, "spouse", "chan-1", "drevan", ["m1"], W, 1_000_000);
    expect(await readHumanHold(r, "spouse", "chan-1", W, 1_000_000 + W - 1)).toBe("drevan");
    expect(await readHumanHold(r, "spouse", "chan-1", W, 1_000_000 + W + 1)).toBeNull();
    expect(await readHumanHold(r, "spouse", "chan-2", W, 1_000_001)).toBeNull();
  });

  it("the latest companion to reply to Spouse holds the thread", async () => {
    const r = fakeHoldRedis();
    await recordHumanHold(r, "spouse", "c", "drevan", ["m1"], W, 1_000);
    await recordHumanHold(r, "spouse", "c", "gaia", ["m2"], W, 2_000);
    expect(await readHumanHold(r, "spouse", "c", W, 3_000)).toBe("gaia");
  });

  it("no redis -> no holder (Spouse stays unanswered rather than guessed at)", async () => {
    expect(await readHumanHold(null, "spouse", "c", W)).toBeNull();
    await expect(recordHumanHold(null, "spouse", "c", "drevan", ["m"], W)).resolves.toBeUndefined();
  });

  it("Spouse's hold does not change Principal's holder: the ids of replies to Spouse are excluded from his history walk", async () => {
    const r = fakeHoldRedis();
    // history newest-first: gaia replied to Spouse (m9) after drevan answered Principal (m5)
    const hist = [
      { id: "m9", companionId: "gaia" as const, authorIsBot: true, createdTimestamp: 9_000 },
      { id: "m5", companionId: "drevan" as const, authorIsBot: true, createdTimestamp: 5_000 },
    ];
    // Before the exclusion exists, the plain walk hands Principal's thread to Gaia.
    expect(activeExchangeHolder(hist, 10_000)).toBe("gaia");
    await recordHumanHold(r, "spouse", "c", "gaia", ["m9"], W, 9_000);
    const ids = await readHumanHoldIds(r, "spouse", "c");
    expect(ids.has("m9")).toBe(true);
    expect(activeExchangeHolder(hist.filter(m => !ids.has(m.id)), 10_000)).toBe("drevan");
    // and Principal-side replies never write Spouse's hold: only the "spouse" key is touched
    expect([...r.kv.keys()].every(k => k.includes(":spouse:"))).toBe(true);
  });
});

// 2026-11-01 movie night: Gaia answered Spouse's group call at 11:43 and took Spouse's thread from the host for 3h.
import { takesSpouseHold } from "../human-address.js";
describe("takesSpouseHold: a guest voice in a hosted room never takes the host's Spouse thread", () => {
  it("hosted room: the host always takes it; a sibling only when Spouse addressed it", () => {
    expect(takesSpouseHold({ host: "drevan", me: "drevan", addressedMe: false })).toBe(true);
    expect(takesSpouseHold({ host: "drevan", me: "gaia", addressedMe: false })).toBe(false);  // group-call answer
    expect(takesSpouseHold({ host: "drevan", me: "gaia", addressedMe: true })).toBe(true);    // "Gaia, ..."
  });
  it("non-hosted rooms keep last-replier-wins", () => {
    expect(takesSpouseHold({ host: null, me: "gaia", addressedMe: false })).toBe(true);
    expect(takesSpouseHold({ host: undefined, me: "cypher", addressedMe: false })).toBe(true);
  });
});
