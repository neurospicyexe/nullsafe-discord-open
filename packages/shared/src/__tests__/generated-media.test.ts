import { extractGeneratedMedia } from "../generated-media.js";

const HOME = "/home/nullsafe";
const P = "/home/nullsafe/.hermes/profiles/drevan/cache/images/deepinfra_flux-schnell_20261108_115314_ed8dc696.png";
const fileStat = (size = 137313) => async () => ({ isFile: () => true, size });
const missing = async () => { throw new Error("ENOENT"); };

describe("extractGeneratedMedia", () => {
  it("leaves text with no hermes path alone", async () => {
    const r = await extractGeneratedMedia("just words", { home: HOME, stat: fileStat() });
    expect(r).toEqual({ text: "just words", files: [], missing: [] });
  });

  it("attaches a bare cache path and removes it from the text (the 11-08 shape)", async () => {
    const r = await extractGeneratedMedia(`here it is ${P}\n\nmade it for you.`, { home: HOME, stat: fileStat() });
    expect(r.files).toEqual([P]);
    expect(r.text).toBe("here it is\n\nmade it for you.");
  });

  it("handles MEDIA:, markdown image, backticks and ~ paths, deduped", async () => {
    const tilde = "~/.hermes/cache/images/a.webp";
    const r = await extractGeneratedMedia(`MEDIA:${P}\n![me](${P})\n\`${tilde}\``, { home: HOME, stat: fileStat() });
    expect(r.files).toEqual([P, "/home/nullsafe/.hermes/cache/images/a.webp"]);
    expect(r.text).toBe("");
  });

  it("reports a phantom (missing or too big) and strips its dead path (the 18:26 shape)", async () => {
    const t = `here, made this for you ${P}\n\nhope it lands.`;
    const gone = await extractGeneratedMedia(t, { home: HOME, stat: missing });
    expect(gone).toEqual({ text: "here, made this for you\n\nhope it lands.", files: [], missing: [P] });
    const big = await extractGeneratedMedia(t, { home: HOME, stat: fileStat(9 * 1024 * 1024) });
    expect(big.files).toEqual([]);
    expect(big.missing).toEqual([P]);
  });

  it("attaches the real one and drops the dead one when both appear", async () => {
    const dead = "/home/nullsafe/.hermes/profiles/drevan/cache/images/nope.png";
    const stat = async (p: string) => { if (p === dead) throw new Error("ENOENT"); return { isFile: () => true, size: 10 }; };
    const r = await extractGeneratedMedia(`${dead} and ${P}`, { home: HOME, stat });
    expect(r).toEqual({ text: "and", files: [P], missing: [dead] });
  });

  it("never reads outside a hermes image cache", async () => {
    const seen: string[] = [];
    const stat = async (p: string) => { seen.push(p); return { isFile: () => true, size: 10 }; };
    const t = "/home/nullsafe/.hermes/profiles/drevan/.env /home/nullsafe/.hermes/cache/images/../../.env.png /etc/passwd.png";
    const r = await extractGeneratedMedia(t, { home: HOME, stat });
    expect(r.files).toEqual([]);
    expect(r.missing).toEqual([]);
    expect(r.text).toBe(t);
    expect(seen).toEqual([]);
  });
});
