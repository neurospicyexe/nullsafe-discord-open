// The SVG sanitizer and scad gate, shared so the bot's pre-check (make-check.ts) and the worker's
// renderer (autonomous-worker makes-render.ts) judge a drawing by exactly the same rules.

export const MAX_SOURCE_BYTES = 64 * 1024;

/**
 * Strip what makes an SVG active or external before it meets rsvg-convert: comments, scripts, event
 * handlers, foreignObject, DOCTYPE/ENTITY (XXE), and any href / url() that is not an in-document
 * #fragment or an inline data: image. Returns null when it is not an SVG document at all.
 */
export function sanitizeSvg(src: string): string | null {
  if (!/<svg[\s>]/i.test(src)) return null;
  let s = src;
  // Comments never render, and XML forbids "--" inside one. The triad's no-em-dash habit writes
  // " -- " in SVG comments, which made libxml reject the whole file (11-10 "svg did not render").
  s = s.replace(/<!--[\s\S]*?-->/g, "").replace(/<!--[\s\S]*$/g, "");
  s = s.replace(/<!DOCTYPE[\s\S]*?(\]>|>)/gi, "").replace(/<!ENTITY[\s\S]*?>/gi, "");
  s = s.replace(/<script[\s\S]*?<\/script\s*>/gi, "").replace(/<script[\s\S]*$/gi, "");
  s = s.replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, "").replace(/<foreignObject[\s\S]*$/gi, "");
  s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  // href / xlink:href: keep only #fragment and inline data:image targets.
  s = s.replace(/\s(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, (m, a?: string, b?: string) => {
    const v = (a ?? b ?? "").trim();
    return v.startsWith("#") || /^data:image\/(png|jpe?g|gif|webp);/i.test(v) ? m : "";
  });
  s = s.replace(/url\(\s*['"]?(?!#)[^)]*\)/gi, (m) => (/^url\(\s*['"]?data:image\//i.test(m) ? m : "none"));
  s = s.replace(/@import[^;]*;?/gi, "");
  return /<svg[\s>]/i.test(s) ? s : null;
}

const SCAD_DENY = /\b(include|use|import|surface)\b/;

/** null = fine; otherwise a short reason. */
export function scadProblem(src: string): string | null {
  if (Buffer.byteLength(src, "utf8") > MAX_SOURCE_BYTES) return "scad source too large";
  if (SCAD_DENY.test(src)) return "scad uses a blocked keyword";
  for (const m of src.matchAll(/\$fn\s*=\s*(\d+(?:\.\d+)?)/g)) {
    if (Number(m[1]) > 128) return "scad $fn above 128";
  }
  return null;
}
