// Generated media relay (2026-11-08).
//
// WHY. Hermes' own `image_generate` tool writes the picture to the gateway's local cache
// (`~/.hermes/[profiles/<p>/]cache/images/<file>.png`) and hands the model a FILE PATH. Hermes'
// own platform adapters turn that path into an upload; our bots talk to Hermes over the API
// server, so the reply arrives as plain text and the path was posted as words. 11-08 11:53:
// Drevan made a picture for Principal (flux-schnell, success, file on disk), Principal saw a path and
// "couldn't find it". The gateway and the bots run on the same box as the same user, so the bot
// can read the file and attach it.
//
// SAFETY. Only paths inside a Hermes image cache are ever read: the pattern pins the directory
// and the file name has no slash, so a reply cannot steer the bot into attaching any other file.
// A path that does not exist, is not a regular file, or is over Discord's limit is a PHANTOM: it is
// removed from the posted text too (a dead path is never useful to Principal) and reported in
// `missing`, so the caller can regenerate once (11-08 18:26: Drevan wrote a cache path for a picture
// he never made; no image_generate call, no file) and, failing that, say plainly it did not come through.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 4;

// MEDIA:<path> (Hermes' delivery convention), markdown ![alt](<path>), or a bare path.
const PATH_SRC = String.raw`(?:~|/home/[A-Za-z0-9._-]+)/\.hermes/(?:profiles/[A-Za-z0-9_-]+/)?cache/images/[A-Za-z0-9_.-]+\.(?:png|jpe?g|webp|gif)`;
const MEDIA_RE = new RegExp(String.raw`!\[[^\]\n]*\]\(\s*(?:MEDIA:\s*)?(${PATH_SRC})\s*\)|(?:MEDIA:\s*)?\x60?(${PATH_SRC})\x60?`, "g");

export interface GeneratedMedia {
  /** Reply text with every attached path removed (whitespace tidied). */
  text: string;
  /** Absolute paths to attach, in order of appearance, deduped. */
  files: string[];
  /** Image-cache paths named in the text with no usable file behind them (phantoms), deduped. */
  missing: string[];
}

/** The note a phantom-image regeneration carries (frame tail; the gateway drops caller system prompts). */
export const PHANTOM_IMAGE_NOTE =
  "[Your draft named an image file that does not exist: no picture was made, so none can be shown. " +
  "If you want to give a picture, call your image_generate tool now and the bot will attach what it makes. " +
  "If not, answer without any file path. Never write an image path yourself.]";

export const PHANTOM_IMAGE_MARK = "*(the picture didn't come through)*";

function expandHome(p: string, home: string): string {
  return p.startsWith("~/") ? path.posix.join(home, p.slice(2)) : p;
}

export async function extractGeneratedMedia(
  text: string,
  opts: { home?: string; stat?: (p: string) => Promise<{ isFile(): boolean; size: number }> } = {},
): Promise<GeneratedMedia> {
  if (!text || !text.includes("/.hermes/")) return { text, files: [], missing: [] };
  const home = opts.home ?? os.homedir();
  const stat = opts.stat ?? ((p: string) => fs.stat(p));
  const files: string[] = [];
  const missing: string[] = [];
  const ok = new Map<string, boolean>();
  for (const m of text.matchAll(MEDIA_RE)) {
    const raw = (m[1] ?? m[2])!;
    if (ok.has(raw)) continue;
    const abs = expandHome(raw, home);
    let good = false;
    if (files.length < MAX_FILES) {
      try { const s = await stat(abs); good = s.isFile() && s.size > 0 && s.size <= MAX_BYTES; } catch { good = false; }
    }
    ok.set(raw, good);
    if (good && !files.includes(abs)) files.push(abs);
    if (!good && !missing.includes(abs)) missing.push(abs);
  }
  if (files.length === 0 && missing.length === 0) return { text, files, missing };
  const stripped = text
    .replace(MEDIA_RE, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
  return { text: stripped, files, missing };
}
