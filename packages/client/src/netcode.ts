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
  prevY = 0;
  prevZ = 0;

  /** Visual offset left over from a correction, decayed over a few frames. */
  errX = 0;
  errY = 0;
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
    this.prevY = me.y;
    this.prevZ = me.z;
  }

  get me() {
    return this.world.players[this.slot];
  }

  /** Apply one freshly sampled local input and keep it until acknowledged. */
  apply(inp: Input): void {
    this.pending.push(inp);
    this.prevX = this.me.x;
    this.prevY = this.me.y;
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
    const beforeY = p.y + this.errY;
    const beforeZ = p.z + this.errZ;

    p.x = me.x;
    p.y = me.e;
    p.z = me.z;
    // Vertical velocity has to come from the server too, or a correction in
    // mid-jump would restart the arc from rest. See SnapshotPlayer.w.
    p.vy = me.w;
    p.hp = me.h;
    // Weapon state is the server's too. Prediction strips the fire bit, so
    // without this the predicted magazine would never go down and the two
    // would drift apart within a second of holding the trigger.
    p.weapon = me.g;
    p.ammo[me.g] = me.m;
    p.reloadUntil = me.r > 0 ? this.world.tick + me.r : 0;
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
    const dy = beforeY - p.y;
    const dz = beforeZ - p.z;
    if (dx * dx + dy * dy + dz * dz < 4) {
      this.errX = dx;
      this.errY = dy;
      this.errZ = dz;
    } else {
      this.errX = 0;
      this.errY = 0;
      this.errZ = 0;
      this.prevX = p.x;
      this.prevY = p.y;
      this.prevZ = p.z;
    }
  }

  decayError(dtSeconds: number): void {
    const k = Math.exp(-dtSeconds * 12);
    this.errX *= k;
    this.errY *= k;
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
  y: number; // feet height
  z: number;
  yaw: number;   // units, may be fractional
  pitch: number; // radians
  alive: boolean;
  /** Weapon held, an index into WEAPONS. Drawn in their hands, nothing more. */
  weapon: number;
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
        y: pa.e + (pb.e - pa.e) * t,
        z: pa.z + (pb.z - pa.z) * t,
        yaw: lerpYaw(pa.y, pb.y, t),
        pitch: ((pa.p + (pb.p - pa.p) * t) / 32767) * PITCH_LIMIT,
        alive: (t < 0.5 ? pa.a : pb.a) === 1,
        weapon: pb.g,
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
