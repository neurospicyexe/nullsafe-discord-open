// make-check.ts -- run a make before it lands (2026-11-10, Principal: "make it so those work, and when they
// don't the companion can know and fix it / try again").
//
// Two things on Hearth never worked and nobody knew: Drevan's Strudel piece (four invented calls) and
// Cypher's SVG (" -- " inside comments). The make move posted both as finished. Now the work is run by
// the same engine the shelf uses BEFORE it posts, and a failure goes back to the maker with the exact
// reason (make-move.ts re-asks). Fails OPEN: a checker that cannot run (no node, no rsvg, a timeout we
// caused) never blocks a make; the worker and Hearth still judge it after.

import { spawn, execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeSvg, scadProblem } from "./svg-sanitize.js";

export type CheckVerdict =
  | { ok: true; checked: boolean; note?: string }
  | { ok: false; problem: string };

export interface CheckDeps {
  /** Evaluate a Strudel pattern; null = the checker could not run (fail open). */
  runStrudel?: (code: string) => Promise<{ ok: true } | { ok: false; problem: string } | null>;
  /** Render a sanitized SVG; null = rendered, string = the tool's error line, undefined = no rsvg here. */
  runRsvg?: (svg: string) => Promise<string | null | undefined>;
}

const STRUDEL_TIMEOUT_MS = 15_000;
const RSVG_TIMEOUT_MS = 20_000;

function short(s: string): string { return s.replace(/\s+/g, " ").trim().slice(0, 240); }

/**
 * The child runs companion-written JavaScript, so it gets as little as Node allows: an EMPTY environment
 * (no tokens), a scratch cwd, and the permission model with file READS limited to the shared package's
 * dist + package.json and the node_modules it imports from (never the repo root, where .env lives), no
 * writes, no child processes, no workers. Node 24's permission model does not cover the network, so the
 * child also removes fetch/WebSocket before evaluating (strudel-check-child.ts).
 */
export function strudelChildArgs(script: string): string[] {
  const dist = dirname(script);
  const pkgDir = dirname(dist);
  const reads = [dist, join(pkgDir, "package.json"), join(pkgDir, "node_modules"), join(pkgDir, "..", "..", "node_modules")];
  return ["--permission", ...reads.map(r => `--allow-fs-read=${r}`), script];
}

/** Spawn strudel-check-child.js (next to this file in dist) with the code on stdin. */
export function realRunStrudel(code: string): Promise<{ ok: true } | { ok: false; problem: string } | null> {
  return new Promise((resolve) => {
    let child;
    try {
      const script = fileURLToPath(new URL("./strudel-check-child.js", import.meta.url));
      child = spawn(process.execPath, strudelChildArgs(script), { stdio: ["pipe", "pipe", "ignore"], env: {}, cwd: tmpdir() });
    } catch { return resolve(null); }
    let out = "";
    let done = false;
    const finish = (v: { ok: true } | { ok: false; problem: string } | null) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      // A pattern that never finishes evaluating is the maker's to fix; say so plainly.
      finish({ ok: false, problem: `it did not finish evaluating within ${STRUDEL_TIMEOUT_MS / 1000}s (an endless loop?)` });
    }, STRUDEL_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    child.on("error", () => finish(null));
    child.on("close", () => {
      const line = out.trim().split(/\r?\n/).pop() ?? "";
      try {
        const j = JSON.parse(line) as { ok?: boolean; problem?: string };
        if (j.ok === true) return finish({ ok: true });
        if (typeof j.problem === "string") {
          // The checker's own breakage is not the maker's fault: fail open.
          return finish(j.problem.startsWith("checker error") ? null : { ok: false, problem: short(j.problem) });
        }
      } catch { /* fall through */ }
      finish(null);
    });
    child.stdin.on("error", () => { /* child died early; close handles it */ });
    child.stdin.end(code);
  });
}

/** rsvg-convert on the VPS; undefined when the binary is not here (dev boxes, tests). */
export async function realRunRsvg(svg: string): Promise<string | null | undefined> {
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "makecheck-"));
    await writeFile(join(dir, "source.svg"), svg);
    return await new Promise<string | null | undefined>((resolve) => {
      execFile("rsvg-convert", ["-w", "256", "source.svg", "-o", "check.png"], { cwd: dir!, timeout: RSVG_TIMEOUT_MS },
        (err, _o, stderr) => {
          if (!err) return resolve(null);
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return resolve(undefined);
          const lines = String(stderr ?? "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
          const line = lines.find(l => /error/i.test(l)) ?? lines[0] ?? "rsvg could not render it";
          resolve(short(line.replace(/(?:[A-Za-z]:)?[/\\](?:[^\s:/\\]+[/\\])+/g, "")));
        });
    });
  } catch { return undefined; }
  finally { if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

/** External loads a page cannot have: the shelf frames it under a CSP with no network at all. */
const PAGE_EXTERNAL = /<(?:script|link|img|iframe|audio|video|source)\b[^>]*\s(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//i;

export async function checkMake(kind: string, source: string | undefined, deps: CheckDeps = {}): Promise<CheckVerdict> {
  if (source === undefined) return { ok: true, checked: false };
  switch (kind) {
    case "music_code": {
      const r = await (deps.runStrudel ?? realRunStrudel)(source).catch(() => null);
      if (r === null) return { ok: true, checked: false, note: "strudel checker unavailable" };
      return r.ok ? { ok: true, checked: true } : { ok: false, problem: r.problem };
    }
    case "drawing": {
      const clean = sanitizeSvg(source);
      if (!clean) return { ok: false, problem: "it is not an SVG document (it needs an <svg> root)" };
      const r = await (deps.runRsvg ?? realRunRsvg)(clean).catch(() => undefined);
      if (r === undefined) return { ok: true, checked: false, note: "rsvg not available" };
      return r === null ? { ok: true, checked: true } : { ok: false, problem: `the SVG does not render: ${r}` };
    }
    case "scad": {
      const p = scadProblem(source);
      return p ? { ok: false, problem: p } : { ok: true, checked: true };
    }
    case "page": {
      if (!/<[a-z!]/i.test(source)) return { ok: false, problem: "it is not HTML (no tags at all)" };
      if (PAGE_EXTERNAL.test(source)) {
        return { ok: false, problem: "it loads something from the internet; the shelf shows pages with no network, so inline every script, style and image" };
      }
      return { ok: true, checked: true };
    }
    default:
      return { ok: true, checked: false };
  }
}

/** Kinds this check can say something about. */
export const CHECKED_KINDS: ReadonlySet<string> = new Set(["music_code", "drawing", "scad", "page"]);

/**
 * One boot line so a dead checker is never silent (it fails OPEN, which would otherwise read as "every
 * make passed"): a known-good and a known-bad pattern, and a mismatched-tag SVG through rsvg.
 * `[make-check] self-test strudel=ok|BROKEN|UNAVAILABLE rsvg=ok|BROKEN|absent ms=N`.
 */
export async function makeCheckSelfTest(deps: CheckDeps = {}): Promise<string> {
  const t0 = Date.now();
  const good = await checkMake("music_code", `s("bd sd").gain(0.8)`, deps);
  const bad = await checkMake("music_code", `s("bd").jitter(1)`, deps);
  const strudel = good.ok && !good.checked ? "UNAVAILABLE"
    : good.ok && good.checked && !bad.ok ? "ok"
    : "BROKEN";
  const svg = await checkMake("drawing", `<svg xmlns="http://www.w3.org/2000/svg"><g><rect width="2" height="2"/></svg>`, deps);
  const rsvg = svg.ok ? (svg.checked ? "BROKEN" : "absent") : "ok";
  return `[make-check] self-test strudel=${strudel} rsvg=${rsvg} ms=${Date.now() - t0}`;
}
