/**
 * H3 guest port (2026-11-10, BBH `Hand-off/VPS-SECURITY-READ-2026-11-10.md`, owner decision
 * "restricted guest port").
 *
 * Every Discord turn used to reach the companion's ONE Hermes gateway (8642/8643/8644), whose
 * api_server toolset is the full kit (terminal, file, browser, image_gen, skills, the halseth MCP
 * with writes). The only guest guard was prompt text (GUEST_FRAMING). Hermes resolves the toolset
 * per PROCESS (config.yaml `platform_toolsets.api_server` under its HERMES_HOME) and ignores
 * `tools` / `tool_choice` on the request, so the bot cannot narrow it per request. The control is
 * therefore a second, restricted gateway per companion (profiles `<c>-guest`, ports 8652-8654),
 * and this module decides which gateway a turn talks to.
 *
 * The rule (one pure predicate, `hermesPortFor`):
 *   - owner turns (attribution verified as Principal, own account or PK front)   -> owner port
 *   - Spouse ("intimate": his Discord id or a PK-verified member of his system) -> owner port
 *     (Principal 11-10, same day: "Spouse shouldn't be blocked off"; Spouse is family, not a guest)
 *   - sibling-companion and Sol turns (no human speaker; ids verified)         -> owner port
 *   - everything else: guests, an unverified PK proxy,
 *     any identity that did not resolve                                       -> GUEST port
 * Unknown = guest: fail closed. Autonomous / own-time / make / heartbeat paths never come through
 * here; they use `adapterRef.current` (the owner port) directly, because no human speaks there.
 *
 * Safe deploy: with `<BOT>_HERMES_GUEST_API_URL` unset every turn stays on the owner port exactly as
 * before (the log line says `guest=unset`). A value that is set but unusable (not http(s), or the
 * SAME url as the owner gateway) never falls back to the owner port: non-owner turns get a refusing
 * adapter (null -> the in-character fallback line) and boot logs it loudly. A guest gateway that is
 * down behaves the same way: the Hermes adapter returns null, there is no owner-port retry.
 *
 * Only the PREFIXED key is read. A generic `HERMES_GUEST_API_URL=` line would send all three bots'
 * guests to one companion's SOUL, so it is ignored (and boot warns if it is present).
 */
import type { ChatMessage } from "./types.js";
import { createAdapter, type InferenceAdapter } from "./inference.js";

/** The guest adapter bot-core builds once at boot: null when unset or not hermes mode, a refusing
 *  adapter when the url is set but unusable, else a Hermes adapter on the guest url (same bearer key:
 *  the guest profile carries the owner profile's API_SERVER_KEY). createAdapter wraps it in the
 *  script-bleed guard like every other bot adapter. */
export function buildGuestAdapter(
  companionId: string,
  spec: GuestUrlSpec,
  enabled: boolean,
  apiKey: string | undefined,
  fetchFn?: typeof fetch,
): InferenceAdapter | null {
  if (!enabled || spec.kind === "unset") return null;
  if (spec.kind === "invalid") return refusingGuestAdapter(companionId, spec.reason);
  return createAdapter("deepseek", "", { hermes: apiKey }, { hermes: spec.url, forceHermes: true }, fetchFn, companionId);
}

export type HermesPort = "owner" | "guest";
export type HermesRouteTier = "owner" | "intimate" | "guest" | "sibling" | "sol";

export interface RouteSpeaker {
  /** Attribution verified the speaker as the owner (own account or a confirmed PK front). */
  isOwner: boolean;
  /** Author id is a known companion bot (BOT_ID_COMPANION) and the post carries no webhook. */
  isSibling: boolean;
  /** Sol, recognized by webhook id (sol-sender.ts). */
  isSol: boolean;
  /** The handler's tier: "owner" | "intimate" (Spouse) | "guest". */
  userTier: "owner" | "intimate" | "guest";
}

/** Which kind of speaker drives this turn. Owner needs BOTH the verified flag and the owner tier. */
export function hermesRouteTier(s: RouteSpeaker): HermesRouteTier {
  if (s.isSol) return "sol";
  if (s.isSibling) return "sibling";
  if (s.isOwner && s.userTier === "owner") return "owner";
  if (s.userTier === "intimate") return "intimate";
  return "guest";
}

/** The one routing predicate. Anything not positively owner / sibling / Sol is the guest port. */
export function hermesPortFor(tier: HermesRouteTier): HermesPort {
  return tier === "owner" || tier === "intimate" || tier === "sibling" || tier === "sol" ? "owner" : "guest";
}

export type GuestUrlSpec =
  | { kind: "unset" }
  | { kind: "ok"; url: string }
  | { kind: "invalid"; reason: string };

const norm = (u: string): string => u.trim().replace(/\/+$/, "").toLowerCase();

/** The env key a bot reads: `CYPHER_HERMES_GUEST_API_URL` etc. */
export function guestUrlEnvKey(companionId: string): string {
  return `${companionId.toUpperCase()}_HERMES_GUEST_API_URL`;
}

/** Read the bot's own prefixed key (raw string, as config.ts stores it). */
export function readGuestUrlRaw(companionId: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[guestUrlEnvKey(companionId)]?.trim().replace(/^=+/, "");
  return raw ? raw : undefined;
}

/** Validate the configured guest url against the owner url. */
export function parseGuestUrl(raw: string | undefined, ownerUrl: string | undefined): GuestUrlSpec {
  if (raw === undefined || raw.trim() === "") return { kind: "unset" };
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { kind: "invalid", reason: "not a url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { kind: "invalid", reason: "not http(s)" };
  if (ownerUrl && norm(raw) === norm(ownerUrl)) return { kind: "invalid", reason: "same as the owner gateway url" };
  return { kind: "ok", url: raw.trim().replace(/\/+$/, "") };
}

/** Non-owner turns when the guest url is set but unusable: never the owner port, always null. */
export function refusingGuestAdapter(companionId: string, reason: string): InferenceAdapter {
  return {
    async generate(_s: string, _m: ChatMessage[]): Promise<string | null> {
      console.warn(`[hermes-route] ${companionId} guest gateway misconfigured (${reason}); non-owner turn refused`);
      return null;
    },
  };
}

export interface HermesRoute {
  tier: HermesRouteTier;
  port: HermesPort;
  adapter: InferenceAdapter;
  /** True when the turn wanted the guest port but no guest url is configured (old behaviour). */
  guestUnset: boolean;
}

export interface HermesRouter {
  /** False in direct mode: there is no tool-bearing gateway to route, every call is the live adapter. */
  enabled: boolean;
  guestConfigured: boolean;
  route(tier: HermesRouteTier): HermesRoute;
}

export interface HermesRouterOptions {
  companionId: string;
  /** The owner adapter, read live (model switches rebuild adapterRef.current). */
  owner: () => InferenceAdapter;
  /** Built once at boot; null = guest url unset (route keeps the owner port, old behaviour). */
  guest: InferenceAdapter | null;
  /** INFERENCE_MODE=hermes with a Hermes url (apiUrls.forceHermes). */
  enabled: boolean;
}

export function createHermesRouter(opts: HermesRouterOptions): HermesRouter {
  return {
    enabled: opts.enabled,
    guestConfigured: opts.guest !== null,
    route(tier: HermesRouteTier): HermesRoute {
      if (!opts.enabled) return { tier, port: "owner", adapter: opts.owner(), guestUnset: false };
      const want = hermesPortFor(tier);
      if (want === "guest" && opts.guest) return { tier, port: "guest", adapter: opts.guest, guestUnset: false };
      return { tier, port: "owner", adapter: opts.owner(), guestUnset: want === "guest" };
    },
  };
}

/** `[hermes-route] <c> tier=<t> port=owner|guest` (+ ` guest=unset`). Ids only, never content. */
export function hermesRouteLine(companionId: string, r: Pick<HermesRoute, "tier" | "port" | "guestUnset">, where?: string): string {
  return `[hermes-route] ${companionId} tier=${r.tier} port=${r.port}${r.guestUnset ? " guest=unset" : ""}${where ? ` at=${where}` : ""}`;
}

/** Transcript id on the guest gateway. The two gateways keep separate state.db files, so the bare id
 *  would not collide there; the suffix exists for the BOT's own per-transcript keys (PK profile, facts
 *  and people seen-marks, the delivered mark, the rotation edge), which must not treat a block the
 *  owner gateway received as delivered to the guest gateway, or the reverse. */
export function routedSessionId(sessionId: string, port: HermesPort): string {
  return port === "guest" ? `${sessionId}:guest` : sessionId;
}

/** Per-channel map key for the bot's delivered mark / last session id, scoped by port. */
export function routedChannelKey(channelId: string, port: HermesPort): string {
  return port === "guest" ? `${channelId}#guest` : channelId;
}

/** Boot lines (names and kinds only, never the url's credentials; urls here are local and keyless). */
export function guestBootLines(companionId: string, spec: GuestUrlSpec, enabled: boolean, env: NodeJS.ProcessEnv = process.env): Array<{ level: "log" | "warn"; text: string }> {
  const out: Array<{ level: "log" | "warn"; text: string }> = [];
  if (env["HERMES_GUEST_API_URL"] !== undefined) {
    out.push({ level: "warn", text: `[hermes-route] ${companionId} generic HERMES_GUEST_API_URL is IGNORED; set ${guestUrlEnvKey(companionId)}` });
  }
  if (!enabled) {
    if (spec.kind !== "unset") out.push({ level: "log", text: `[hermes-route] ${companionId} not hermes mode; guest url unused` });
    return out;
  }
  if (spec.kind === "unset") out.push({ level: "log", text: `[hermes-route] ${companionId} guest port: unset (every turn on the owner gateway)` });
  else if (spec.kind === "ok") out.push({ level: "log", text: `[hermes-route] ${companionId} guest port: ${spec.url} (non-owner turns)` });
  else out.push({ level: "warn", text: `[hermes-route] ${companionId} guest port INVALID (${spec.reason}): non-owner turns will be REFUSED, never sent to the owner gateway` });
  return out;
}
