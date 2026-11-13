import { describe, it, expect } from "@jest/globals";
import { pkRoomLabel, speakerFrame, cutImpersonation } from "../speaker-frame.js";
import { buildWritebackSpeaker, judgeWriteback } from "../memory.js";
import { renderJevState } from "../jev-gate.js";
import type { InferenceAdapter } from "../inference.js";

describe("pkRoomLabel", () => {
  it("Principal's fronts keep (via PK), unchanged", () => {
    expect(pkRoomLabel("MemberS", { isSpouseSystem: false })).toBe("MemberS (via PK)");
  });
  it("Spouse's members read (Spouse's system)", () => {
    expect(pkRoomLabel("PartnerMemberA", { isSpouseSystem: true })).toBe("PartnerMemberA (Spouse's system)");
  });
});

describe("speakerFrame names Spouse's system", () => {
  const f = speakerFrame("drevan", "PartnerMemberA (Spouse's system, through PluralKit)", null);
  it("explains the Spouse label", () => {
    expect(f).toContain(`"(Spouse's system)" marks a member of Spouse's system`);
    expect(f).toContain("Principal's husband");
    expect(f).toContain(`"(via PK)" marks a system member speaking`);
  });
});

describe("cutImpersonation accepts the Spouse label", () => {
  it("cuts a [PartnerMemberA (Spouse's system)]: line", () => {
    const r = cutImpersonation("drevan", "Hello there.\n[PartnerMemberA (Spouse's system)]: and then I said", ["PartnerMemberA"]);
    expect(r.cut).toBe(true);
    expect(r.text).toBe("Hello there.");
  });
  it("still cuts the via PK form", () => {
    expect(cutImpersonation("drevan", "Hi.\n**PartnerMemberA (via PK):** x", ["PartnerMemberA"]).cut).toBe(true);
  });
});

describe("writeback speaker for Spouse's system", () => {
  const spouse = buildWritebackSpeaker({ pkMemberName: "Kyle Barnes || 🍂", frontPronouns: "he/him", isOwner: false, isSpouse: true, ownerName: "Crash", authorUsername: "kyle" });
  it("is kind spouse with name and pronouns", () => {
    expect(spouse).toMatchObject({ kind: "spouse", isOwner: false, pronouns: "he/him" });
  });
  it("without isSpouse stays guest", () => {
    expect(buildWritebackSpeaker({ pkMemberName: "Dave", isOwner: false, ownerName: "Crash", authorUsername: "d" })).toMatchObject({ kind: "guest" });
  });
  it("judge prompt says member of Spouse's system, family, not a guest", async () => {
    const seen: string[] = [];
    const adapter: InferenceAdapter = { generate: async (system, messages) => { seen.push([system, ...messages.map((m) => m.content)].join(" | ")); return "ACTION: skip" + String.fromCharCode(10) + "CONTENT:"; } };
    await judgeWriteback("I had a really hard day and felt overwhelmed about everything today.", "I hear you, that sounds like a heavy weight to carry right now.", adapter, "drevan", spouse);
    const all = seen.join(" | ");
    expect(all).toContain("a member of Spouse's system (Spouse is Principal's husband, family, not a guest)");
  });
  it("renderJevState frames spouse distinctly", () => {
    const s = renderJevState("drevan", spouse, "hi", "hello");
    expect(s).toContain("Spouse's system");
    expect(s).not.toContain("neither the owner nor a sibling");
  });
});
