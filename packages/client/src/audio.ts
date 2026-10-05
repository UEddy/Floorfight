import { W_PISTOL, W_SHOTGUN } from "../../shared/weapons";

/**
 * All the sound in the game, synthesized.
 *
 * No sample files: everything here is oscillators, one noise buffer and gain
 * envelopes. That is partly taste, and partly the two constraints the project
 * actually has. The APK has to stay small enough to be worth downloading over
 * a phone connection, and every asset in it has to be ours, which a library
 * of gunshot recordings would not be.
 *
 * A browser will not start an AudioContext until the person has touched the
 * page, so nothing is created until the first gesture and every call is a
 * no-op before that.
 */

const MASTER = 0.35;

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
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
    const ctx = new Ctor();
    const master = ctx.createGain();
    master.gain.value = MASTER;
    master.connect(ctx.destination);

    // One second of white noise, reused by every percussive sound. Generated
    // rather than loaded, so it costs nothing in the bundle.
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    this.ctx = ctx;
    this.master = master;
    this.noise = buf;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : MASTER;
  }

  get ready(): boolean {
    return this.ctx !== null && !this.muted;
  }

  /* --------------------------------------------------------- primitives --- */

  /** A burst of filtered noise: the body of every gunshot and click. */
  private burst(
    gain: number, ms: number, type: BiquadFilterType, freq: number, q = 1, delay = 0,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise || !this.master) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 1;
    // Start somewhere random in the buffer so repeated shots are not
    // bit-identical, which is what makes an automatic weapon sound mechanical
    // rather than looped.
    const off = Math.random() * 0.8;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t, off, ms / 1000 + 0.02);
    src.stop(t + ms / 1000 + 0.02);
  }

  /** A pitched tone, optionally sliding. The thump under a shot, and chimes. */
  private tone(
    gain: number, ms: number, from: number, to: number,
    type: OscillatorType = "sine", delay = 0,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, t + ms / 1000);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + ms / 1000 + 0.02);
  }

  /* ------------------------------------------------------------- sounds --- */

  /**
   * One shot. Each weapon gets its own shape: the rifle is a short bright
   * crack, the pistol is tighter and louder, the shotgun is a broad low boom
   * with a tail.
   */
  shot(weapon: number, distance = 0): void {
    if (!this.ready) return;
    // Someone else's shot across the hall is quieter and duller. Rolled off
    // by hand rather than with a panner, which would need a listener pose
    // kept in sync every frame for very little gain.
    const near = Math.max(0.12, 1 - distance / 45);
    if (weapon === W_SHOTGUN) {
      this.burst(0.9 * near, 220, "lowpass", 1100, 0.8);
      this.tone(0.5 * near, 180, 70, 42, "sine");
      this.burst(0.25 * near, 320, "bandpass", 500, 0.6, 0.02);
    } else if (weapon === W_PISTOL) {
      this.burst(0.85 * near, 90, "bandpass", 1500, 1.1);
      this.tone(0.4 * near, 90, 110, 55, "triangle");
    } else {
      this.burst(0.6 * near, 70, "bandpass", 2100, 1.4);
      this.tone(0.25 * near, 60, 150, 70, "square");
    }
  }

  /** Trigger pulled on an empty magazine. */
  dryFire(): void {
    if (!this.ready) return;
    this.burst(0.3, 25, "highpass", 2600, 0.7);
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

  /** Magazine out, and magazine in a moment later. */
  reload(ms: number): void {
    if (!this.ready) return;
    this.burst(0.35, 40, "highpass", 1800, 0.9);
    this.burst(0.3, 30, "highpass", 1200, 0.9, Math.max(0.08, ms / 1000 - 0.12));
    this.tone(0.2, 60, 320, 200, "square", Math.max(0.1, ms / 1000 - 0.08));
  }

  /** Weapon in hand changed. */
  swap(): void {
    if (!this.ready) return;
    this.burst(0.25, 50, "bandpass", 900, 1.2);
    this.tone(0.16, 70, 520, 760, "square", 0.03);
  }

  /** Someone was hit and we were the one hit. */
  hurt(): void {
    if (!this.ready) return;
    this.tone(0.3, 140, 180, 90, "sawtooth");
  }
}
