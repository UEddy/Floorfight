/**
 * Average shotgun damage per shot against a standing target, by distance,
 * from the real sim: the pattern, the hitboxes and the range all as the
 * server resolves them. Two hundred shots at each distance.
 *
 *   npx tsx scripts/pattern.ts
 */
import {
  EYE_HEIGHT, LEVEL_GROUND, YAW_UNITS, cellCentreX, cellCentreZ, createWorld, step,
  type HitEvent, type Input,
} from "../../shared/sim";
import { SWITCH_TICKS, W_SHOTGUN, WEAPONS } from "../../shared/weapons";
import { quantPitch } from "../../shared/protocol";

const input = (o: Partial<Input>): Input => ({
  tick: 0, view: 0, moveX: 0, moveY: 0, yaw: 0, pitch: 0, fire: 0, jump: 0, reload: 0, weapon: 0, ...o,
});

export function averageDamage(dist: number, shots = 200): number {
  const w = createWorld(2);
  const s = w.players[0];
  const v = w.players[1];
  s.x = cellCentreX(31); s.z = cellCentreZ(40); s.y = LEVEL_GROUND;
  v.x = s.x; v.z = s.z + dist; v.y = LEVEL_GROUND;
  const pitch = quantPitch(Math.atan2(1.0 - EYE_HEIGHT, dist));
  const yaw = YAW_UNITS / 2;
  const hits: HitEvent[] = [];
  for (let t = 0; t <= SWITCH_TICKS; t++) {
    step(w, [{ ...input({ weapon: W_SHOTGUN + 1, yaw, pitch }), tick: w.tick, view: w.tick }, null], hits);
  }
  let fired = 0;
  let dealt = 0;
  const spec = WEAPONS[W_SHOTGUN];
  while (fired < shots) {
    s.ammo[W_SHOTGUN] = spec.mag;
    s.reloadUntil = 0;
    s.kick = 0; s.drift = 0;
    s.lastFireTick = -999;
    v.hp = 1000; v.alive = true;
    hits.length = 0;
    step(w, [{ ...input({ yaw, pitch, fire: 1 }), tick: w.tick, view: w.tick }, null], hits);
    step(w, [{ ...input({ yaw, pitch }), tick: w.tick, view: w.tick }, null], hits);
    fired++;
    for (const h of hits) dealt += h.damage;
  }
  return dealt / fired;
}

if (process.argv[1]?.endsWith("pattern.ts")) {
  process.stdout.on("error", () => process.exit(0));
  for (const d of [2, 3, 4, 5, 6, 8, 10, 12, 15]) {
    const avg = averageDamage(d);
    console.log(`${String(d).padStart(2)} blocks: ${avg.toFixed(1)} damage a shot, ${Math.ceil(100 / Math.max(avg, 0.01))} shots to kill on average`);
  }
}
