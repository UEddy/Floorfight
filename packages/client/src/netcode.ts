/**
 * Prediction, reconciliation and interpolation. No DOM and no Three.js, so it
 * can be driven headless.
 *
 * Nothing in here decides an outcome. Prediction only moves the local camera
 * ahead of the server so input feels immediate. The server's snapshot always
 * wins, and hits come only from the server's hit events.
 */

import {
  PITCH_LIMIT,
  TICK_MS,
  YAW_UNITS,
  createWorld,
  step,
  type HitEvent,
  type Input,
  type WorldState,
} from "../../shared/sim";
import type { SnapshotPlayer } from "../../shared/protocol";

/** Remote players are drawn this far behind the newest server state. 100 ms. */
export const INTERP_TICKS = 6;

/** Inputs resent in every batch, so a single lost packet costs nothing. */
export const BATCH_TICKS = 3;

/* ---------------------------------------------------------- prediction --- */

export class Predictor {
  readonly world: WorldState;
  private pending: Input[] = [];
  private lastAck = -1;
  private scratch: HitEvent[] = [];

  /** Position at the previous and current local tick, for render smoothing. */
  prevX = 0;
  prevZ = 0;

  /** Visual offset left over from a correction, decayed over a few frames. */
  errX = 0;
  errZ = 0;

  constructor(slots: number, readonly slot: number) {
    // A world with every other player removed. step() only moves the local
    // player, and nothing in the predicted world can be shot, so prediction
    // can never show a hit the server did not make.
    this.world = createWorld(slots);
    for (let i = 0; i < slots; i++) {
      const p = this.world.players[i];
      if (i !== slot) p.alive = false;
      p.respawnAt = Number.POSITIVE_INFINITY;
    }
    const me = this.me;
    this.prevX = me.x;
    this.prevZ = me.z;
  }

  get me() {
    return this.world.players[this.slot];
  }

  /** Apply one freshly sampled local input and keep it until acknowledged. */
  apply(inp: Input): void {
    this.pending.push(inp);
    this.prevX = this.me.x;
    this.prevZ = this.me.z;
    this.stepOne(inp);
  }

  /**
   * Rewind to the authoritative state and replay everything the server has
   * not consumed yet. `ack` is the last input tick the server applied, so the
   * snapshot already includes it and everything before it.
   */
  reconcile(ack: number, me: SnapshotPlayer): void {
    if (ack < this.lastAck) return;
    this.lastAck = ack;
    this.pending = this.pending.filter((i) => i.tick > ack);

    const p = this.me;
    const beforeX = p.x + this.errX;
    const beforeZ = p.z + this.errZ;

    p.x = me.x;
    p.z = me.z;
    p.hp = me.h;
    p.kills = me.k;
    p.deaths = me.d;
    p.alive = me.a === 1;
    // Respawn is the server's call. Locally a dead player stays dead until a
    // snapshot says otherwise.
    p.respawnAt = Number.POSITIVE_INFINITY;

    if (p.alive) {
      for (const inp of this.pending) this.stepOne(inp);
    }

    // Small corrections are blended out over a few frames so the camera does
    // not twitch. Large ones (respawn, a long stall) are taken at once.
    const dx = beforeX - p.x;
    const dz = beforeZ - p.z;
    if (dx * dx + dz * dz < 4) {
      this.errX = dx;
      this.errZ = dz;
    } else {
      this.errX = 0;
      this.errZ = 0;
      this.prevX = p.x;
      this.prevZ = p.z;
    }
  }

  decayError(dtSeconds: number): void {
    const k = Math.exp(-dtSeconds * 12);
    this.errX *= k;
    this.errZ *= k;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  private stepOne(inp: Input): void {
    if (!this.me.alive) return;
    const inputs: (Input | null)[] = new Array(this.world.players.length).fill(null);
    // Fire is stripped: shooting is resolved by the server only.
    inputs[this.slot] = { ...inp, fire: 0 };
    this.scratch.length = 0;
    step(this.world, inputs, this.scratch);
  }
}

/* ------------------------------------------------------- interpolation --- */

interface Snap {
  tick: number;
  players: SnapshotPlayer[];
}

export interface RemoteView {
  x: number;
  z: number;
  yaw: number;   // units, may be fractional
  pitch: number; // radians
  alive: boolean;
}

export class Interpolator {
  private snaps: Snap[] = [];
  /** Estimated (server tick) minus (local ms / TICK_MS). */
  private offset: number | null = null;

  push(tick: number, players: SnapshotPlayer[], nowMs: number): void {
    const last = this.snaps[this.snaps.length - 1];
    if (last && tick <= last.tick) return;
    this.snaps.push({ tick, players });
    if (this.snaps.length > 64) this.snaps.shift();

    // Track the server clock from snapshot arrivals. Jitter is smoothed out,
    // a large jump (tab was hidden, long stall) resets it.
    const sample = tick - nowMs / TICK_MS;
    if (this.offset === null || Math.abs(sample - this.offset) > 10) this.offset = sample;
    else this.offset += (sample - this.offset) * 0.05;
  }

  get ready(): boolean {
    return this.offset !== null && this.snaps.length > 0;
  }

  /** Current server tick, estimated. */
  serverTick(nowMs: number): number {
    return nowMs / TICK_MS + (this.offset ?? 0);
  }

  /** The snapshot tick being drawn for remote players right now. */
  renderTick(nowMs: number): number {
    return this.serverTick(nowMs) - INTERP_TICKS;
  }

  /**
   * The value to put in Input.view when firing.
   *
   * A snapshot stamped S is sent after step() has advanced world.tick to S,
   * so the positions in it are the history frame recorded for tick S - 1.
   * The rewind target is therefore the rendered snapshot tick minus one.
   * The server clamps whatever we send to its 250 ms rewind limit.
   */
  viewTick(nowMs: number): number {
    return Math.round(this.renderTick(nowMs)) - 1;
  }

  sample(nowMs: number, out: Map<number, RemoteView>): void {
    out.clear();
    if (this.snaps.length === 0) return;
    const rt = this.renderTick(nowMs);

    let a = this.snaps[0];
    let b = a;
    for (let i = 0; i < this.snaps.length; i++) {
      const s = this.snaps[i];
      if (s.tick <= rt) a = s;
      if (s.tick >= rt) { b = s; break; }
      b = s;
    }
    const span = b.tick - a.tick;
    let f = span > 0 ? (rt - a.tick) / span : 0;
    f = f < 0 ? 0 : f > 1 ? 1 : f;

    for (const pb of b.players) {
      const pa = a.players.find((p) => p.s === pb.s) ?? pb;
      // Across a death or respawn, do not slide from the corpse to the spawn.
      const jump = pa.a !== pb.a;
      const t = jump ? (f < 0.5 ? 0 : 1) : f;
      out.set(pb.s, {
        x: pa.x + (pb.x - pa.x) * t,
        z: pa.z + (pb.z - pa.z) * t,
        yaw: lerpYaw(pa.y, pb.y, t),
        pitch: ((pa.p + (pb.p - pa.p) * t) / 32767) * PITCH_LIMIT,
        alive: (t < 0.5 ? pa.a : pb.a) === 1,
      });
    }
  }
}

function lerpYaw(a: number, b: number, t: number): number {
  let d = b - a;
  if (d > YAW_UNITS / 2) d -= YAW_UNITS;
  if (d < -YAW_UNITS / 2) d += YAW_UNITS;
  return a + d * t;
}
