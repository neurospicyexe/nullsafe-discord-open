// Sol's self-initiated presence in the heartbeat channel.
// Frequency of Sol's self-initiated channel moments, by disposition (probability per daily tick).
export const APPEAR_CHANCE: Record<string, number> = {
  absent:       0,
  aloof:        0.15,
  watchful:     0.35,
  present:      0.55,
  affectionate: 0.75,
};

export function shouldSolAppear(disposition: string, roll: number): boolean {
  return roll < (APPEAR_CHANCE[disposition] ?? 0);
}

// The moment TEXT now comes from Halseth (POST /mind/creatures/:id/moment) --
// composed server-side from live drives x trust tier, sometimes a gift from the
// nest. The palette mirror that used to live here (with its "keep in sync"
// comment) is gone on purpose: one author, no drift.

/** A landed Sol post. `id` is the Discord message id (null when the webhook answered without one). */
export interface SolPosted { id: string | null }

/** The webhook URL with `wait=true` (Discord then answers 200 + the message, not 204). Never logged. */
function withWait(webhookUrl: string): string {
  try {
    const u = new URL(webhookUrl);
    u.searchParams.set("wait", "true");
    return u.toString();
  } catch {
    return webhookUrl;
  }
}

async function messageId(r: Response): Promise<string | null> {
  if (r.status === 204) return null;
  try {
    const j = await r.json() as { id?: unknown };
    return typeof j?.id === "string" && /^\d{1,32}$/.test(j.id) ? j.id : null;
  } catch {
    return null;
  }
}

/**
 * Post a Sol moment to the webhook. Never throws. Posts with `?wait=true` (B64.1, 2026-11-08) and
 * returns the Discord message id, so the appearance can be recorded with it as `ref` and a reply to
 * that exact post can count as a tend. Null = the moment was dropped. A 2xx without a readable id
 * (an old 204) still counts as posted, with `id: null`. One retry (after `retryDelayMs`) on a network
 * error, a timeout, 429 or 5xx; every failed attempt logs the status or error name (never the text,
 * never the URL). Before 2026-11-05 a failure here was swallowed by callers' `.catch(() => false)`
 * and the moment (including one-time milestones) vanished without a trace.
 */
export async function postSolMoment(webhookUrl: string, text: string, retryDelayMs = 2000): Promise<SolPosted | null> {
  const url = withWait(webhookUrl);
  for (let attempt = 1; attempt <= 2; attempt++) {
    let retryable = true;
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // R27: a webhook post resolves @everyone/@here/role/user mentions unless told not to.
        body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(10_000),
      });
      if (r.status >= 200 && r.status < 300) return { id: await messageId(r) };
      retryable = r.status === 429 || r.status >= 500;
      console.warn(`[sol] moment post failed: status ${r.status} (attempt ${attempt}/2, ${text.length} chars)`);
    } catch (e) {
      console.warn(`[sol] moment post failed: ${e instanceof Error ? e.name : "error"} (attempt ${attempt}/2, ${text.length} chars)`);
    }
    if (!retryable || attempt === 2) break;
    await new Promise((res) => setTimeout(res, retryDelayMs));
  }
  console.warn(`[sol] moment dropped after retry (${text.length} chars)`);
  return null;
}
