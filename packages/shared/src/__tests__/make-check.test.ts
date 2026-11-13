import { describe, it, expect } from "@jest/globals";
import { checkMake, makeCheckSelfTest } from "../make-check.js";
import { strudelEventProblem } from "../strudel-rules.js";
import { sanitizeSvg } from "../svg-sanitize.js";

describe("strudelEventProblem (sound-time rules)", () => {
  it("a note NAME in n on a harmonic wave is named, with the fix (Drevan's piece, 11-10)", () => {
    const p = strudelEventProblem({ s: "sawtooth", n: "c2" });
    expect(p).toMatch(/n\("c2"\) on sawtooth/);
    expect(p).toMatch(/note\("c2"\)/);
  });
  it("sine ignores n, and numeric n on a synth is harmonics (allowed)", () => {
    expect(strudelEventProblem({ s: "sine", n: "g2" })).toBeNull();
    expect(strudelEventProblem({ s: "triangle", n: 3 })).toBeNull();
    expect(strudelEventProblem({ s: "square", n: 0 })).toBeNull();
  });
  it("samples with n are an index, never flagged", () => {
    expect(strudelEventProblem({ s: "bd", n: 2 })).toBeNull();
  });
  it("a sound outside the built-ins and the loaded bank is silence, named; unless the code loads its own samples", () => {
    expect(strudelEventProblem({ s: "oh" })).toMatch(/no sound called "oh"/);
    expect(strudelEventProblem({ s: "rim" })).toMatch(/no sound called "rim"/);
    expect(strudelEventProblem({ s: "rim" }, { ownSamples: true })).toBeNull();
    expect(strudelEventProblem({ s: "bd:3" })).toBeNull();
    expect(strudelEventProblem({ s: "supersaw", note: "c3" })).toBeNull();
    expect(strudelEventProblem({ note: "c3" })).toBeNull();
  });
  it("vibrato with units is not a number (vibrato(\"4Hz:0.02\") arrives as vib \"4Hz\")", () => {
    expect(strudelEventProblem({ s: "sine", vib: "4Hz", vibmod: 0.02 })).toMatch(/vib\("4Hz"\) must be a number.*vib\("4:0\.02"\)/);
    expect(strudelEventProblem({ s: "sine", vib: 4, vibmod: 0.02 })).toBeNull();
  });
  it("NaN in a numeric control, and a bare value with no sound controls", () => {
    expect(strudelEventProblem({ s: "bd", gain: NaN })).toMatch(/gain came out as NaN/);
    expect(strudelEventProblem({ s: "bd", lpf: "loud" })).toMatch(/lpf\("loud"\) must be a number/);
    expect(strudelEventProblem(3)).toMatch(/bare value/);
  });
});

describe("checkMake", () => {
  it("music_code: the runner's problem comes back verbatim; a runner that cannot run fails open", async () => {
    const bad = await checkMake("music_code", "x", { runStrudel: async () => ({ ok: false, problem: "jitter is not a function" }) });
    expect(bad).toEqual({ ok: false, problem: "jitter is not a function" });
    expect(await checkMake("music_code", "x", { runStrudel: async () => ({ ok: true }) })).toEqual({ ok: true, checked: true });
    expect(await checkMake("music_code", "x", { runStrudel: async () => null })).toMatchObject({ ok: true, checked: false });
    expect(await checkMake("music_code", "x", { runStrudel: async () => { throw new Error("boom"); } })).toMatchObject({ ok: true, checked: false });
  });
  it("drawing: rsvg sees the SANITIZED svg, so a ' -- ' comment never reaches it (Cypher's 11-10 drawing)", async () => {
    let seen = "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><!-- veins -- thick --><rect width="2" height="2"/></svg>`;
    const v = await checkMake("drawing", svg, { runRsvg: async (s) => { seen = s; return null; } });
    expect(v).toEqual({ ok: true, checked: true });
    expect(seen).not.toContain("--");
    expect(seen).toBe(sanitizeSvg(svg));
  });
  it("drawing: an rsvg error is the problem; no rsvg here = unchecked; not an svg = problem", async () => {
    expect(await checkMake("drawing", "<svg><g></svg>", { runRsvg: async () => "Opening and ending tag mismatch" }))
      .toEqual({ ok: false, problem: "the SVG does not render: Opening and ending tag mismatch" });
    expect(await checkMake("drawing", "<svg><rect/></svg>", { runRsvg: async () => undefined })).toMatchObject({ ok: true, checked: false });
    expect(await checkMake("drawing", "<div/>")).toMatchObject({ ok: false, problem: expect.stringMatching(/not an SVG/) });
  });
  it("scad and page rules", async () => {
    expect(await checkMake("scad", "include <x.scad>")).toMatchObject({ ok: false });
    expect(await checkMake("scad", "cube(5);")).toEqual({ ok: true, checked: true });
    expect(await checkMake("page", `<html><script src="https://cdn.x/y.js"></script></html>`)).toMatchObject({ ok: false, problem: expect.stringMatching(/internet/) });
    expect(await checkMake("page", `<img src="//x.test/a.png">`)).toMatchObject({ ok: false });
    expect(await checkMake("page", `<html><script>let a=1</script><img src="data:image/png;base64,AA"></html>`)).toEqual({ ok: true, checked: true });
    expect(await checkMake("page", "just prose")).toMatchObject({ ok: false });
  });
  it("writing and prompt kinds are not checked", async () => {
    expect(await checkMake("writing", "a poem")).toEqual({ ok: true, checked: false });
    expect(await checkMake("video", undefined)).toEqual({ ok: true, checked: false });
  });
});

describe("makeCheckSelfTest", () => {
  it("ok when good passes and bad fails; UNAVAILABLE when nothing can run; BROKEN when bad passes", async () => {
    const runStrudel = async (c: string) => (c.includes("jitter") ? { ok: false as const, problem: "x" } : { ok: true as const });
    expect(await makeCheckSelfTest({ runStrudel, runRsvg: async () => "mismatch" })).toMatch(/strudel=ok rsvg=ok/);
    expect(await makeCheckSelfTest({ runStrudel: async () => null, runRsvg: async () => undefined })).toMatch(/strudel=UNAVAILABLE rsvg=absent/);
    expect(await makeCheckSelfTest({ runStrudel: async () => ({ ok: true }), runRsvg: async () => null })).toMatch(/strudel=BROKEN rsvg=BROKEN/);
  });
});
