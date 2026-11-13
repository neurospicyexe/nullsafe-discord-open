// strudel-check-child.ts -- run as its own node process by make-check.ts `checkStrudel`, never imported.
// Strudel's evalScope writes hundreds of names onto globalThis (s, n, run, register, ...), so the check
// lives in a child: the bot process never sees them, and a pattern that loops forever dies with the child.
//
// Reads the pattern from stdin, evaluates it with the same Strudel 1.1.0 packages Hearth's player loads
// (@strudel/web 1.1.0 is built from these), queries 8 cycles, and prints ONE JSON line:
//   {"ok":true,"events":N}  or  {"ok":false,"problem":"<short reason>"}

import * as nodeModule from "node:module";

// module.registerHooks is Node >= 22.15 / 23.5 (the VPS runs 24); the installed @types/node predates it.
type ResolveHook = (specifier: string, context: unknown, next: unknown) => unknown;
const registerHooks = (nodeModule as unknown as { registerHooks?: (h: { resolve: ResolveHook }) => unknown }).registerHooks;
import { strudelEventProblem } from "./strudel-rules.js";

// Captured before lockdown(): once the pattern runs, this one line is the only way out of the process.
const write = process.stdout.write.bind(process.stdout);

// What @strudel/web adds on top of core+mini+tonal (diffed against the 1.1.0 bundle, 2026-11-10):
// audio-engine globals and the visual Pattern methods. A pattern may call them; here they do nothing.
const WEB_GLOBALS = [
  "samples", "setcps", "setCps", "setcpm", "hush", "panic", "initAudio", "initAudioOnFirstClick", "registerSound",
  "registerSynthSounds", "registerZZFXSounds", "registerSamplesPrefix", "setDefaultValue", "setDefaultValues",
  "resetDefaultValues", "resetGlobalEffects", "resetLoadedSounds", "soundMap", "aliasBank", "loadBuffer",
];
const VISUAL_METHODS = [
  "p", "q", "draw", "onPaint", "animate", "pianoroll", "punchcard", "wordfall", "spiral", "pitchwheel",
  "fscope", "tscope", "scope", "_pianoroll", "_punchcard", "_scope", "_spiral", "_pitchwheel",
];

function say(o: { ok: true; events: number } | { ok: false; problem: string }): void {
  write(JSON.stringify(o) + "\n");
}

function short(e: unknown): string {
  const m = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim();
  // fraction.js's bare "Invalid argument" is what a double-quoted string that is not mini-notation
  // produces (every "..." is parsed as a pattern), e.g. samples("github:..."). Say that.
  if (m === "Invalid argument") {
    return "Invalid argument: every double-quoted string is read as a pattern, so a plain string (a URL, a sample-bank name) must use single quotes, e.g. samples('github:tidalcycles/dirt-samples')";
  }
  return m.slice(0, 240) || "unknown error";
}

/**
 * After Strudel is loaded and before the pattern runs. Found 11-10: through the workspace symlink
 * node_modules/@nullsafe/shared -> packages/shared, a pattern could read ../../.env, and https was there
 * to send it (Node 24's permission model follows symlinks and has no network switch; this VPS forbids
 * unprivileged namespaces). So the pattern gets no module system and no real process:
 *  - every further import is refused (node:fs, node:net, node:https, a file URL, anything);
 *  - globalThis.process becomes a bare stand-in (no getBuiltinModule, binding, dlopen, kill, env);
 *  - the parent's --permission flags and empty env stay as the second layer.
 */
function lockdown(): void {
  // No hook API = no lockdown = never evaluate. "checker error" makes the parent treat it as unchecked.
  if (typeof registerHooks !== "function") throw new Error("checker error: module.registerHooks unavailable, refusing to run a pattern unlocked");
  registerHooks({
    resolve(specifier: string) {
      throw new Error(`import of "${String(specifier).slice(0, 60)}" is not available to a pattern`);
    },
  });
  const nextTick = (f: (...a: unknown[]) => void, ...a: unknown[]) => queueMicrotask(() => f(...a));
  const stand = Object.freeze({ env: Object.freeze({}), argv: Object.freeze([]), platform: "linux", versions: Object.freeze({}), nextTick });
  Object.defineProperty(globalThis, "process", { value: stand, configurable: false, writable: false });
}

// The @strudel packages ship no types; a non-literal specifier keeps tsc from resolving them.
const load = (name: string): Promise<any> => import(name); // eslint-disable-line @typescript-eslint/no-explicit-any

async function main(): Promise<void> {
  let code = "";
  for await (const chunk of process.stdin) code += chunk;
  // Strudel logs a banner and "not in browser" lines on import; keep stdout for our one JSON line.
  console.log = () => {}; console.warn = () => {}; console.info = () => {};

  const core = await load("@strudel/core") as Record<string, unknown> & {
    evalScope: (...a: unknown[]) => Promise<unknown>;
    evaluate: (code: string, transpiler: unknown) => Promise<{ pattern: { queryArc: (a: number, b: number) => Array<{ value: unknown }> } }>;
    Pattern: { prototype: Record<string, unknown> };
  };
  const mini = await load("@strudel/mini");
  const tonal = await load("@strudel/tonal");
  const { transpiler } = await load("@strudel/transpiler") as { transpiler: unknown };

  const stubs: Record<string, unknown> = {};
  for (const g of WEB_GLOBALS) stubs[g] = () => Promise.resolve();
  await core.evalScope(core, mini, tonal, stubs);
  for (const m of VISUAL_METHODS) {
    if (typeof core.Pattern.prototype[m] !== "function") core.Pattern.prototype[m] = function (this: unknown) { return this; };
  }
  // The pattern is companion-written code. Node 24's permission model (set by the parent) does not
  // cover the network, so the web-shaped ways out go before it runs. A pattern never needs them here.
  for (const g of ["fetch", "WebSocket", "XMLHttpRequest", "EventSource", "Request"]) {
    try { Object.defineProperty(globalThis, g, { value: undefined, configurable: false, writable: false }); } catch { /* already gone */ }
  }

  lockdown();

  let pattern;
  try {
    ({ pattern } = await core.evaluate(code, transpiler));
  } catch (e) {
    return say({ ok: false, problem: short(e) });
  }
  if (!pattern || typeof pattern.queryArc !== "function") {
    return say({ ok: false, problem: "the code does not end in a pattern (the last expression must be the music, e.g. stack(...) or s(\"bd sd\"))" });
  }
  let events: Array<{ value: unknown }>;
  try {
    events = pattern.queryArc(0, 8);
  } catch (e) {
    return say({ ok: false, problem: `it evaluates, but fails while playing: ${short(e)}` });
  }
  if (events.length === 0) return say({ ok: false, problem: "it evaluates, but makes no sound in its first 8 cycles" });
  const ownSamples = /\bsamples\s*\(/.test(code);
  for (const ev of events) {
    const p = strudelEventProblem(ev.value, { ownSamples });
    if (p) return say({ ok: false, problem: p });
  }
  say({ ok: true, events: events.length });
}

main().catch((e) => say({ ok: false, problem: `checker error: ${short(e)}` }));
