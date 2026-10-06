import { W_PISTOL, W_RIFLE, W_SHOTGUN } from "../../shared/weapons";

/**
 * All the sound in the game, synthesized, and built to sound like real
 * gunfire in a big indoor hall rather than like a synthesizer.
 *
 * Still no sample files. The APK has to stay small enough to download over a
 * phone connection, and every asset in it has to be ours, which a library of
 * gunshot recordings would not be. Instead each sound is modelled on what a
 * recording of the real thing is made of, rendered once into buffers when
 * audio starts, and played from those:
 *
 *   - Muzzle blast. A pressure wave with an attack well under a millisecond
 *     and a decay of tens of milliseconds: broadband noise shaped by two
 *     exponential envelopes, a sharp initial transient, a low "body"
 *     resonance from the barrel and receiver, and soft saturation, because
 *     every real gunshot recording clips its microphone a little and the ear
 *     has learned that as loudness.
 *   - The room. Most of what makes a gunshot indoors sound like one is the
 *     building answering it. The hall is a big iron and glass box, so the
 *     shot goes through a convolution reverb whose impulse response is
 *     generated here: a few millisecond pre-delay, discrete early
 *     reflections off the near walls, then a diffuse tail of almost two
 *     seconds that loses its highs as it decays.
 *   - Distance. Sound takes time to cross the hall (343 metres a second, a
 *     block is a metre), the air and the booths eat the high frequencies on
 *     the way, and far away the room is louder than the gun. A shot across
 *     the hall therefore arrives late, dull and boomy, which is the cue a
 *     player uses to judge range.
 *   - Direction. Other people's shots are panned to the side they came from.
 *   - Mechanism. The bolt or slide cycling, brass casings tinkling onto the
 *     boards a moment later, the shotgun's pump, and reloads with a release,
 *     a magazine out, a magazine in and a charging handle.
 *
 * Every played sound picks one of several pre-rendered variants and a small
 * random pitch change, so an automatic burst is never the same buffer twice.
 * Cosmetic, so Math.random is fine here.
 *
 * A browser will not start an AudioContext until the person has touched the
 * page, so nothing is created until the first gesture and every call is a
 * no-op before that.
 */

const MASTER = 0.5;
const SPEED_OF_SOUND = 343; // blocks per second, a block being a metre
const VARIANTS = 4;

/* ------------------------------------------------------------------ DSP --- */

/** Small seeded generator, so the rendered variants are stable per load. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** One RBJ cookbook biquad, run over a buffer in place. */
function biquad(
  x: Float32Array, sr: number,
  type: "lowpass" | "highpass" | "bandpass" | "peak" | "lowshelf",
  freq: number, q = 0.707, gainDb = 0,
): void {
  const w = (2 * Math.PI * Math.min(freq, sr * 0.45)) / sr;
  const cos = Math.cos(w);
  const sin = Math.sin(w);
  const alpha = sin / (2 * q);
  const A = Math.pow(10, gainDb / 40);
  let b0 = 0, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
  switch (type) {
    case "lowpass":
      b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case "highpass":
      b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case "bandpass":
      b0 = alpha; b1 = 0; b2 = -alpha;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case "peak":
      b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
      break;
    case "lowshelf": {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cos + s);
      b1 = 2 * A * ((A - 1) - (A + 1) * cos);
      b2 = A * ((A + 1) - (A - 1) * cos - s);
      a0 = (A + 1) + (A - 1) * cos + s;
      a1 = -2 * ((A - 1) + (A + 1) * cos);
      a2 = (A + 1) + (A - 1) * cos - s;
      break;
    }
  }
  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
    x[i] = yi;
  }
}

/** Soft clip: what a microphone and preamp do to a gunshot. */
function saturate(x: Float32Array, drive: number): void {
  const norm = Math.tanh(drive);
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * drive) / norm;
}

function normalise(x: Float32Array, peak = 0.95): void {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / m;
}

/** Short fades at both ends, so a buffer never starts or stops with a click. */
function fadeEdges(x: Float32Array, sr: number, ms = 2): void {
  const n = Math.min(x.length >> 1, Math.floor((sr * ms) / 1000));
  for (let i = 0; i < n; i++) x[x.length - 1 - i] *= i / n;
}

/* --------------------------------------------------------------- models --- */

interface GunModel {
  /** Seconds rendered, including the gun's own ring but not the room. */
  length: number;
  /** Fast and slow decay of the blast, seconds. */
  fast: number;
  slow: number;
  /** Level of the slow decay against the fast one. */
  slowLevel: number;
  /** The barrel and receiver resonance, Hz, and how long it rings. */
  bodyHz: number;
  bodyDecay: number;
  bodyLevel: number;
  /** A sub thump with a falling pitch, Hz from and to. */
  thumpFrom: number;
  thumpTo: number;
  thumpDecay: number;
  thumpLevel: number;
  /** Brightness of the blast: lowpass on the noise, and a presence peak. */
  lowpass: number;
  presenceHz: number;
  presenceDb: number;
  /** Height of the initial transient against the blast. */
  crack: number;
  /** Saturation. */
  drive: number;
}

export const GUNS: Record<number, GunModel> = {
  // A carbine indoors: a hard, bright, fast crack with a short body.
  [W_RIFLE]: {
    length: 0.42, fast: 0.009, slow: 0.07, slowLevel: 0.32,
    bodyHz: 210, bodyDecay: 0.05, bodyLevel: 0.5,
    thumpFrom: 130, thumpTo: 55, thumpDecay: 0.06, thumpLevel: 0.55,
    lowpass: 9000, presenceHz: 2600, presenceDb: 5, crack: 1.4, drive: 3.2,
  },
  // A handgun: tighter and punchier, more mid, less low end.
  [W_PISTOL]: {
    length: 0.36, fast: 0.007, slow: 0.05, slowLevel: 0.28,
    bodyHz: 340, bodyDecay: 0.035, bodyLevel: 0.55,
    thumpFrom: 160, thumpTo: 70, thumpDecay: 0.045, thumpLevel: 0.45,
    lowpass: 8000, presenceHz: 1800, presenceDb: 6, crack: 1.6, drive: 3.6,
  },
  // A twelve bore: a long, heavy boom, darker, with a lot of low body.
  [W_SHOTGUN]: {
    length: 0.75, fast: 0.016, slow: 0.16, slowLevel: 0.45,
    bodyHz: 120, bodyDecay: 0.12, bodyLevel: 0.75,
    thumpFrom: 95, thumpTo: 38, thumpDecay: 0.14, thumpLevel: 0.9,
    lowpass: 5200, presenceHz: 900, presenceDb: 4, crack: 1.1, drive: 2.6,
  },
};

/** Render one variant of one gun's dry shot. */
export function renderShot(m: GunModel, sr: number, seed: number): Float32Array {
  const r = rng(seed);
  const j = (v: number, amt = 0.06) => v * (1 + (r() - 0.5) * 2 * amt);
  const n = Math.floor(m.length * sr);
  const out = new Float32Array(n);

  // The blast: noise under a near instant attack and two decays.
  const fast = j(m.fast);
  const slow = j(m.slow);
  const attack = 0.0004 * sr;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = (i < attack ? i / attack : 1) * (Math.exp(-t / fast) + m.slowLevel * Math.exp(-t / slow));
    out[i] = (r() * 2 - 1) * env;
  }
  biquad(out, sr, "highpass", 60, 0.7);
  biquad(out, sr, "lowpass", j(m.lowpass), 0.6);
  biquad(out, sr, "peak", j(m.presenceHz), 0.9, m.presenceDb);
  biquad(out, sr, "lowshelf", 250, 0.7, 4);

  // The barrel and receiver ringing, and the sub thump of the pressure wave.
  const bodyHz = j(m.bodyHz);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[i] += m.bodyLevel * Math.sin(2 * Math.PI * bodyHz * t) * Math.exp(-t / m.bodyDecay) *
      (0.6 + 0.4 * (r() * 2 - 1));
  }
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = m.thumpTo + (m.thumpFrom - m.thumpTo) * Math.exp(-t / (m.thumpDecay * 0.5));
    phase += (2 * Math.PI * f) / sr;
    out[i] += m.thumpLevel * Math.sin(phase) * Math.exp(-t / m.thumpDecay);
  }

  // The leading edge: a very short asymmetric spike, the first thing the ear
  // hears and the thing that makes a gunshot a gunshot rather than a thud.
  const crackN = Math.floor(0.0012 * sr);
  for (let i = 0; i < crackN && i < n; i++) {
    const p = i / crackN;
    out[i] += m.crack * (p < 0.35 ? p / 0.35 : -(p - 0.35) / 0.65 * 0.6 + (1 - p) * 0.2);
  }

  saturate(out, m.drive);
  normalise(out);
  fadeEdges(out, sr);
  return out;
}

/** Brass on boards: a few inharmonic partials, bouncing two or three times. */
export function renderCasing(sr: number, seed: number, plastic: boolean): Float32Array {
  const r = rng(seed);
  const n = Math.floor(0.6 * sr);
  const out = new Float32Array(n);
  const partials = plastic
    ? [1100, 1730, 2650].map((f) => f * (0.9 + r() * 0.2))
    : [4100, 6700, 9300, 11800].map((f) => f * (0.92 + r() * 0.16));
  let at = 0;
  let level = 1;
  for (let b = 0; b < (plastic ? 2 : 3); b++) {
    const start = Math.floor(at * sr);
    const decay = plastic ? 0.012 : 0.05 * level + 0.015;
    for (let i = start; i < n; i++) {
      const t = (i - start) / sr;
      if (t > decay * 7) break;
      let v = 0;
      partials.forEach((f, k) => { v += Math.sin(2 * Math.PI * f * t + k) / (k + 1); });
      out[i] += level * v * Math.exp(-t / decay);
    }
    at += 0.07 + r() * 0.06;
    level *= 0.45;
  }
  normalise(out, 0.8);
  fadeEdges(out, sr);
  return out;
}

/**
 * A mechanical click or clack: filtered noise with a sharp attack, plus a
 * metallic ping. Bolts, slides, magazine catches, pumps and triggers.
 */
export function renderClick(
  sr: number, seed: number, ms: number, freq: number, q: number, ping: number,
): Float32Array {
  const r = rng(seed);
  const n = Math.floor((ms / 1000 + 0.04) * sr);
  const out = new Float32Array(n);
  const tau = ms / 1000 / 4;
  for (let i = 0; i < n; i++) out[i] = (r() * 2 - 1) * Math.exp(-(i / sr) / tau);
  biquad(out, sr, "bandpass", freq, q);
  biquad(out, sr, "highpass", 300, 0.7);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[i] += 0.3 * Math.sin(2 * Math.PI * ping * t) * Math.exp(-t / (tau * 2));
  }
  normalise(out, 0.9);
  fadeEdges(out, sr);
  return out;
}

/** A magazine sliding out of or into a well: a short swept noise. */
function renderSlide(sr: number, seed: number, ms: number, from: number, to: number): Float32Array {
  const r = rng(seed);
  const n = Math.floor((ms / 1000) * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i / n;
    out[i] = (r() * 2 - 1) * Math.sin(Math.PI * p) * 0.6;
  }
  // Two passes at the start and end frequency approximate the sweep.
  biquad(out, sr, "bandpass", (from + to) / 2, 1.2);
  normalise(out, 0.6);
  fadeEdges(out, sr, 5);
  return out;
}

/**
 * The hall's impulse response. Stereo, so the room is wide around the
 * player. Pre-delay, early reflections off the nearest walls and booths, and
 * a diffuse tail whose bright part dies faster than its dark part, which is
 * how a hard room with a lot of air in it sounds.
 */
export function hallImpulse(sr: number): [Float32Array, Float32Array] {
  const seconds = 2.2;
  const n = Math.floor(seconds * sr);
  const chans: [Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n)];
  for (let ch = 0; ch < 2; ch++) {
    const r = rng(0xa11 + ch * 7919);
    const bright = new Float32Array(n);
    const dark = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      bright[i] = (r() * 2 - 1) * Math.exp(-t * 6.9 / 0.7);
      dark[i] = (r() * 2 - 1) * Math.exp(-t * 6.9 / 1.9);
    }
    biquad(dark, sr, "lowpass", 1400, 0.6);
    biquad(bright, sr, "lowpass", 7000, 0.6);
    const data = chans[ch];
    const pre = Math.floor(0.008 * sr);
    for (let i = 0; i < n - pre; i++) {
      const t = i / sr;
      // The tail swells in over the first eighty milliseconds, under the
      // early reflections, rather than arriving all at once.
      const swell = Math.min(1, t / 0.08);
      data[i + pre] = swell * (0.35 * bright[i] + 0.9 * dark[i]);
    }
    // Early reflections: discrete, a little different in each ear.
    for (let k = 0; k < 10; k++) {
      const at = Math.floor((0.009 + k * 0.007 + r() * 0.012) * sr);
      if (at < n) data[at] += (r() < 0.5 ? -1 : 1) * 0.55 * Math.pow(0.82, k);
    }
  }
  return chans;
}

function renderHall(ctx: BaseAudioContext): AudioBuffer {
  const [l, r] = hallImpulse(ctx.sampleRate);
  const ir = ctx.createBuffer(2, l.length, ctx.sampleRate);
  ir.getChannelData(0).set(l);
  ir.getChannelData(1).set(r);
  return ir;
}

/* ---------------------------------------------------------------- Sfx --- */

interface Bank {
  shots: Record<number, AudioBuffer[]>;
  casings: AudioBuffer[];
  hulls: AudioBuffer[];
  bolt: AudioBuffer[];
  slide: AudioBuffer[];
  pump: AudioBuffer[];
  trigger: AudioBuffer;
  magRelease: AudioBuffer;
  magOut: AudioBuffer;
  magIn: AudioBuffer;
  charge: AudioBuffer;
  shell: AudioBuffer[];
}

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Everything that happens in the hall goes through the room. */
  private dry: GainNode | null = null;
  private wet: GainNode | null = null;
  /** HUD sounds (hit markers, chimes) stay dry and out of the room. */
  private ui: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private bank: Bank | null = null;
  private muted = false;

  /** Call from a click or touch handler. Safe to call repeatedly. */
  start(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor({ latencyHint: "interactive" });

    // A compressor on the master, the way a game mix glues an automatic
    // burst together without the peaks clipping the phone's speaker.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 8;
    comp.ratio.value = 4;
    comp.attack.value = 0.002;
    comp.release.value = 0.22;
    const master = ctx.createGain();
    master.gain.value = MASTER;
    comp.connect(master).connect(ctx.destination);

    const dry = ctx.createGain();
    dry.connect(comp);
    const reverb = ctx.createConvolver();
    reverb.buffer = renderHall(ctx);
    const wet = ctx.createGain();
    wet.gain.value = 1;
    wet.connect(reverb).connect(comp);
    const ui = ctx.createGain();
    ui.gain.value = 0.8;
    ui.connect(comp);

    // One second of white noise for the HUD sounds.
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    this.ctx = ctx;
    this.master = master;
    this.dry = dry;
    this.wet = wet;
    this.ui = ui;
    this.noise = buf;
    this.bank = this.render(ctx);
  }

  /** Render every buffer once. A few tens of milliseconds on a phone. */
  private render(ctx: AudioContext): Bank {
    const sr = ctx.sampleRate;
    const mk = (x: Float32Array) => {
      const b = ctx.createBuffer(1, x.length, sr);
      b.getChannelData(0).set(x);
      return b;
    };
    const variants = (f: (seed: number) => Float32Array) =>
      Array.from({ length: VARIANTS }, (_, i) => mk(f(i * 104729 + 17)));
    const shots: Record<number, AudioBuffer[]> = {};
    for (const w of [W_RIFLE, W_PISTOL, W_SHOTGUN]) {
      shots[w] = variants((s) => renderShot(GUNS[w], sr, s + w * 31));
    }
    return {
      shots,
      casings: variants((s) => renderCasing(sr, s, false)),
      hulls: variants((s) => renderCasing(sr, s + 5, true)),
      bolt: variants((s) => renderClick(sr, s + 1, 18, 2800, 1.3, 3400)),
      slide: variants((s) => renderClick(sr, s + 2, 22, 2200, 1.1, 2600)),
      pump: variants((s) => renderClick(sr, s + 3, 40, 1300, 0.9, 1800)),
      trigger: mk(renderClick(sr, 9, 10, 3600, 1.8, 4800)),
      magRelease: mk(renderClick(sr, 10, 14, 3000, 1.5, 4100)),
      magOut: mk(renderSlide(sr, 11, 120, 900, 500)),
      magIn: mk(renderClick(sr, 12, 30, 1600, 1.0, 2200)),
      charge: mk(renderClick(sr, 13, 45, 1900, 0.9, 2500)),
      shell: variants((s) => renderClick(sr, s + 14, 28, 1100, 1.0, 1500)),
    };
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : MASTER;
  }

  get ready(): boolean {
    return this.ctx !== null && !this.muted && this.bank !== null;
  }

  /* --------------------------------------------------------- playback --- */

  /**
   * Play a buffer in the hall. `send` is how much of it goes into the room,
   * `delay` is seconds from now, `pan` is -1 left to 1 right, and `cutoff`
   * is a lowpass for distance.
   */
  private play(
    buf: AudioBuffer, gain: number,
    opts: { delay?: number; pan?: number; cutoff?: number; send?: number; rate?: number } = {},
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.dry || !this.wet) return;
    const t = ctx.currentTime + (opts.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = opts.rate ?? 0.97 + Math.random() * 0.06;
    let node: AudioNode = src;
    if (opts.cutoff !== undefined && opts.cutoff < 18000) {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = opts.cutoff;
      lp.Q.value = 0.5;
      node = node.connect(lp);
    }
    const g = ctx.createGain();
    g.gain.value = gain;
    node = node.connect(g);
    if (opts.pan !== undefined && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, opts.pan));
      node = node.connect(p);
    }
    node.connect(this.dry);
    const send = opts.send ?? 0.3;
    if (send > 0) {
      const s = ctx.createGain();
      s.gain.value = send;
      node.connect(s).connect(this.wet);
    }
    src.start(t);
  }

  private pick(list: AudioBuffer[]): AudioBuffer {
    return list[Math.floor(Math.random() * list.length)];
  }

  /**
   * One shot. `distance` in blocks, 0 for our own. `pan` from -1 (left) to
   * 1 (right) relative to where the camera faces, for other people's.
   */
  shot(weapon: number, distance = 0, pan?: number): void {
    if (!this.ready) return;
    const b = this.bank!;
    const buf = this.pick(b.shots[weapon] ?? b.shots[W_RIFLE]);
    const own = distance <= 0.01;

    if (own) {
      // Right on top of us: full level, a little room, then the mechanism.
      this.play(buf, weapon === W_SHOTGUN ? 1.0 : weapon === W_PISTOL ? 0.9 : 0.8, { send: 0.35 });
      if (weapon === W_SHOTGUN) {
        // Rack the pump, and the empty hull drops.
        this.play(this.pick(b.pump), 0.35, { delay: 0.32, send: 0.15 });
        this.play(this.pick(b.pump), 0.3, { delay: 0.45, send: 0.15, rate: 1.15 });
        this.play(this.pick(b.hulls), 0.22, { delay: 0.62, send: 0.2 });
      } else {
        this.play(this.pick(weapon === W_PISTOL ? b.slide : b.bolt), 0.22, { delay: 0.012, send: 0.1 });
        this.play(this.pick(b.casings), 0.13, { delay: 0.32 + Math.random() * 0.2, send: 0.25 });
      }
      return;
    }

    // Someone else. The direct sound arrives after the time it takes to
    // cross the hall, quieter with distance and duller the further it came,
    // while the room's share stays roughly the same: far away, the hall is
    // most of what you hear.
    const delay = distance / SPEED_OF_SOUND;
    const direct = 0.85 / (1 + distance / 7);
    const cutoff = Math.max(1800, 16000 - distance * 380);
    this.play(buf, direct, { delay, pan, cutoff, send: 0.5 / Math.max(direct, 0.15) * 0.25 });
  }

  /** Trigger pulled on an empty magazine. */
  dryFire(): void {
    if (!this.ready) return;
    this.play(this.bank!.trigger, 0.5, { send: 0.08 });
  }

  /**
   * A reload over `ms`, for the weapon in hand. Timed against the reload
   * the server is running, so the last sound lands as the magazine fills.
   */
  reload(ms: number, weapon: number = W_RIFLE): void {
    if (!this.ready) return;
    const b = this.bank!;
    const s = ms / 1000;
    if (weapon === W_SHOTGUN) {
      // Shells one at a time, then the pump.
      const shells = 4;
      for (let i = 0; i < shells; i++) {
        this.play(this.pick(b.shell), 0.35, { delay: 0.25 + (i * (s - 0.7)) / shells, send: 0.12 });
      }
      this.play(this.pick(b.pump), 0.4, { delay: s - 0.32, send: 0.15 });
      this.play(this.pick(b.pump), 0.35, { delay: s - 0.18, send: 0.15, rate: 1.15 });
      return;
    }
    this.play(b.magRelease, 0.35, { delay: 0.05, send: 0.1 });
    this.play(b.magOut, 0.3, { delay: 0.12, send: 0.1 });
    this.play(b.magIn, 0.45, { delay: Math.max(0.3, s * 0.6), send: 0.12 });
    this.play(weapon === W_PISTOL ? this.pick(b.slide) : b.charge, 0.45,
      { delay: Math.max(0.45, s - 0.2), send: 0.15 });
  }

  /* ------------------------------------------------------- HUD sounds --- */

  /** A burst of filtered noise, dry. */
  private burst(
    gain: number, ms: number, type: BiquadFilterType, freq: number, q = 1, delay = 0,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise || !this.ui) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    src.connect(filter).connect(g).connect(this.ui);
    src.start(t, Math.random() * 0.8, ms / 1000 + 0.02);
    src.stop(t + ms / 1000 + 0.02);
  }

  /** A pitched tone, optionally sliding, dry. */
  private tone(
    gain: number, ms: number, from: number, to: number,
    type: OscillatorType = "sine", delay = 0,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.ui) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, t + ms / 1000);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    osc.connect(g).connect(this.ui);
    osc.start(t);
    osc.stop(t + ms / 1000 + 0.02);
  }

  /** Our shot connected. Higher and double tapped for a head shot. */
  hit(head: boolean): void {
    if (!this.ready) return;
    this.tone(0.3, 45, head ? 1900 : 1250, head ? 1500 : 1000, "square");
    if (head) this.tone(0.22, 60, 2500, 1900, "square", 0.045);
  }

  /** Our shot killed someone. */
  kill(): void {
    if (!this.ready) return;
    this.tone(0.3, 110, 880, 880, "triangle");
    this.tone(0.3, 160, 1320, 1320, "triangle", 0.09);
  }

  /** We died. */
  death(): void {
    if (!this.ready) return;
    this.tone(0.45, 420, 240, 55, "sawtooth");
    this.burst(0.5, 300, "lowpass", 700, 0.8);
  }

  respawn(): void {
    if (!this.ready) return;
    this.tone(0.28, 220, 420, 880, "sine");
  }

  /** Weapon in hand changed. */
  swap(): void {
    if (!this.ready) return;
    this.play(this.pick(this.bank!.slide), 0.3, { send: 0.1, rate: 0.9 });
    this.play(this.bank!.charge, 0.25, { delay: 0.12, send: 0.1 });
  }

  /** We were hit. */
  hurt(): void {
    if (!this.ready) return;
    this.tone(0.3, 140, 180, 90, "sawtooth");
    this.burst(0.25, 60, "lowpass", 400, 0.7);
  }
}
