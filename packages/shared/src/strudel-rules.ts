// strudel-rules.ts -- what makes a Strudel event fail at SOUND time even though the pattern evaluates.
// Pure, so it is tested without Strudel. Each rule comes from a real failure, read out of the
// @strudel/web 1.1.0 bundle Hearth's player loads.

/**
 * Waves that superdough builds from `n` harmonics when `n` is truthy (bundle: `!u||e==="sine" ?
 * createOscillator : Yl(u,e)`, and Yl does `new Float32Array(n+1)`). A note NAME in `n` makes that array
 * empty and the event throws `createPeriodicWave ... length of the real array provided (0)`: Drevan's
 * "Scaffolds for Babbling", 2026-11-10 (`n("<c2 e2 g2>").s("sawtooth")`). Sine ignores `n`.
 */
const HARMONIC_WAVES = new Set(["sawtooth", "square", "triangle"]);

/** Sounds the player has without loading anything: superdough's synths, noises and zzfx (bundle W2/$2). */
const BUILTIN_SOUNDS = new Set([
  "sine", "square", "sawtooth", "triangle", "supersaw", "pink", "white", "brown", "crackle",
  "zzfx", "z_sine", "z_square", "z_sawtooth", "z_triangle", "z_tan", "z_noise",
]);

/**
 * The bank Hearth's player prebakes (github:tidalcycles/dirt-samples strudel.json, snapshot 2026-11-10).
 * A name outside it and the built-ins plays SILENCE with no error ("oh" and "rim" are not in it).
 */
export const DIRT_SAMPLES: ReadonlySet<string> = new Set([
  "808", "909", "808bd", "808cy", "808hc", "808ht", "808lc", "808lt", "808mc", "808mt", "808oh", "808sd", "ab",
  "ade", "ades2", "ades3", "ades4", "alex", "alphabet", "amencutup", "armora", "arp", "arpy", "auto", "baa",
  "baa2", "bass", "bass0", "bass1", "bass2", "bass3", "bassdm", "bassfoo", "battles", "bd", "bend", "bev",
  "bin", "birds", "birds3", "bleep", "blip", "spouse", "bottle", "breaks125", "breaks152", "breaks157",
  "breaks165", "breath", "bubble", "can", "casio", "cb", "cc", "chin", "circus", "clak", "click", "clubkick",
  "co", "coins", "control", "cosmicg", "cp", "cr", "crow", "d", "db", "diphone", "diphone2", "dist", "dork2",
  "dorkbot", "dr", "dr2", "dr55", "dr_few", "drum", "drumtraks", "e", "east", "electro1", "em2", "erk", "f",
  "feel", "feelfx", "fest", "fire", "flick", "fm", "foo", "future", "gab", "gabba", "gabbaloud", "gabbalouder",
  "glasstap", "glitch", "glitch2", "gretsch", "gtr", "h", "hand", "hardcore", "hardkick", "haw", "hc", "hh",
  "hh27", "hit", "hmm", "ho", "hoover", "house", "ht", "if", "ifdrums", "incoming", "industrial", "insect",
  "invaders", "jazz", "jungbass", "jungle", "juno", "jvbass", "kicklinn", "koy", "kurt", "latibro", "led",
  "less", "lighter", "linnhats", "lt", "made", "made2", "mash", "mash2", "metal", "miniyeah", "monsterb",
  "moog", "mouth", "mp3", "msg", "mt", "mute", "newnotes", "noise", "noise2", "notes", "numbers", "num", "oc",
  "odx", "off", "outdoor", "pad", "padlong", "pebbles", "perc", "peri", "pluck", "popkick", "print", "proc",
  "procshort", "psr", "rave", "rave2", "ravemono", "realclaps", "reverbkick", "rm", "rs", "sax", "sd",
  "seawolf", "sequential", "sf", "sheffield", "short", "sid", "simplesine", "sitar", "sn", "space",
  "speakspell", "speech", "speechless", "speedupdown", "stab", "stomp", "subroc3d", "sugar", "sundance",
  "tabla", "tabla2", "tablex", "tacscan", "tech", "techno", "tink", "tok", "toys", "trump", "ul", "ulgab",
  "uxay", "v", "voodoo", "wind", "wobble", "world", "xmas", "yeah",
]);

/** Controls superdough reads as numbers; a NaN or a word in one is silence or a throw. */
const NUMERIC = ["gain", "velocity", "speed", "lpf", "cutoff", "hpf", "bpf", "room", "size", "delay", "pan",
  "attack", "decay", "sustain", "release", "shape", "crush", "coarse", "postgain", "cps", "duration",
  // vibrato("4Hz:0.02") arrives as vib "4Hz": the oscillator frequency becomes NaN (Drevan's piece, 11-10).
  "vib", "vibmod"];

export interface EventRuleOpts {
  /** The code loads its own samples (a samples(...) call): unknown sound names may be theirs. */
  ownSamples?: boolean;
}

/** null = this event can sound; otherwise one short line the maker can act on. */
export function strudelEventProblem(value: unknown, opts: EventRuleOpts = {}): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return `an event carries a bare value (${JSON.stringify(value)?.slice(0, 40)}) instead of sound controls; give it a sound with s("...") or note("...")`;
  }
  const v = value as Record<string, unknown>;
  const sound = typeof v["s"] === "string" ? (v["s"] as string).split(":")[0]!.trim() : undefined;
  if (sound && !opts.ownSamples && !BUILTIN_SOUNDS.has(sound.toLowerCase()) && !DIRT_SAMPLES.has(sound)) {
    return `there is no sound called "${sound.slice(0, 30)}": it would play silence. Synths: sine, square, sawtooth, triangle, supersaw; drums and samples from the default bank such as bd, sd, hh, cp, cr, ho, rm, perc, tabla`;
  }
  const wave = sound?.toLowerCase();
  const n = v["n"];
  if (wave && HARMONIC_WAVES.has(wave) && n !== undefined && n !== 0) {
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
      return `n(${JSON.stringify(n)}) on ${wave}: on a synth wave n is its NUMBER OF HARMONICS, not a pitch, so this throws when it plays. Use note(${JSON.stringify(n)}) for pitch`;
    }
  }
  for (const k of NUMERIC) {
    const x = v[k];
    if (typeof x === "number" && !Number.isFinite(x)) return `${k} came out as ${x} (not a number)`;
    if (typeof x === "string" && x.trim() !== "" && !Number.isFinite(Number(x))) {
      return `${k}(${JSON.stringify(x).slice(0, 30)}) must be a number${k === "vib" ? ' (vibrato takes "rate:depth" as numbers, e.g. vib("4:0.02"))' : ""}`;
    }
  }
  return null;
}
