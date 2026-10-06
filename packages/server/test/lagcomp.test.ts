// Hit registration under latency.
//
// Runs the real sim with a shooter whose inputs arrive the way a phone's do:
// aimed perfectly at where the client drew the target, carrying the view
// tick the client would send, and applied one round trip plus the client's
// interpolation delay and the server's input buffer later. The target
// strafes back and forth at full speed. The hit rate that comes out is what
// lag compensation gives a player who aims perfectly on a connection of
// that round trip, and the test reports it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EYE_HEIGHT,
  LEVEL_GROUND,
  MAX_REWIND,
  TICK_MS,
  YAW_UNITS,
  cellCentreX,
  cellCentreZ,
  createWorld,
  rayGrid,
  step,
  type HitEvent,
  type Input,
} from "../../shared/sim";
import { W_PISTOL, WEAPONS } from "../../shared/weapons";
import { quantPitch, quantYaw } from "../../shared/protocol";

/** Remote players are drawn this many ticks behind the server clock. */
const INTERP_TICKS = 6;
/** The server keeps about this many inputs queued per seat. */
const BUFFER_TICKS = 2;

/** Ticks of rewind a shot needs on a connection of this round trip. */
export function neededRewind(rttMs: number): number {
  // Snapshot down (half), drawn INTERP_TICKS behind plus one for the
  // snapshot's own stamp, input up (half), then the queue.
  return Math.round(rttMs / TICK_MS) + INTERP_TICKS + 1 + BUFFER_TICKS;
}

const SHOOTER = { x: 31, z: 40 };
const TARGET_Z = 52;
const TARGET_X0 = 30;

function input(over: Partial<Input>): Input {
  return {
    tick: 0, view: 0, moveX: 0, moveY: 0, yaw: 0, pitch: 0,
    fire: 0, jump: 0, reload: 0, weapon: 0, ...over,
  };
}

export interface LagResult { shots: number; hits: number; clamped: number; rate: number }

/** Shots and hits for a perfect aimer at this round trip. */
export function hitRate(rttMs: number, seconds = 30): LagResult {
  const w = createWorld(2);
  const s = w.players[0];
  const v = w.players[1];
  s.x = cellCentreX(SHOOTER.x); s.z = cellCentreZ(SHOOTER.z); s.y = LEVEL_GROUND;
  v.x = cellCentreX(TARGET_X0); v.z = cellCentreZ(TARGET_Z); v.y = LEVEL_GROUND;

  const lag = neededRewind(rttMs);
  // Where the target was at the end of each tick, as the client saw it.
  const seen: { x: number; y: number; z: number }[] = [];
  const hits: HitEvent[] = [];
  let shots = 0;
  let clamped = 0;
  const ticks = seconds * 60;
  for (let t = 0; t < ticks; t++) {
    const tick = w.tick;
    // The view tick the client sent, and what it saw then.
    const view = tick - lag;
    const at = seen[view] ?? seen[0] ?? { x: v.x, y: v.y, z: v.z };
    const dx = at.x - s.x;
    const dz = at.z - s.z;
    const dy = at.y + 1.0 - (s.y + EYE_HEIGHT);
    const yaw = ((quantYaw(Math.atan2(-dx, -dz)) % YAW_UNITS) + YAW_UNITS) % YAW_UNITS;
    const pitch = quantPitch(Math.atan2(dy, Math.hypot(dx, dz)));
    // Pistol, one pull every 16 ticks so neither bloom nor recoil carries
    // over from one shot to the next.
    const pull = t > 60 && t % 16 === 0;
    const pistol = WEAPONS[W_PISTOL];
    const before = s.ammo[W_PISTOL];
    // The target strafes along x, turning every half second.
    const dir = Math.floor(t / 30) % 2 === 0 ? 127 : -127;
    step(w, [
      input({ tick, view: Math.max(0, view), yaw, pitch, fire: pull ? 1 : 0, weapon: W_PISTOL + 1, reload: before === 0 ? 1 : 0 }),
      input({ tick, view: tick, moveX: dir }),
    ], hits);
    if (s.ammo[W_PISTOL] < before) {
      shots++;
      if (tick - Math.max(0, view) > MAX_REWIND) clamped++;
    }
    // Nobody dies: this measures registration, not the round.
    v.hp = 100;
    v.alive = true;
    seen[tick] = { x: v.x, y: v.y, z: v.z };
    assert.ok(pistol);
  }
  return { shots, hits: hits.length, clamped, rate: shots ? hits.length / shots : 0 };
}

test("the lag test's lines of fire are open", () => {
  for (let x = TARGET_X0 - 1; x <= TARGET_X0 + 8; x++) {
    const ox = cellCentreX(SHOOTER.x), oz = cellCentreZ(SHOOTER.z);
    const dx = cellCentreX(x) - ox, dz = cellCentreZ(TARGET_Z) - oz;
    const d = Math.hypot(dx, dz);
    assert.ok(rayGrid(ox, LEVEL_GROUND + EYE_HEIGHT, oz, dx / d, 0, dz / d, d) >= d, `blocked at x ${x}`);
  }
});

test("a perfect aimer hits a strafing target at 150 and 250 ms round trip", () => {
  const base = hitRate(0);
  const rows = [0, 150, 250].map((rtt) => ({ rtt, ...hitRate(rtt) }));
  for (const r of rows) {
    console.log(
      `rtt ${r.rtt} ms: rewind needed ${neededRewind(r.rtt)} ticks, max ${MAX_REWIND}; ` +
      `${r.hits}/${r.shots} hits (${(r.rate * 100).toFixed(1)}%), ${r.clamped} clamped`,
    );
  }
  assert.ok(base.rate > 0.9, `even with no lag only ${base.rate}`);
  for (const r of rows) {
    assert.ok(r.rate >= base.rate - 0.05, `at ${r.rtt} ms the hit rate fell to ${r.rate}`);
  }
});
