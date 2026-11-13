// Spouse update channel (spouse-note.ts). Fake ids and text only.
import { describe, it, expect, jest } from "@jest/globals";
import {
  spouseNoteMode, noteVoiceFor, chicagoParts, containsHealthTerm, buildNoteInputs, composeSpouseNote,
  runSpouseNoteDay, runSpouseNoteHold, runSpouseNoteTick, newSpouseNoteState, holdHeadsUpLine,
  PREVIEW_NOTE_PREFIX, spouseDiscordIdFrom, type SpouseNoteDeps, type RoomLine, type SpouseRedis,
} from "../spouse-note.js";

const NOW = Date.parse("2026-11-02T03:30:00Z"); // 21:30 CST on 2026-11-01
const TODAY = chicagoParts(NOW).date;

function fakeRedis(): SpouseRedis & { keys: Map<string, string> } {
  const keys = new Map<string, string>();
  return {
    keys,
    set: async (k, v) => (keys.has(k) ? null : (keys.set(k, v), "OK")),
    del: async (k) => { keys.delete(k); return 1; },
  };
}
const line = (content: string, over: Partial<RoomLine> = {}): RoomLine => ({
  channelId: "ch1", guildId: "g1", role: "user", authorName: "Raz", content, timestamp: NOW - 3_600_000, ...over,
});

function deps(over: Partial<SpouseNoteDeps> = {}) {
  const voice = noteVoiceFor(TODAY);
  const sentSpouse: string[] = [], sentOwner: string[] = [], logs: string[] = [];
  const d: SpouseNoteDeps = {
    companionId: voice, ownerName: "Raz", redis: fakeRedis(), now: () => NOW, hour: () => 21,
    roomLines: () => [line("we finished the shelf today")],
    ownNotes: async () => [],
    generate: async () => "Principal had a steady day and the evening felt soft.",
    systemPrompt: () => "SYS",
    sendToSpouse: async (t) => { sentSpouse.push(t); return true; },
    sendToOwner: async (t) => { sentOwner.push(t); return true; },
    holdSince: () => null, mode: () => "preview", log: (l) => logs.push(l),
    ...over,
  };
  return { d, sentSpouse, sentOwner, logs, voice };
}

describe("mode + rotation", () => {
  it("defaults to preview; off variants and on are exact", () => {
    expect(spouseNoteMode({})).toBe("preview");
    expect(spouseNoteMode({ SPOUSE_NOTE: "junk" })).toBe("preview");
    expect(spouseNoteMode({ SPOUSE_NOTE: " ON " })).toBe("on");
    expect(spouseNoteMode({ SPOUSE_NOTE: "off" })).toBe("off");
  });
  it("rotates drevan -> cypher -> gaia on consecutive days", () => {
    const seq = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"].map(noteVoiceFor);
    expect(new Set(seq.slice(0, 3)).size).toBe(3);
    expect(seq[3]).toBe(seq[0]);
    const order = ["drevan", "cypher", "gaia"];
    expect(order.indexOf(seq[1]!)).toBe((order.indexOf(seq[0]!) + 1) % 3);
  });
  it("resolves Spouse's id from the partner / spouse / escalation envs", () => {
    expect(spouseDiscordIdFrom({ SPOUSE_DISCORD_ID: "1" })).toBe("1");
    expect(spouseDiscordIdFrom({ ESCALATION_DISCORD_USER_ID: "2" })).toBe("2");
    expect(spouseDiscordIdFrom({})).toBeNull();
  });
});

describe("health filter", () => {
  it("flags health terms", () => {
    for (const t of ["took my meds", "20 mg", "out of spoons", "pain is bad", "bp was high", "heart rate 90", "glucose low", "a dose missed"]) {
      expect(containsHealthTerm(t)).toBe(true);
    }
    expect(containsHealthTerm("we built a shelf and watched a movie")).toBe(false);
  });
  it("drops health lines from inputs, keeps the rest", () => {
    const r = buildNoteInputs({ today: TODAY, ownerName: "Raz", roomLines: [line("took my meds late"), line("built a shelf")], notes: [
      { content: "pain flared at noon", created_at: new Date(NOW - 3_600_000).toISOString() },
      { content: "a calm afternoon", created_at: new Date(NOW - 3_600_000).toISOString() },
    ] });
    expect(r.lines).toEqual(["Raz: built a shelf"]);
    expect(r.notes).toEqual(["a calm afternoon"]);
  });
  it("never uses DM lines, other humans, or yesterday", () => {
    const r = buildNoteInputs({ today: TODAY, ownerName: "Raz", roomLines: [
      line("secret dm words", { guildId: null }),
      line("no guild prop", { guildId: undefined }),
      line("spouse says hi", { authorName: "Spouse" }),
      line("old news", { timestamp: NOW - 2 * 86_400_000 }),
      line("room line"),
    ], notes: [] });
    expect(r.lines).toEqual(["Raz: room line"]);
  });
  it("blocks an output that still contains a health term", async () => {
    const r = await composeSpouseNote({ companionId: "drevan", ownerName: "Raz", generate: async () => "Principal was low on spoons today.", systemPrompt: () => "S" }, { lines: [], notes: [], principalActive: true });
    expect(r).toEqual({ ok: false, reason: "health_term" });
  });
});

describe("daily note", () => {
  it("preview goes to the owner with the prefix, never to Spouse", async () => {
    const { d, sentSpouse, sentOwner } = deps();
    expect(await runSpouseNoteDay(d, newSpouseNoteState())).toBe("sent_preview");
    expect(sentSpouse).toEqual([]);
    expect(sentOwner).toHaveLength(1);
    expect(sentOwner[0]!.startsWith(PREVIEW_NOTE_PREFIX)).toBe(true);
  });
  it("on goes to Spouse and copies Principal", async () => {
    const { d, sentSpouse, sentOwner } = deps({ mode: () => "on" });
    expect(await runSpouseNoteDay(d, newSpouseNoteState())).toBe("sent_spouse");
    expect(sentSpouse).toHaveLength(1);
    expect(sentOwner[0]).toContain("Sent to Spouse");
  });
  it("off sends nothing and composes nothing", async () => {
    const generate = jest.fn(async () => "x");
    const { d, sentSpouse, sentOwner } = deps({ mode: () => "off", generate });
    const t = await runSpouseNoteTick(d, newSpouseNoteState());
    expect(t).toEqual({ hold: "off", day: "off" });
    expect(generate).not.toHaveBeenCalled();
    expect(sentSpouse.length + sentOwner.length).toBe(0);
  });
  it("only the rotation companion sends, and only once per date", async () => {
    const redis = fakeRedis();
    const { d, voice } = deps({ redis });
    const other = (["drevan", "cypher", "gaia"] as const).find(c => c !== voice)!;
    expect(await runSpouseNoteDay({ ...d, companionId: other }, newSpouseNoteState())).toBe("not_my_day");
    expect(await runSpouseNoteDay(d, newSpouseNoteState())).toBe("sent_preview");
    expect(await runSpouseNoteDay(d, newSpouseNoteState())).toBe("not_claimed");
  });
  it("skips a day with no activity from Principal, without claiming", async () => {
    const redis = fakeRedis();
    const { d } = deps({ redis, roomLines: () => [line("hi", { authorName: "Spouse" })] });
    expect(await runSpouseNoteDay(d, newSpouseNoteState())).toBe("no_activity");
    expect(redis.keys.size).toBe(0);
  });
  it("logs a no-activity skip once per date, not every minute", async () => {
    const lines: string[] = [];
    const { d } = deps({ redis: fakeRedis(), roomLines: () => [] });
    const st = newSpouseNoteState();
    const dl = { ...d, log: (l: string) => lines.push(l) };
    await runSpouseNoteDay(dl, st);
    await runSpouseNoteDay(dl, st);
    expect(lines.filter(l => l.includes("outcome=no_activity"))).toHaveLength(1);
  });
  it("waits for the hour and refuses without redis", async () => {
    expect(await runSpouseNoteDay(deps({ hour: () => 12 }).d, newSpouseNoteState())).toBe("before_hour");
    expect(await runSpouseNoteDay(deps({ redis: null }).d, newSpouseNoteState())).toBe("no_redis");
  });
  it("a rejected output sends nothing and logs the rejection without text", async () => {
    const { d, sentSpouse, sentOwner, logs } = deps({ generate: async () => "They took their meds and rested." });
    expect(await runSpouseNoteDay(d, newSpouseNoteState())).toBe("rejected");
    expect(sentSpouse.length + sentOwner.length).toBe(0);
    expect(logs.join("\n")).toContain("outcome=rejected");
    expect(logs.join("\n")).not.toContain("meds");
  });
  it("a failed send releases the claim for a retry", async () => {
    const redis = fakeRedis();
    const { d } = deps({ redis, sendToOwner: async () => false });
    expect(await runSpouseNoteDay(d, newSpouseNoteState())).toBe("send_failed");
    expect(redis.keys.size).toBe(0);
  });
});

describe("bad-night heads-up", () => {
  const since = new Date(NOW - 20 * 60_000).toISOString();
  it("fixed line, once per hold, across all three bots", async () => {
    const redis = fakeRedis();
    const a = deps({ redis, holdSince: () => since, companionId: "cypher" });
    const b = deps({ redis, holdSince: () => since, companionId: "gaia" });
    expect(await runSpouseNoteHold(a.d, newSpouseNoteState())).toBe("sent_preview");
    expect(await runSpouseNoteHold(b.d, newSpouseNoteState())).toBe("not_claimed");
    expect(await runSpouseNoteHold(a.d, newSpouseNoteState())).toBe("not_claimed");
    expect(a.sentOwner[0]).toContain(holdHeadsUpLine("cypher"));
    expect(holdHeadsUpLine("cypher")).toBe("Principal's having a rough night; we're with them. (from Cypher)");
    expect(a.sentSpouse).toEqual([]);
  });
  it("a new hold sends again; on goes to Spouse; stale holds do not", async () => {
    const redis = fakeRedis();
    const first = deps({ redis, holdSince: () => since, mode: () => "on" });
    expect(await runSpouseNoteHold(first.d, newSpouseNoteState())).toBe("sent_spouse");
    expect(first.sentSpouse).toEqual([holdHeadsUpLine(first.d.companionId)]);
    const later = new Date(NOW - 5 * 60_000).toISOString();
    expect(await runSpouseNoteHold(deps({ redis, holdSince: () => later }).d, newSpouseNoteState())).toBe("sent_preview");
    const old = new Date(NOW - 9 * 3_600_000).toISOString();
    expect(await runSpouseNoteHold(deps({ redis, holdSince: () => old }).d, newSpouseNoteState())).toBe("stale_hold");
    expect(await runSpouseNoteHold(deps({ holdSince: () => null }).d, newSpouseNoteState())).toBe("no_hold");
  });
});

describe("spouse-note failures leave a trace (drop scan 11-05)", () => {
  it("a failed send logs the error instead of swallowing it", async () => {
    const lines: string[] = [];
    const { d } = deps({ redis: fakeRedis() });
    const out = await runSpouseNoteDay({ ...d, log: (l: string) => lines.push(l), sendToOwner: async () => { throw Object.assign(new Error("Cannot send messages to this user"), { code: 50007 }); } }, newSpouseNoteState());
    expect(out).toBe("send_failed");
    expect(lines.some(l => l.includes("send_error to=owner code=50007"))).toBe(true);
  });
  it("no redis is logged once per date", async () => {
    const lines: string[] = [];
    const { d } = deps({ redis: null });
    const st = newSpouseNoteState();
    await runSpouseNoteDay({ ...d, log: (l: string) => lines.push(l) }, st);
    await runSpouseNoteDay({ ...d, log: (l: string) => lines.push(l) }, st);
    expect(lines.filter(l => l.includes("outcome=no_redis"))).toHaveLength(1);
  });
});
