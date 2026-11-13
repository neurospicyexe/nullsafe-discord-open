// turn-hub.ts -- the hub log: ONE JSON line per run in /app/logs/turns.jsonl (Phase 1 of
// Hand-off/SPEC-turn-key-2026-11-11.md). Every other log carries only the turn id; this row lists
// the ids a run touched so they join.
//
// IDS AND COUNTS ONLY. Never message text, never model output, never fact or note text: the row type
// has no field that could hold any. Fail-open: a write error is swallowed (it must never reach a turn).

import { promises as fsp } from "node:fs";
import path from "node:path";

const OFF = new Set(["off", "0", "false", "no"]);
export const TURN_LOG_DEFAULT = "/app/logs/turns.jsonl";

export type TurnKind =
  | "reply" | "absorb" | "lull_release" | "pass"
  | "heartbeat" | "make" | "interest_offer" | "consolidation" | "spouse_note" | "med";

export interface TurnHubRow {
  turn: string;
  at: string;
  c: string;
  kind: TurnKind;
  ch: string | null;
  /** Discord message id this run answered (posted), else null. */
  answered: string | null;
  /** Ids of the earlier burst messages folded into this run. */
  absorbed: string[];
  /** The deleted pre-proxy PluralKit message id, when known. */
  pk_original: string | null;
  /** The message id the human's Discord reply pointed at. */
  reply_target: string | null;
  /** Hermes transcript (session) id. */
  transcript: string | null;
  hermes_calls: number;
  regenerates: number;
  /** Ids of the messages we posted. */
  sent: string[];
  outcome: string;
  tokens_in: number;
  tokens_out: number;
}

/** TURN_LOG: a path, default /app/logs/turns.jsonl; off/0/false/no disables the hub row. */
export function turnLogPath(env: Record<string, string | undefined> = process.env): string | null {
  const v = (env["TURN_LOG"] ?? "").trim();
  if (OFF.has(v.toLowerCase())) return null;
  return v || TURN_LOG_DEFAULT;
}

/** Detached append. Resolves, never rejects. Unit tests do not touch the default path. */
export function appendTurnRow(row: TurnHubRow, env: Record<string, string | undefined> = process.env): Promise<void> {
  try {
    const file = turnLogPath(env);
    if (!file) return Promise.resolve();
    if (!(env["TURN_LOG"] ?? "").trim() && env["NODE_ENV"] === "test") return Promise.resolve();
    const line = JSON.stringify(row) + "\n";
    return (async () => {
      try {
        try { await fsp.mkdir(path.dirname(file), { recursive: true }); } catch { /* best effort */ }
        await fsp.appendFile(file, line, "utf8");
      } catch { /* a hub log is never the reason a turn fails */ }
    })();
  } catch { return Promise.resolve(); }
}
