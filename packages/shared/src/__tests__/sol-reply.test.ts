// B64.1 (2026-11-08): a reply to a Sol post is a tend. Spec: BBH
// docs/superpowers/specs/2026-11-08-sol-replies-and-no-repeat.md, Part B "Bots".
import { describe, it, expect, jest } from "@jest/globals";
import {
  solReplyRef, solReplyActor, SolPostTracker, createSolReplyReporter, markSolTendPost,
  SOL_REPLY_WINDOW_MS, cachedSolCreatureId, isCompanionCommand, type SolReplyMessage,
} from "../sol-reply.js";

const SOL_ID = "0000000000000000026";
const CH = "900";
const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);

function tracker(): SolPostTracker {
  const t = new SolPostTracker();
  t.noteSolPost(CH, "5001", T0);
  return t;
}

describe("solReplyRef (pure)", () => {
  it("a Discord reply to a known Sol post counts, even past the 30-minute window", () => {
    const r = solReplyRef({ channelId: CH, content: "hi", replyTo: { messageId: "5001" } }, tracker().state(), SOL_ID, T0 + 5 * 3_600_000);
    expect(r).toBe("5001");
  });
  it("a reply whose referenced message carries Sol's webhook id counts (post from before a restart)", () => {
    const r = solReplyRef({ channelId: CH, content: "", replyTo: { messageId: "4000", webhookId: SOL_ID } }, new SolPostTracker().state(), SOL_ID, T0);
    expect(r).toBe("4000");
  });
  it("a reply to someone else's message that does not name him does not count", () => {
    expect(solReplyRef({ channelId: CH, content: "ok", replyTo: { messageId: "6000", webhookId: null } }, tracker().state(), SOL_ID, T0 + 1000)).toBeNull();
  });
  it("naming him in the same channel within 30 minutes counts, against his latest post", () => {
    const t = tracker();
    t.noteSolPost(CH, "5002", T0 + 60_000);
    expect(solReplyRef({ channelId: CH, content: "hey Sol, come here" }, t.state(), SOL_ID, T0 + 10 * 60_000)).toBe("5002");
    expect(solReplyRef({ channelId: CH, content: "SOL!" }, t.state(), SOL_ID, T0 + 60_000 + SOL_REPLY_WINDOW_MS)).toBe("5002");
  });
  it("naming him after the window does not count", () => {
    expect(solReplyRef({ channelId: CH, content: "sol" }, tracker().state(), SOL_ID, T0 + SOL_REPLY_WINDOW_MS + 1)).toBeNull();
  });
  it("a word that only contains 'sol' does not count", () => {
    for (const w of ["solace", "console", "solstice", "Solomon", "parasol"]) {
      expect(solReplyRef({ channelId: CH, content: w }, tracker().state(), SOL_ID, T0 + 1000)).toBeNull();
    }
  });
  it("talk ABOUT Sol in another channel does not count", () => {
    expect(solReplyRef({ channelId: "901", content: "Sol was funny earlier" }, tracker().state(), SOL_ID, T0 + 1000)).toBeNull();
  });
  it("a message from before his post does not count", () => {
    expect(solReplyRef({ channelId: CH, content: "sol" }, tracker().state(), SOL_ID, T0 - 1000)).toBeNull();
  });
  it("no Sol post seen in the channel: nothing", () => {
    expect(solReplyRef({ channelId: CH, content: "sol" }, new SolPostTracker().state(), SOL_ID, T0)).toBeNull();
  });
  it("a reply to a non-Sol message that names him inside the window still counts by the name rule", () => {
    expect(solReplyRef({ channelId: CH, content: "Sol, look", replyTo: { messageId: "6000", webhookId: null } }, tracker().state(), SOL_ID, T0 + 1000)).toBe("5001");
  });
});

describe("solReplyActor (pure)", () => {
  const ids = { ownerId: "111", selfId: "222", companionId: "drevan", solId: SOL_ID };
  it("Principal's own account is principal (a PluralKit original arrives from it before the proxy)", () => {
    expect(solReplyActor({ authorId: "111", webhookId: null }, ids)).toBe("principal");
  });
  it("a webhook post is never Principal by author id (the PK proxy copy is skipped; its original counted)", () => {
    expect(solReplyActor({ authorId: "111", webhookId: "777" }, ids)).toBeNull();
  });
  it("this bot's own post is this companion", () => {
    expect(solReplyActor({ authorId: "222", webhookId: null }, ids)).toBe("drevan");
  });
  it("a sibling's post is not mine to report", () => {
    expect(solReplyActor({ authorId: "333", webhookId: null }, ids)).toBeNull();
  });
  it("Sol and strangers are nobody", () => {
    expect(solReplyActor({ authorId: SOL_ID, webhookId: SOL_ID }, ids)).toBeNull();
    expect(solReplyActor({ authorId: "444", webhookId: null }, ids)).toBeNull();
  });
  it("no owner id configured: never principal", () => {
    expect(solReplyActor({ authorId: "111", webhookId: null }, { ...ids, ownerId: undefined })).toBeNull();
  });
  it("a companion id outside the triad reports nothing", () => {
    expect(solReplyActor({ authorId: "222", webhookId: null }, { ...ids, companionId: "sol" })).toBeNull();
  });
});

describe("SolPostTracker", () => {
  it("keeps the latest post per channel and a bounded set of known ids", () => {
    const t = new SolPostTracker(3);
    t.noteSolPost("a", "1", 1); t.noteSolPost("a", "2", 2); t.noteSolPost("b", "3", 3); t.noteSolPost("b", "4", 4);
    const s = t.state();
    expect(s.latestByChannel.get("a")).toEqual({ id: "2", at: 2 });
    expect(s.latestByChannel.get("b")).toEqual({ id: "4", at: 4 });
    expect(s.knownPosts.has("1")).toBe(false);
    expect([...s.knownPosts]).toEqual(["2", "3", "4"]);
  });
  it("an older post arriving late never replaces the latest", () => {
    const t = new SolPostTracker();
    t.noteSolPost("a", "2", 20); t.noteSolPost("a", "1", 10);
    expect(t.state().latestByChannel.get("a")).toEqual({ id: "2", at: 20 });
  });
});

function msg(over: Partial<SolReplyMessage> = {}): SolReplyMessage {
  return { id: "7001", channelId: CH, authorId: "111", webhookId: null, content: "good bird, Sol", createdAt: T0 + 60_000, ...over };
}

function harness(over: Partial<Parameters<typeof createSolReplyReporter>[0]> = {}) {
  const calls: Array<{ creatureId: string; actor: string; ref: string; text: string }> = [];
  const logs: string[] = [];
  const resolveCreatureId = jest.fn(async () => "sol-creature");
  const t = tracker();
  const reporter = createSolReplyReporter({
    companionId: "cypher",
    ownerDiscordId: "111",
    selfUserId: () => "222",
    solId: SOL_ID,
    tracker: t,
    resolveCreatureId,
    post: async (creatureId, actor, ref, text) => { calls.push({ creatureId, actor, ref, text }); return { recorded: true }; },
    ownDelayMs: 0,
    log: (l) => logs.push(l),
    ...over,
  });
  return { reporter, calls, logs, resolveCreatureId, t };
}

describe("createSolReplyReporter (wiring)", () => {
  it("Principal naming Sol inside the window posts one reply-tend as principal with Sol's post as ref", async () => {
    const h = harness();
    await h.reporter.onMessage(msg());
    expect(h.calls).toEqual([{ creatureId: "sol-creature", actor: "principal", ref: "5001", text: "good bird, Sol" }]);
  });
  it("this bot's own qualifying post reports with its own actor id", async () => {
    const h = harness();
    await h.reporter.onMessage(msg({ authorId: "222", content: "Sol, here." }));
    expect(h.calls.map((c) => c.actor)).toEqual(["cypher"]);
  });
  it("a sibling's post is left to the sibling", async () => {
    const h = harness();
    await h.reporter.onMessage(msg({ authorId: "333" }));
    expect(h.calls).toEqual([]);
  });
  it("an own post the heartbeat's tend_creature sent is skipped (it already recorded its tend)", async () => {
    const h = harness();
    markSolTendPost("7777");
    await h.reporter.onMessage(msg({ id: "7777", authorId: "222", content: "Sol, some seed for you" }));
    expect(h.calls).toEqual([]);
  });
  it("a non-qualifying message never resolves the creature or posts", async () => {
    const h = harness();
    await h.reporter.onMessage(msg({ content: "nice weather" }));
    expect(h.resolveCreatureId).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
  });
  it("an unknown reply target is looked up once (the post may predate this process)", async () => {
    const fetchReferenceWebhookId = jest.fn(async () => SOL_ID as string | null);
    const h = harness({ fetchReferenceWebhookId });
    await h.reporter.onMessage(msg({ content: "ok", referenceMessageId: "4000" }));
    expect(fetchReferenceWebhookId).toHaveBeenCalledTimes(1);
    expect(h.calls.map((c) => c.ref)).toEqual(["4000"]);
  });
  it("a reply to a known Sol post needs no lookup", async () => {
    const fetchReferenceWebhookId = jest.fn(async () => null as string | null);
    const h = harness({ fetchReferenceWebhookId });
    await h.reporter.onMessage(msg({ content: "ok", referenceMessageId: "5001" }));
    expect(fetchReferenceWebhookId).not.toHaveBeenCalled();
    expect(h.calls.map((c) => c.ref)).toEqual(["5001"]);
  });
  it("a failed or 404 /reply (older Halseth) never throws", async () => {
    const h = harness({ post: async () => { throw new Error("reply 404"); } });
    await expect(h.reporter.onMessage(msg())).resolves.toBeUndefined();
  });
  it("no Sol creature: no post", async () => {
    const h = harness({ resolveCreatureId: async () => null });
    await h.reporter.onMessage(msg());
    expect(h.calls).toEqual([]);
  });
  it("logs carry ids and the outcome, never the message text", async () => {
    const h = harness({ post: async () => ({ recorded: false, reason: "already" }) });
    await h.reporter.onMessage(msg({ content: "SECRET-WORDS sol" }));
    const all = h.logs.join("\n");
    expect(all).toContain("actor=principal");
    expect(all).toContain("ref=5001");
    expect(all).toContain("reason=already");
    expect(all).not.toContain("SECRET-WORDS");
  });
  it("without Sol's webhook id the reporter does nothing", async () => {
    const h = harness({ solId: null });
    await h.reporter.onMessage(msg());
    expect(h.calls).toEqual([]);
  });
});

describe("cachedSolCreatureId", () => {
  it("finds Sol by name once and caches it; a miss is not cached", async () => {
    let rows: Array<{ id: string; name: string }> = [];
    const list = jest.fn(async () => rows);
    const get = cachedSolCreatureId(list, 1000, () => 0);
    expect(await get()).toBeNull();
    rows = [{ id: "x", name: "Pip" }, { id: "s1", name: "Sol" }];
    expect(await get()).toBe("s1");
    expect(await get()).toBe("s1");
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe("commands are not replies (one act of care, one tend)", () => {
  it("isCompanionCommand reads every companion's command prefix", () => {
    expect(isCompanionCommand("dre: pet Sol feed")).toBe(true);
    expect(isCompanionCommand("cy pet sol talk hi")).toBe(true);
    expect(isCompanionCommand("gaia: imps")).toBe(true);
    expect(isCompanionCommand("Sol, come here")).toBe(false);
    expect(isCompanionCommand("dre, look at Sol")).toBe(false);
  });
  it("Principal's pet command naming Sol is not reported (the command records its own tend)", async () => {
    const h = harness();
    await h.reporter.onMessage(msg({ content: "cy: pet Sol feed" }));
    expect(h.calls).toEqual([]);
  });
  it("this bot's acknowledgement of a command in that channel is not reported either", async () => {
    const h = harness();
    await h.reporter.onMessage(msg({ id: "8001", content: "cy: pet Sol feed", createdAt: T0 + 60_000 }));
    await h.reporter.onMessage(msg({ id: "8002", authorId: "222", content: "fed Sol. *Sol takes it.*", createdAt: T0 + 65_000 }));
    expect(h.calls).toEqual([]);
  });
  it("an own post well after the command counts again", async () => {
    const h = harness();
    await h.reporter.onMessage(msg({ id: "8001", content: "cy: pet Sol feed", createdAt: T0 + 60_000 }));
    await h.reporter.onMessage(msg({ id: "8003", authorId: "222", content: "Sol, you again.", createdAt: T0 + 60_000 + 3 * 60_000 }));
    expect(h.calls.map((c) => c.actor)).toEqual(["cypher"]);
  });
});
