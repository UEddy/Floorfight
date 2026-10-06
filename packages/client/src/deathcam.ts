import { EYE_HEIGHT, rayGrid } from "../../shared/sim";

/**
 * The camera after we die, for the three seconds before the respawn.
 *
 * It lifts out of the body and backs away from whoever did it, then holds
 * them in frame, so the player sees who it was, where they were standing
 * and what they did next. Drawing only: nothing here is sent anywhere or
 * read by the sim. The pull back is cast against the block grid with the
 * same ray the shots use, so the camera never ends up inside a wall.
 */

/** Seconds the lift and pull back take. */
const PULL_S = 0.9;
/** How far up and back the camera goes, in blocks. */
const RISE = 2.4;
const BACK = 3.2;
/** How high it goes instead when the killer is out of sight from there. */
const RISE_HIGH = 5;

export interface Pose { x: number; y: number; z: number; yaw: number; pitch: number }

export class DeathCam {
  private from: Pose | null = null;
  private startedAt = 0;
  private yaw = 0;
  private pitch = 0;
  killer = -1;
  private rise = RISE;

  get active(): boolean {
    return this.from !== null;
  }

  /** We died at this pose (feet position, our last view), to this slot. */
  start(at: Pose, killer: number, nowMs: number): void {
    this.from = { ...at };
    this.startedAt = nowMs;
    this.killer = killer;
    this.yaw = at.yaw;
    this.pitch = at.pitch;
    this.rise = RISE;
  }

  private sees(x: number, y: number, z: number, t: { x: number; y: number; z: number }): boolean {
    const dx = t.x - x;
    const dy = t.y + 1.2 - y;
    const dz = t.z - z;
    const d = Math.hypot(dx, dy, dz);
    return d < 0.01 || rayGrid(x, y, z, dx / d, dy / d, dz / d, d) >= d;
  }

  stop(): void {
    this.from = null;
    this.killer = -1;
  }

  /**
   * Where to draw from this frame. `target` is the killer as drawn now, or
   * null when they are not on screen to look at (a suicide, a disconnect).
   */
  pose(nowMs: number, dt: number, target: { x: number; y: number; z: number } | null): Pose | null {
    const f = this.from;
    if (!f) return null;
    const t = Math.min(1, (nowMs - this.startedAt) / 1000 / PULL_S);
    const ease = 1 - (1 - t) ** 3;

    // Back away from the killer, or from where we were looking.
    let bx: number;
    let bz: number;
    if (target) {
      const dx = f.x - target.x;
      const dz = f.z - target.z;
      const d = Math.hypot(dx, dz) || 1;
      bx = dx / d;
      bz = dz / d;
    } else {
      bx = Math.sin(f.yaw);
      bz = Math.cos(f.yaw);
    }
    const ox = f.x;
    const oy = f.y + EYE_HEIGHT;
    const oz = f.z;
    // If the killer is behind something from the usual spot, go higher, so
    // the camera looks over the engine or the stall they shot from behind.
    const rise = target && !this.sees(ox + bx * BACK, oy + RISE, oz + bz * BACK, target) ? RISE_HIGH : RISE;
    this.rise += (rise - this.rise) * Math.min(1, dt * 3);
    const wx = bx * BACK;
    const wy = this.rise;
    const wz = bz * BACK;
    const want = Math.hypot(wx, wy, wz);
    const clear = rayGrid(ox, oy, oz, wx / want, wy / want, wz / want, want);
    const reach = Math.max(0, Math.min(want, clear - 0.35)) / want * ease;
    const x = ox + wx * reach;
    const eyeY = oy + wy * reach;
    const z = oz + wz * reach;

    // Turn to the killer, smoothly: a camera that snapped round would lose
    // the player more than it showed them anything.
    let wantYaw = this.yaw;
    let wantPitch = -0.35;
    if (target) {
      const lx = target.x - x;
      const ly = target.y + 1.2 - eyeY;
      const lz = target.z - z;
      wantYaw = Math.atan2(-lx, -lz);
      wantPitch = Math.atan2(ly, Math.hypot(lx, lz));
    }
    let dy = wantYaw - this.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    const k = Math.min(1, dt * 5);
    this.yaw += dy * k;
    this.pitch += (wantPitch - this.pitch) * k;

    // The renderer adds the eye height back on.
    return { x, y: eyeY - EYE_HEIGHT, z, yaw: this.yaw, pitch: this.pitch };
  }
}
