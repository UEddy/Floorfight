// Simulation, map and bot tests.
//
// The replay determinism check is the one that matters most: the match log is
// the audit artifact, and a log that does not reproduce the match is worse
// than no log at all, because it looks like evidence.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  EYE_HEIGHT,
  GRAVITY,
  GROUND_ACCEL,
  GRID_X,
  GRID_Y,
  GRID_Z,
  JUMP_SPEED,
  LEVEL_GALLERY,
  LEVEL_GROUND,
  LEVEL_STAGE,
  MAX_HP,
  PLAYER_SPEED,
  RESPAWN_TICKS,
  ROUND_TICKS,
  SPAWNS,
  pickSpawn,
  TICK_HZ,
  YAW_UNITS,
  boxBlocked,
  cellCentreX,
  cellCentreZ,
  createWorld,
  onGround,
  rayGrid,
  shotSpread,
  exposedNow,
  solidAt,
  step,
  supportTop,
  type HitEvent,
  type Input,
} from "../../shared/sim";
import {
  FREE_SALT, FREE_SALT_BYTES, SWITCH_TICKS, WEAPONS, WEAPON_COUNT,
  W_PISTOL, W_RIFLE, W_SHOTGUN, saltSeeds, spreadHash,
} from "../../shared/weapons";
import { BANDSTAND, GRID, MAP_ID, MAP_NAME, ZONES } from "../../shared/map";
import {
  inWideSpace, key as cellKeyOf, nearestCover, pocketCells, reachable as walkable, sees, walkDistances,
} from "./mapcheck";
import { fromHex, sha256Hex, toHex } from "../../shared/sha256";
import { REPLAY_SEED, REPLAY_TICKS, runMatch } from "./replay";
import { FREE_SEAT_BOT, FREE_SEAT_OPEN, Room } from "../src/room";
import {
  JOIN_MESSAGE_RE, PROTOCOL_VERSION, joinMessage,
  type MatchLog, type RosterEntry,
} from "../../shared/protocol";
import bs58 from "bs58";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------ helpers --- */

function input(over: Partial<Input> = {}): Input {
  return {
    tick: 0, view: 0, moveX: 0, moveY: 0, yaw: 0, pitch: 0,
    fire: 0, jump: 0, reload: 0, weapon: 0, ...over,
  };
}

/**
 * Advance one player for n ticks with a fixed input.
 *
 * `into` collects the hit events. Pass it whenever the test cares about them:
 * without it they go into a throwaway array and a test that fires inside this
 * helper will see no hits and believe nothing happened.
 */
function run(
  world: ReturnType<typeof createWorld>, slot: number, inp: Input, n: number,
  into: HitEvent[] = [],
): void {
  for (let i = 0; i < n; i++) {
    const inputs: (Input | null)[] = new Array(world.players.length).fill(null);
    inputs[slot] = { ...inp, tick: world.tick, view: world.tick };
    step(world, inputs, into);
  }
}

function roster(n: number): RosterEntry[] {
  const out: RosterEntry[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ slot: i, wallet: `w${i}`, collection: null, mint: null });
  }
  return out;
}

/**
 * A clear spot on the bandstand for two players to face each other along +z:
 * east of both music stands, inside the canopy posts.
 */
const DUEL_X = 52;
const DUEL_Z = 19;

/* -------------------------------------------------------- determinism --- */

test("the same inputs replay to the same match, twice in one process", () => {
  const a = runMatch(REPLAY_SEED, REPLAY_TICKS);
  const b = runMatch(REPLAY_SEED, REPLAY_TICKS);
  assert.equal(a.stateHash, b.stateHash);
  assert.equal(a.logHash, b.logHash);
  // A run that never resolved a hit would pass the comparison without
  // exercising rewind, hitscan or scoring at all. The scripted players aim
  // and move at random, so the count is low by nature: what matters is that
  // the hit path, the rewind clamp and the death and respawn path all run.
  assert.ok(a.hits > 5, `expected the scripted match to land hits, got ${a.hits}`);
  assert.ok(a.kills > 0, `expected the scripted match to produce kills, got ${a.kills}`);
});

test("the same inputs replay to the same match in a fresh process", () => {
  const first = runMatch(REPLAY_SEED, REPLAY_TICKS);
  const out = execFileSync(
    process.execPath,
    ["--import", "tsx", path.join(HERE, "replay.ts"), "--print"],
    { encoding: "utf8", cwd: path.join(HERE, "..") },
  );
  const second = JSON.parse(out.trim().split("\n").pop()!) as typeof first;
  // A separate V8 instance rebuilds the angle table and the block grid from
  // scratch, so this also covers map construction and module load order.
  assert.equal(second.stateHash, first.stateHash);
  assert.equal(second.logHash, first.logHash);
});

test("a different input stream produces a different match", () => {
  const a = runMatch(REPLAY_SEED, REPLAY_TICKS);
  const b = runMatch(REPLAY_SEED + 1, REPLAY_TICKS);
  assert.notEqual(a.stateHash, b.stateHash);
});

/* ------------------------------------------------------------- height --- */

test("a player dropped in mid air falls and lands on the surface below", () => {
  const w = createWorld(1);
  const p = w.players[0];
  p.y = 14;
  p.vy = 0;
  const landing = supportTop(p.x, p.z, 14);
  run(w, 0, input(), 120);
  assert.equal(p.y, landing);
  assert.equal(p.vy, 0);
  assert.ok(onGround(p.x, p.y, p.z));
});

test("jump leaves the ground, peaks near the predicted height, and lands", () => {
  const w = createWorld(1);
  const p = w.players[0];
  const floor = p.y;
  const hits: HitEvent[] = [];

  // One tick with the bit set, then let go.
  step(w, [{ ...input({ jump: 1 }), tick: 0 }], hits);
  assert.ok(p.vy > 0, "should be rising");
  let peak = p.y;
  for (let i = 1; i < 90; i++) {
    step(w, [{ ...input(), tick: i }], hits);
    if (p.y > peak) peak = p.y;
  }

  const predicted = (JUMP_SPEED * JUMP_SPEED) / (2 * GRAVITY);
  assert.ok(peak - floor > 1, `jump should clear one block, peaked at ${peak - floor}`);
  assert.ok(
    Math.abs((peak - floor) - predicted) < 0.2,
    `peak ${peak - floor} should be near ${predicted}`,
  );
  assert.ok(peak - floor < 2, "a jump must not reach a two block ledge");
  assert.equal(p.y, floor, "should land back on the surface it left");
  assert.ok(onGround(p.x, p.y, p.z));
});

test("holding jump hops, it does not fly", () => {
  const w = createWorld(1);
  const p = w.players[0];
  const floor = p.y;
  const hits: HitEvent[] = [];
  let peak = floor;
  let landings = 0;
  for (let i = 0; i < 600; i++) {
    const was = p.vy;
    step(w, [{ ...input({ jump: 1 }), tick: i }], hits);
    if (p.y > peak) peak = p.y;
    // A hop starts on the tick after landing: the jump is only taken once
    // the player is standing again, so vy goes from rest to the impulse.
    if (was <= 0 && p.vy > 0) landings++;
  }
  assert.ok(peak - floor < 2, `height must not accumulate, reached ${peak - floor}`);
  assert.ok(landings > 5, "a held jump bit should hop repeatedly");
});

test("jump is refused in mid air", () => {
  const w = createWorld(1);
  const p = w.players[0];
  p.y += 4;
  p.vy = 0;
  const hits: HitEvent[] = [];
  step(w, [{ ...input({ jump: 1 }), tick: 0 }], hits);
  assert.ok(p.vy < 0, "gravity should be pulling, not a jump impulse");
});

test("standing still never drifts", () => {
  const w = createWorld(6);
  const before = w.players.map((p) => [p.x, p.y, p.z, p.vy]);
  run(w, 0, input(), 300);
  for (let i = 0; i < 6; i++) {
    const p = w.players[i];
    assert.deepEqual([p.x, p.y, p.z, p.vy], before[i], `slot ${i} drifted`);
  }
});

/* ---------------------------------------------------------- collision --- */

test("a player cannot walk out of the hall", () => {
  for (const yaw of [0, YAW_UNITS / 4, YAW_UNITS / 2, (YAW_UNITS * 3) / 4]) {
    const w = createWorld(1);
    const p = w.players[0];
    run(w, 0, input({ moveY: 127, yaw }), 900);
    assert.ok(!boxBlocked(p.x, p.y, p.z), "ended inside geometry");
    assert.ok(p.x > -GRID_X / 2 && p.x < GRID_X / 2, `left the grid on x at yaw ${yaw}`);
    assert.ok(p.z > -GRID_Z / 2 && p.z < GRID_Z / 2, `left the grid on z at yaw ${yaw}`);
  }
});

test("walking into a wall stops, and never enters it", () => {
  const w = createWorld(1);
  const p = w.players[0];
  // The west perimeter wall is a long way from anything else at this spawn.
  run(w, 0, input({ moveX: -127, yaw: 0 }), 600);
  assert.ok(!boxBlocked(p.x, p.y, p.z));
  const probe = supportTop(p.x, p.z, p.y);
  assert.equal(p.y, probe, "should be resting on a surface, not clipped into one");
});

test("a one block step is climbed by walking, a two block one is not", () => {
  // The bandstand is two blocks above the floor. The steps on its south
  // face are two separate one block steps, which is the difference the map
  // relies on: walking climbs the steps, and walking into the side does not.
  const w = createWorld(1);
  const p = w.players[0];
  p.x = cellCentreX(47);
  p.z = cellCentreZ(32);
  p.y = LEVEL_GROUND;
  p.vy = 0;
  // Yaw 0 looks along -z, so this walks north up the steps.
  run(w, 0, input({ moveY: 127, yaw: 0 }), 120);
  assert.equal(p.y, LEVEL_STAGE, `expected to be on the bandstand at ${LEVEL_STAGE}, got ${p.y}`);

  // Beside the steps, the same walk meets the two block side and stops.
  const w2 = createWorld(1);
  const q = w2.players[0];
  q.x = cellCentreX(42);
  q.z = cellCentreZ(32);
  q.y = LEVEL_GROUND;
  q.vy = 0;
  run(w2, 0, input({ moveY: 127, yaw: 0 }), 120);
  assert.equal(q.y, LEVEL_GROUND, "a two block side should not be walked up");
  assert.ok(q.z > cellCentreZ(BANDSTAND.z1), "and should stop against it");
});

test("supportTop and onGround agree with the grid", () => {
  for (const s of SPAWNS) {
    assert.equal(supportTop(s.x, s.z, s.y), s.y, "spawn should rest exactly on its surface");
    assert.ok(onGround(s.x, s.y, s.z));
    assert.ok(!boxBlocked(s.x, s.y, s.z), "spawn should not be inside a block");
  }
});

/* ------------------------------------------------------- acceleration --- */

test("running accelerates to full speed in a few ticks, and stops the same way", () => {
  const w = createWorld(1);
  const p = w.players[0];
  // Spawn 0 faces a clear run east along its aisle.
  const east = (YAW_UNITS * 3) / 4;
  run(w, 0, input({ moveY: 127, yaw: east }), 1);
  const first = Math.hypot(p.vx, p.vz);
  assert.ok(Math.abs(first - GROUND_ACCEL / TICK_HZ) < 1e-9, `first tick gave ${first}`);
  run(w, 0, input({ moveY: 127, yaw: east }), 7);
  assert.ok(Math.abs(Math.hypot(p.vx, p.vz) - PLAYER_SPEED) < 1e-9, "should be at full speed");
  run(w, 0, input({ yaw: east }), 3);
  const slowing = Math.hypot(p.vx, p.vz);
  assert.ok(slowing > 0 && slowing < PLAYER_SPEED, `should be slowing, at ${slowing}`);
  run(w, 0, input({ yaw: east }), 6);
  assert.equal(Math.hypot(p.vx, p.vz), 0, "should have stopped");
});

test("a wall takes the velocity on the axis it blocks", () => {
  const w = createWorld(1);
  const p = w.players[0];
  run(w, 0, input({ moveX: -127, yaw: 0 }), 600);
  assert.equal(p.vx, 0, "pressing into the west wall should leave no stored run");
});

test("spread is the base standing still, and opens with speed, air and a string of shots", () => {
  const rifle = WEAPONS[W_RIFLE];
  assert.equal(shotSpread(rifle, 0, 0, true, 0), rifle.spread);
  assert.equal(shotSpread(rifle, PLAYER_SPEED, 0, true, 0), rifle.spread + rifle.moveSpread);
  assert.equal(shotSpread(rifle, 0, 0, false, 0), rifle.spread + rifle.moveSpread);
  assert.equal(shotSpread(rifle, 0, 0, true, 999), rifle.spread + rifle.bloomMax);
  const shotgun = WEAPONS[W_SHOTGUN];
  assert.equal(shotSpread(shotgun, PLAYER_SPEED, 0, false, 5), shotgun.spread, "the pattern is the spread");
});

/* ----------------------------------------------------------- hitscan --- */

test("a ray stops at the first solid block", () => {
  // Straight down from a spawn hits the floor it is standing on.
  const s = SPAWNS[0];
  const d = rayGrid(s.x, s.y + EYE_HEIGHT, s.z, 0, -1, 0, 90);
  assert.ok(Math.abs(d - EYE_HEIGHT) < 1e-9, `expected ${EYE_HEIGHT}, got ${d}`);
});

test("a ray fired up through the open roof hits nothing", () => {
  // Over the nave floor between the bandstand and the north gallery there is
  // no roof structure, so a shot straight up leaves the world.
  const x = cellCentreX(24);
  const z = cellCentreZ(15);
  if (!solidAt(24, GRID_Y - 1, 15)) {
    const d = rayGrid(x, LEVEL_GROUND + EYE_HEIGHT, z, 0, 1, 0, 90);
    assert.equal(d, 90);
  }
});

test("walls and floors block a shot, and an open line does not", () => {
  const w = createWorld(2);
  const shooter = w.players[0];
  const victim = w.players[1];
  const hits: HitEvent[] = [];

  // Three blocks apart on the open bandstand: the shot lands.
  shooter.x = cellCentreX(DUEL_X);
  shooter.z = cellCentreZ(DUEL_Z);
  shooter.y = LEVEL_STAGE;
  victim.x = cellCentreX(DUEL_X);
  victim.z = cellCentreZ(DUEL_Z + 3);
  victim.y = LEVEL_STAGE;
  // Yaw 0 looks along -z, so looking at +z is half a turn.
  const toward = YAW_UNITS / 2;
  run(w, 0, input({ yaw: toward }), 1); // record a history frame
  const before = victim.hp;
  run(w, 0, input({ yaw: toward, fire: 1 }), 1, hits);
  assert.ok(victim.hp < before, "expected a hit down an open aisle");
  assert.ok(hits.length > 0, "and a hit event for it");

  // Now put the fountain's brick plinth between them, which stands taller
  // than an eye. Shooting through it must not land.
  const w2 = createWorld(2);
  const s2 = w2.players[0];
  const v2 = w2.players[1];
  s2.x = cellCentreX(30);
  s2.z = cellCentreZ(47);
  s2.y = LEVEL_GROUND;
  v2.x = cellCentreX(62);
  v2.z = cellCentreZ(47);
  v2.y = LEVEL_GROUND;
  const hp2 = v2.hp;
  const east = (YAW_UNITS * 3) / 4;
  run(w2, 0, input({ yaw: east }), 1);
  run(w2, 0, input({ yaw: east, fire: 1 }), 20, hits);
  assert.equal(v2.hp, hp2, "a shot across the hall should be stopped by cover");
});

test("a lag compensated shot does not land on someone who is behind cover now", () => {
  // On the nave floor, looking north at one of the iron columns. Rewound,
  // the victim is in the open in front of it; by the tick the shot is
  // resolved they are behind it. From where they stand that hit would be a
  // bullet through iron, so it does not land.
  const setup = (nowZ: number) => {
    const w = createWorld(2);
    const shooter = w.players[0];
    const victim = w.players[1];
    shooter.x = cellCentreX(27); shooter.z = cellCentreZ(42); shooter.y = LEVEL_GROUND;
    victim.x = cellCentreX(27); victim.z = cellCentreZ(39); victim.y = LEVEL_GROUND;
    const seen = w.tick;
    step(w, [input({ tick: 0, view: seen }), null], []); // records the victim in the open
    victim.z = cellCentreZ(nowZ);
    const hits: HitEvent[] = [];
    // Pitched down a little to the victim's chest, as the shooter saw it.
    const pitch = Math.round((-0.25 / 1.45) * 32767);
    step(w, [input({ tick: 1, view: seen, yaw: 0, pitch, fire: 1 }), null], hits);
    return { victim, hits };
  };

  const hidden = setup(34);
  assert.ok(!exposedNow(cellCentreX(27), LEVEL_GROUND + EYE_HEIGHT, cellCentreZ(42), hidden.victim));
  assert.equal(hidden.hits.length, 0, "behind the column now, so no hit");
  assert.equal(hidden.victim.hp, MAX_HP);

  // The same rewound shot on a victim who stepped back but is still in the
  // open lands, so the rule only takes away hits through cover.
  const open = setup(40);
  assert.ok(open.hits.length > 0, "still in the open, so the rewound shot lands");
});

test("a shot at someone on the floor below is stopped by the gallery deck", () => {
  const w = createWorld(2);
  const up = w.players[0];
  const down = w.players[1];

  // The west gallery, and someone in the arcade directly underneath it.
  up.x = cellCentreX(2);
  up.z = cellCentreZ(20);
  up.y = LEVEL_GALLERY;
  down.x = cellCentreX(2);
  down.z = cellCentreZ(20);
  down.y = LEVEL_GROUND;
  assert.ok(solidAt(2, LEVEL_GALLERY - 1, 20), "test assumes deck below the gallery");

  const hp = down.hp;
  // Straight down, which is a pitch of minus the limit.
  run(w, 0, input({ pitch: -32767 }), 1);
  run(w, 0, input({ pitch: -32767, fire: 1 }), 20);
  assert.equal(down.hp, hp, "the deck should have stopped it");
});

test("a head shot with the pistol kills outright, a body shot does not", () => {
  const w = createWorld(2);
  const s = w.players[0];
  const v = w.players[1];
  s.x = cellCentreX(DUEL_X);
  s.z = cellCentreZ(DUEL_Z);
  s.y = LEVEL_STAGE;
  v.x = cellCentreX(DUEL_X);
  v.z = cellCentreZ(DUEL_Z + 3);
  v.y = LEVEL_STAGE;

  const hits: HitEvent[] = [];
  // Switch to the pistol and wait out the swap.
  run(w, 0, input({ weapon: W_PISTOL + 1 }), SWITCH_TICKS + 1);
  const toward = YAW_UNITS / 2;
  run(w, 0, input({ yaw: toward }), 1);
  step(w, [{ ...input({ yaw: toward, fire: 1 }), tick: w.tick, view: w.tick }], hits);

  // Eyes are at head height and both players stand on the same surface, so a
  // level shot is a head shot.
  assert.equal(hits.length, 1);
  assert.equal(hits[0].head, true);
  assert.equal(hits[0].lethal, true);
  assert.equal(hits[0].weapon, W_PISTOL);
  assert.equal(hits[0].damage, WEAPONS[W_PISTOL].headDamage);
  assert.equal(v.hp, 0);
  assert.equal(v.alive, false);
  assert.equal(s.kills, 1);
});

/* --------------------------------------------------------------- map --- */

const cellOf = (s: { x: number; y: number; z: number }): [number, number, number] =>
  [Math.floor(s.x + GRID_X / 2), s.y, Math.floor(s.z + GRID_Z / 2)];

test("there are at least twelve spawns, standable and under cover", () => {
  assert.ok(SPAWNS.length >= 12, `only ${SPAWNS.length} spawns`);
  const levels = new Set(SPAWNS.map((s) => s.y));
  assert.ok(levels.has(LEVEL_GROUND) && levels.has(LEVEL_GALLERY), `spawn levels ${[...levels]}`);
  for (const s of SPAWNS) {
    const [ix, iy, iz] = cellOf(s);
    assert.ok(solidAt(ix, iy - 1, iz), `nothing to stand on at ${ix},${iy},${iz}`);
    assert.ok(!boxBlocked(s.x, s.y, s.z), `inside a block at ${ix},${iy},${iz}`);
    // Something to put between yourself and the room within a few steps.
    assert.ok(nearestCover(ix, iy, iz) < 5, `spawn ${ix},${iy},${iz} has no cover within 5 blocks`);
  }
});

test("no spawn can see another", () => {
  const cells = SPAWNS.map(cellOf);
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      assert.ok(!sees(cells[i], cells[j]), `spawns ${cells[i]} and ${cells[j]} see each other`);
    }
  }
});

test("every spawn is under six seconds' walk from a fight", () => {
  // Six seconds at full speed, walking, no jumps.
  const budget = 6 * PLAYER_SPEED;
  const zones = ZONES.map((z) => cellKeyOf(z.x, z.y, z.z));
  for (const s of SPAWNS) {
    const dist = walkDistances(cellOf(s));
    const best = Math.min(...zones.map((k) => dist.get(k) ?? Infinity));
    assert.ok(best <= budget, `spawn ${cellOf(s)} is ${best.toFixed(1)} blocks from the nearest zone`);
  }
});

test("every level, every zone and every spawn are reachable on foot", () => {
  // Walk and one block climbs only, from a ground spawn. No jumping, which is
  // the conservative set: if the galleries are reachable without it, they
  // are reachable.
  const start = SPAWNS.find((s) => s.y === LEVEL_GROUND)!;
  const reach = walkable([cellOf(start)]);
  const counts = new Map<number, number>();
  for (const k of reach) {
    const iy = Math.floor(k / (GRID_X * GRID_Z));
    counts.set(iy, (counts.get(iy) ?? 0) + 1);
  }
  for (const level of [LEVEL_GROUND, LEVEL_STAGE, LEVEL_GALLERY]) {
    assert.ok((counts.get(level) ?? 0) > 100, `level ${level} barely reachable: ${counts.get(level)}`);
  }
  for (const z of ZONES) {
    assert.ok(reach.has(cellKeyOf(z.x, z.y, z.z)), `${z.name} is cut off`);
  }
  // And every spawn, since a player respawning into a sealed pocket is stuck
  // there for the rest of the round.
  for (const s of SPAWNS) {
    assert.ok(reach.has(cellKeyOf(...cellOf(s))), `spawn ${cellOf(s)} is cut off from the floor`);
  }
});

test("there is no pocket narrower than four blocks", () => {
  const reach = walkable(SPAWNS.map(cellOf));
  const pockets = pocketCells(reach);
  assert.equal(pockets.length, 0, `${pockets.length} cells in narrow pockets`);
});

test("the arcades under the side galleries are six blocks wide the whole way", () => {
  for (const [x0, x1] of [[1, 6], [GRID_X - 7, GRID_X - 2]]) {
    for (let z = 8; z < GRID_Z - 8; z++) {
      for (let x = x0; x <= x1; x++) {
        assert.ok(
          solidAt(x, LEVEL_GROUND - 1, z) && !solidAt(x, LEVEL_GROUND, z) && !solidAt(x, LEVEL_GROUND + 1, z),
          `arcade blocked at ${x},${z}`,
        );
      }
    }
  }
});

test("the nave is open: long lines run most of its length", () => {
  // Down the nave at eye height, just inside each row of columns, a line
  // runs from the north gallery's edge most of the way to the engines.
  for (const x of [31, 64]) {
    const d = rayGrid(cellCentreX(x), LEVEL_GROUND + EYE_HEIGHT, cellCentreZ(8), 0, 0, 1, 90);
    assert.ok(d > 60, `the nave line at x ${x} is only ${d.toFixed(1)} blocks`);
  }
  // And across it, between two column pairs, wall to wall under the galleries.
  const across = rayGrid(cellCentreX(8), LEVEL_GROUND + EYE_HEIGHT, cellCentreZ(66), 1, 0, 0, 90);
  assert.ok(across > 50, `the cross line is only ${across.toFixed(1)} blocks`);
  // The centre of the nave is a big open floor, not a set of rooms.
  assert.ok(inWideSpace(34, LEVEL_GROUND, 44, 6) && inWideSpace(60, LEVEL_GROUND, 44, 6));
});

test("a respawn lands out of sight of the living, and away from them", () => {
  const w = createWorld(6);
  // Everybody but slot 0 stands on a spawn; slot 0 is dead and due back.
  const taken = [0, 3, 6, 9, 12];
  for (let i = 1; i < 6; i++) {
    const s = SPAWNS[taken[i - 1] % SPAWNS.length];
    Object.assign(w.players[i], { x: s.x, y: s.y, z: s.z });
  }
  for (let deaths = 0; deaths < 20; deaths++) {
    w.players[0].deaths = deaths;
    const i = pickSpawn(w, 0);
    const mine = cellOf(SPAWNS[i]);
    for (let j = 1; j < 6; j++) {
      const e = cellOf(w.players[j]);
      assert.ok(!sees(e, mine), `respawn ${mine} is in sight of slot ${j} at ${e}`);
      assert.notDeepEqual(mine, e, "respawned on top of someone");
    }
  }
  // With nobody else alive it still picks a spawn, and the choice is a pure
  // function of the world, so the replay picks the same one.
  for (let j = 1; j < 6; j++) w.players[j].alive = false;
  assert.equal(pickSpawn(w, 0), pickSpawn(w, 0));
});

/* ------------------------------------------------------------ map id --- */

test("the map id is the sha256 of the grid bytes", () => {
  // Checked against node:crypto rather than against itself, because the hash
  // in shared/ is hand written: it has to run in a WebView where there is no
  // node:crypto and WebCrypto is asynchronous.
  const expected = createHash("sha256").update(GRID).digest("hex");
  assert.equal(MAP_ID, expected);
  assert.equal(MAP_ID, sha256Hex(GRID));
  assert.equal(MAP_ID.length, 64);
  assert.equal(MAP_NAME, "The Hall");
});

test("changing one block changes the map id", () => {
  for (const at of [0, 1, GRID.length >> 1, GRID.length - 1]) {
    const edited = Uint8Array.from(GRID);
    // Flip the cell to something else: air if it was solid, brick if it was
    // air. Either way one block of the hall is different.
    edited[at] = edited[at] === 0 ? 2 : 0;
    assert.notEqual(sha256Hex(edited), MAP_ID, `editing cell ${at} did not move the id`);
  }
  // And an untouched copy still hashes to the same thing, so the test above
  // is detecting the edit rather than the copy.
  assert.equal(sha256Hex(Uint8Array.from(GRID)), MAP_ID);
});

/* ------------------------------------------------------------ weapons --- */

test("every weapon has a coherent spec", () => {
  assert.equal(WEAPONS.length, WEAPON_COUNT);
  WEAPONS.forEach((spec, i) => {
    assert.equal(spec.id, i);
    assert.ok(spec.mag > 0 && spec.reloadTicks > 0 && spec.fireInterval > 0);
    assert.ok(spec.damage > 0 && spec.pellets >= 1 && spec.range > 0);
    assert.equal(spec.headDamage, Math.round(spec.damage * spec.headMult));
    assert.ok(spec.headDamage > spec.damage, "a head shot should hurt more");
  });
  assert.equal(WEAPONS[W_RIFLE].auto, true);
  assert.equal(WEAPONS[W_PISTOL].auto, false);
  assert.equal(WEAPONS[W_SHOTGUN].pellets, 8);
  // The pistol is the only one that kills with a single head shot.
  assert.ok(WEAPONS[W_PISTOL].headDamage >= MAX_HP);
  assert.ok(WEAPONS[W_RIFLE].headDamage < MAX_HP);
});

test("spread comes from a hash of salt, tick, slot and pellet, not from chance", () => {
  // Same inputs, same number, every time and in any order.
  assert.equal(spreadHash(FREE_SALT, 1234, 3, 5), spreadHash(FREE_SALT, 1234, 3, 5));
  const seen = new Set<number>();
  for (let t = 0; t < 40; t++) {
    for (let slot = 0; slot < 6; slot++) {
      for (let pel = 0; pel < 8; pel++) seen.add(spreadHash(FREE_SALT, t, slot, pel));
    }
  }
  // 1920 draws from a 32 bit space: a generator that ignored one of its
  // arguments would collide heavily here.
  assert.ok(seen.size > 1900, `expected distinct values, got ${seen.size}`);
  for (const h of seen) assert.ok(h >= 0 && h <= 0xffffffff);

  // And the salt matters: the same tick, slot and pellet under a different
  // salt is a different number nearly every time.
  const other = saltSeeds(new Uint8Array(32).fill(7));
  let differ = 0;
  for (let t = 0; t < 200; t++) {
    if (spreadHash(FREE_SALT, t, 1, 0) !== spreadHash(other, t, 1, 0)) differ++;
  }
  assert.ok(differ > 195, `the salt should change the pattern, ${differ}/200 differed`);
});

test("folding the salt uses every byte of it", () => {
  const base = new Uint8Array(32);
  const seen = new Set<string>();
  for (let i = 0; i < 32; i++) {
    const edited = Uint8Array.from(base);
    edited[i] = 1;
    const s = saltSeeds(edited);
    seen.add(`${s.a}:${s.b}`);
  }
  // A fold that dropped a byte would produce a repeat here.
  assert.equal(seen.size, 32);
});

/** Put two players nose to nose on the bandstand. */
function duel(): ReturnType<typeof createWorld> {
  const w = createWorld(2);
  const s = w.players[0];
  const v = w.players[1];
  s.x = cellCentreX(DUEL_X);
  s.z = cellCentreZ(DUEL_Z);
  s.y = LEVEL_STAGE;
  v.x = cellCentreX(DUEL_X);
  v.z = cellCentreZ(DUEL_Z + 2);
  v.y = LEVEL_STAGE;
  return w;
}

const FACING = YAW_UNITS / 2;

test("the rifle fires on a held trigger at its own interval", () => {
  const w = duel();
  const hits: HitEvent[] = [];
  const spec = WEAPONS[W_RIFLE];
  const p = w.players[0];
  run(w, 0, input({ yaw: FACING }), 1);
  // Counted in rounds spent rather than hits landed: two players nose to
  // nose is a head shot every time and the victim dies after three.
  for (let i = 0; i < spec.fireInterval * 5; i++) {
    step(w, [{ ...input({ yaw: FACING, fire: 1 }), tick: w.tick, view: w.tick }], hits);
  }
  const fired = spec.mag - p.ammo[W_RIFLE];
  assert.equal(fired, 5, `a held trigger should fire at its interval, fired ${fired}`);
  assert.ok(hits.length >= 3);
  assert.equal(hits[0].weapon, W_RIFLE);
  assert.ok(hits[0].damage > 0);
});

test("the pistol needs the trigger released between shots", () => {
  const w = duel();
  const hits: HitEvent[] = [];
  const spec = WEAPONS[W_PISTOL];
  const p = w.players[0];
  run(w, 0, input({ weapon: W_PISTOL + 1 }), SWITCH_TICKS + 1);
  // Hold it down for a long time: exactly one round leaves the magazine.
  for (let i = 0; i < 120; i++) {
    step(w, [{ ...input({ yaw: FACING, fire: 1 }), tick: w.tick, view: w.tick }], hits);
  }
  assert.equal(spec.mag - p.ammo[W_PISTOL], 1, "a held semi automatic trigger fires once");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].lethal, true, "and a pistol head shot should be lethal");

  // Release, wait out the interval, pull again: a second round goes.
  run(w, 0, input({ yaw: FACING }), spec.fireInterval + 1);
  step(w, [{ ...input({ yaw: FACING, fire: 1 }), tick: w.tick, view: w.tick }], hits);
  assert.equal(spec.mag - p.ammo[W_PISTOL], 2);
});

test("a shotgun blast is one hit event with its pellets summed", () => {
  const w = duel();
  const hits: HitEvent[] = [];
  const spec = WEAPONS[W_SHOTGUN];
  run(w, 0, input({ weapon: W_SHOTGUN + 1 }), SWITCH_TICKS + 1);
  run(w, 0, input({ yaw: FACING }), 1);
  step(w, [{ ...input({ yaw: FACING, fire: 1 }), tick: w.tick, view: w.tick }], hits);

  assert.equal(hits.length, 1, "pellets on one victim are one event");
  assert.equal(hits[0].weapon, W_SHOTGUN);
  // Two blocks apart, so most of the pattern lands but not necessarily all.
  assert.ok(hits[0].damage >= spec.damage * 3, `only ${hits[0].damage} damage at point blank`);
  assert.ok(hits[0].damage <= spec.headDamage * spec.pellets);
  assert.equal(w.players[0].ammo[W_SHOTGUN], spec.mag - 1);
});

/**
 * Find a standing spot with a clear horizontal run of between `min` and `max`
 * blocks along +z, which is the direction a yaw of half a turn looks.
 *
 * Searched rather than written down because the geometry moves: the map's
 * whole point is that long open lines are rare, so the test has to go and
 * find the ones that exist instead of assuming a corridor is still there.
 */
function clearRun(min: number, max: number): { ix: number; iy: number; iz: number } | null {
  for (let iy = 1; iy < GRID_Y - 2; iy++) {
    for (let iz = 1; iz < GRID_Z - 1; iz++) {
      for (let ix = 1; ix < GRID_X - 1; ix++) {
        if (!solidAt(ix, iy - 1, iz) || solidAt(ix, iy, iz) || solidAt(ix, iy + 1, iz)) continue;
        const d = rayGrid(cellCentreX(ix), iy + EYE_HEIGHT, cellCentreZ(iz), 0, 0, 1, 70);
        if (d >= min && d <= max) return { ix, iy, iz };
      }
    }
  }
  return null;
}

test("the shotgun stops at its range, and works inside it", () => {
  const spec = WEAPONS[W_SHOTGUN];
  // A line longer than the shotgun reaches, which exists in the galleries.
  const spot = clearRun(spec.range + 3, 30);
  assert.ok(spot, `no clear run of ${spec.range + 3} blocks to test with`);

  const place = (gap: number) => {
    const w = createWorld(2);
    for (const p of w.players) {
      p.x = cellCentreX(spot!.ix);
      p.y = spot!.iy;
      p.z = cellCentreZ(spot!.iz);
      p.vy = 0;
    }
    w.players[1].z = cellCentreZ(spot!.iz) + gap;
    const hits: HitEvent[] = [];
    run(w, 0, input({ weapon: W_SHOTGUN + 1 }), SWITCH_TICKS + 1);
    run(w, 0, input({ yaw: FACING }), 1);
    for (let i = 0; i < spec.fireInterval * 3; i++) {
      step(w, [{ ...input({ yaw: FACING, fire: 1 }), tick: w.tick, view: w.tick }], hits);
      // Semi automatic: let go between pulls.
      step(w, [{ ...input({ yaw: FACING }), tick: w.tick, view: w.tick }], hits);
    }
    return hits;
  };

  assert.ok(place(4).length > 0, "a shotgun has to work at four blocks");
  assert.equal(place(spec.range + 2).length, 0, "and must not reach past its range");
});

test("a magazine runs out, reloads, and refills", () => {
  const w = createWorld(1);
  const p = w.players[0];
  const spec = WEAPONS[W_RIFLE];
  const hits: HitEvent[] = [];

  // Empty the magazine into the air.
  for (let i = 0; i < spec.mag * spec.fireInterval; i++) {
    step(w, [{ ...input({ fire: 1, pitch: 20000 }), tick: w.tick, view: w.tick }], hits);
  }
  assert.equal(p.ammo[W_RIFLE], 0, "the magazine should be empty");
  // Firing dry starts a reload on its own.
  step(w, [{ ...input({ fire: 1 }), tick: w.tick, view: w.tick }], hits);
  assert.ok(p.reloadUntil > w.tick, "a dry trigger should start a reload");

  run(w, 0, input(), spec.reloadTicks + 2);
  assert.equal(p.ammo[W_RIFLE], spec.mag, "the reload should have filled it");
  assert.equal(p.reloadUntil, 0);
});

test("a reload request is refused while already reloading or already full", () => {
  const w = createWorld(1);
  const p = w.players[0];
  const hits: HitEvent[] = [];
  step(w, [{ ...input({ reload: 1 }), tick: 0, view: 0 }], hits);
  assert.equal(p.reloadUntil, 0, "a full magazine needs no reload");

  // Fire one round, then reload, then ask again mid reload: the first one
  // stands rather than being restarted every tick the button is held.
  step(w, [{ ...input({ fire: 1 }), tick: w.tick, view: w.tick }], hits);
  step(w, [{ ...input({ reload: 1 }), tick: w.tick, view: w.tick }], hits);
  const due = p.reloadUntil;
  assert.ok(due > w.tick);
  run(w, 0, input({ reload: 1 }), 5);
  assert.equal(p.reloadUntil, due, "a held reload button must not extend the reload");
});

test("firing is refused during a weapon swap, and a swap cancels a reload", () => {
  const w = createWorld(2);
  const p = w.players[0];
  const hits: HitEvent[] = [];
  p.x = cellCentreX(DUEL_X);
  p.z = cellCentreZ(DUEL_Z);
  p.y = LEVEL_STAGE;
  w.players[1].x = cellCentreX(DUEL_X);
  w.players[1].z = cellCentreZ(DUEL_Z + 2);
  w.players[1].y = LEVEL_STAGE;

  // Ask for the shotgun and pull the trigger immediately.
  step(w, [{ ...input({ weapon: W_SHOTGUN + 1, yaw: FACING, fire: 1 }), tick: 0, view: 0 }], hits);
  assert.equal(p.weapon, W_SHOTGUN);
  assert.equal(hits.length, 0, "the swap has to finish first");
  run(w, 0, input({ yaw: FACING, fire: 1 }), SWITCH_TICKS - 2, hits);
  assert.equal(hits.length, 0, `fired ${hits.length} times during the swap`);
  // The shotgun is semi automatic, so a trigger that was already held when
  // the swap finished stays dead until it is released. Let go, then pull.
  run(w, 0, input({ yaw: FACING }), 2, hits);
  run(w, 0, input({ yaw: FACING, fire: 1 }), 2, hits);
  assert.ok(hits.length > 0, "and then it fires");

  // A reload interrupted by a swap does not finish.
  const w2 = createWorld(1);
  const q = w2.players[0];
  step(w2, [{ ...input({ fire: 1 }), tick: 0, view: 0 }], hits);
  step(w2, [{ ...input({ reload: 1 }), tick: 1, view: 1 }], hits);
  assert.ok(q.reloadUntil > 0);
  step(w2, [{ ...input({ weapon: W_PISTOL + 1 }), tick: 2, view: 2 }], hits);
  assert.equal(q.reloadUntil, 0, "swapping should abandon the reload");
  assert.equal(q.ammo[W_RIFLE], WEAPONS[W_RIFLE].mag - 1, "and not refill it");
});

test("a hostile weapon index is ignored", () => {
  const w = createWorld(1);
  const p = w.players[0];
  const hits: HitEvent[] = [];
  for (const bad of [-5, 0.5, 99, WEAPON_COUNT + 1, 1e9]) {
    step(w, [{ ...input({ weapon: bad }), tick: w.tick, view: w.tick }], hits);
    assert.ok(p.weapon >= 0 && p.weapon < WEAPON_COUNT, `weapon became ${p.weapon}`);
  }
  assert.equal(p.weapon, W_RIFLE, "nothing in that list should have changed the weapon");
});

test("the round is three minutes and respawning takes three seconds", () => {
  assert.equal(ROUND_TICKS, 180 * TICK_HZ);
  assert.equal(RESPAWN_TICKS, 3 * TICK_HZ);
});

/* ------------------------------------------------------ join message --- */

test("the join message pattern accepts real join messages and little else", () => {
  const nonce = bs58.encode(Buffer.from(new Uint8Array(24).fill(9)));
  const good = joinMessage("12345", nonce);
  const m = JOIN_MESSAGE_RE.exec(good);
  assert.ok(m, `${good} should match`);
  assert.equal(m![1], String(PROTOCOL_VERSION));
  assert.equal(m![2], "12345");
  assert.equal(m![3], nonce);
  assert.ok(JOIN_MESSAGE_RE.test(joinMessage("dev", nonce)));

  // Everything the mobile shell must refuse to sign. The point of the
  // pattern is that a page cannot talk the native side into signing anything
  // but a join message for a match, so each of these has to fail.
  const bad = [
    "",
    "floorfight:join",
    `floorfight:join:v${PROTOCOL_VERSION}:12345:${nonce} `,
    ` floorfight:join:v${PROTOCOL_VERSION}:12345:${nonce}`,
    `floorfight:join:v${PROTOCOL_VERSION}:12345:${nonce}\nmore`,
    `floorfight:join:v${PROTOCOL_VERSION}::${nonce}`,
    `floorfight:join:v${PROTOCOL_VERSION}:12345:`,
    `floorfight:join:v${PROTOCOL_VERSION}:12345:short`,
    `floorfight:join:v:12345:${nonce}`,
    `floorfight:join:v${PROTOCOL_VERSION}:match with spaces:${nonce}`,
    `floorfight:join:v${PROTOCOL_VERSION}:12345:${nonce}:extra`,
    `prefix floorfight:join:v${PROTOCOL_VERSION}:12345:${nonce}`,
    `floorfight:settle:v${PROTOCOL_VERSION}:12345:${nonce}`,
    // A base64 blob, which is what a transaction handed over as text would
    // look like.
    "AQABAzfDRg+8zSGKAgMxSe/aUlvYPhLJ6yFKFBtQdwGfEhUB",
    // Arbitrary bytes rendered as a string.
    "\u0001\u0002\u0003",
  ];
  for (const s of bad) {
    assert.equal(JOIN_MESSAGE_RE.test(s), false, `should have been refused: ${JSON.stringify(s)}`);
  }
});

/* ------------------------------------------------- commit and reveal --- */

test("a staked room commits to a random salt and reveals it at the end", () => {
  let log: MatchLog | null = null;
  const room = new Room("staked-salt", roster(6), (l) => { log = l; }, 0, "staked");

  // 32 bytes, drawn at creation, and the commit is their hash.
  assert.equal(room.spreadSalt.length, 32);
  assert.equal(room.spreadCommit, sha256Hex(room.spreadSalt));
  assert.notEqual(toHex(room.spreadSalt), toHex(FREE_SALT_BYTES));

  // Two staked rooms do not share a salt.
  const other = new Room("staked-salt-2", roster(6), () => {}, 0, "staked");
  assert.notEqual(toHex(room.spreadSalt), toHex(other.spreadSalt));

  // Nothing reveals it until the round is over.
  const inner = room as unknown as { log: MatchLog; tick: () => void };
  assert.equal(inner.log.spreadSalt, "");

  room.start();
  room.stop();
  for (let i = 0; i < ROUND_TICKS; i++) inner.tick();

  assert.ok(log, "the room should have finished");
  const finished = log as unknown as MatchLog;
  assert.equal(finished.spreadSalt, toHex(room.spreadSalt));
  assert.equal(sha256Hex(fromHex(finished.spreadSalt)!), room.spreadCommit);
});

test("a free room uses the fixed public salt", () => {
  const room = new Room("free-salt", roster(6), () => {}, 0, "free");
  assert.equal(toHex(room.spreadSalt), toHex(FREE_SALT_BYTES));
  assert.equal(room.spreadCommit, sha256Hex(FREE_SALT_BYTES));
});

test("a replay with the revealed salt reproduces the match, a wrong salt does not", () => {
  // Stand in for a staked room's salt: 32 bytes nobody could have guessed.
  const salt = new Uint8Array(32);
  for (let i = 0; i < 32; i++) salt[i] = (i * 37 + 11) & 0xff;
  const commit = sha256Hex(salt);

  const played = runMatch(REPLAY_SEED, 40 * TICK_HZ, salt);

  // The reveal: hex in the log, which hashes to the commitment published at
  // join. A verifier does these two checks before replaying anything.
  const revealed = fromHex(toHex(salt))!;
  assert.equal(sha256Hex(revealed), commit);

  const replayed = runMatch(REPLAY_SEED, 40 * TICK_HZ, revealed);
  assert.equal(replayed.stateHash, played.stateHash);
  assert.equal(replayed.logHash, played.logHash);
  assert.ok(played.hits > 5, `the match needs shots in it, had ${played.hits}`);

  // The wrong salt replays into a different match. One byte is enough: this
  // is what makes the salt worth committing to rather than just publishing.
  const wrong = Uint8Array.from(salt);
  wrong[31] ^= 1;
  const bad = runMatch(REPLAY_SEED, 40 * TICK_HZ, wrong);
  assert.notEqual(bad.stateHash, played.stateHash);
  assert.notEqual(bad.logHash, played.logHash);

  // And a replay under the free salt, which is what someone would reach for
  // if they ignored the log, also fails to reproduce it.
  const ignored = runMatch(REPLAY_SEED, 40 * TICK_HZ);
  assert.notEqual(ignored.stateHash, played.stateHash);
});

/* -------------------------------------------------------------- rooms --- */

/* --------------------------------------------------------- free seats --- */

/** A free room's roster starts as open seats nobody can sign for. */
function openRoster(n: number): RosterEntry[] {
  const out: RosterEntry[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ slot: i, wallet: FREE_SEAT_OPEN, collection: null, mint: null });
  }
  return out;
}

test("a free room seats any key, in join order", () => {
  const room = new Room("free-join", openRoster(6), () => {}, 0, "free");
  assert.equal(room.freeSeats(), 6);
  assert.equal(room.claimFreeSeat("guest-a"), 0);
  assert.equal(room.claimFreeSeat("guest-b"), 1);
  assert.equal(room.claimFreeSeat("guest-c"), 2);
  assert.equal(room.roster[0].wallet, "guest-a");
  assert.equal(room.roster[2].wallet, "guest-c");

  // The same key back again gets its own slot, which is what makes a
  // reconnect land on the same player rather than a new one.
  assert.equal(room.claimFreeSeat("guest-b"), 1);
  assert.equal(room.claimFreeSeat("guest-a"), 0);
});

test("a free room fills up and then turns people away", () => {
  const room = new Room("free-full", openRoster(6), () => {}, 0, "free");
  for (let i = 0; i < 6; i++) {
    assert.equal(room.claimFreeSeat(`g${i}`), i);
  }
  assert.equal(room.claimFreeSeat("one-too-many"), null);
  // Nobody connected, so every seat is still one a guest could take over.
  assert.equal(room.freeSeats(), 6);
});

test("a staked room never hands out a seat to just anybody", () => {
  const room = new Room("staked-seats", roster(6), () => {});
  assert.equal(room.claimFreeSeat("stranger"), null);
  assert.equal(room.freeSeats(), 0);
});

test("a bot holds a seat but does not keep a guest out of it", () => {
  const room = new Room("free-bots", openRoster(6), () => {}, 0, "free");
  room.fillBots();
  assert.equal(room.botCount(), 6);
  // The roster says which slots are bots, so the match log does too.
  assert.ok(room.roster.every((r) => r.wallet.startsWith(FREE_SEAT_BOT)));
  // And a guest arriving later can still sit down, displacing one.
  assert.equal(room.freeSeats(), 6);
  const slot = room.claimFreeSeat("latecomer");
  assert.equal(typeof slot, "number");
  assert.equal(room.roster[slot!].wallet, "latecomer");
});

test("a free room is joinable until it is full of people or nearly over", () => {
  const room = new Room("free-joinable", openRoster(2), () => {}, 0, "free");
  assert.equal(room.joinable(), true);

  // Two connected players and there is nowhere to sit.
  for (const slot of [0, 1]) {
    const wallet = `g${slot}`;
    room.claimFreeSeat(wallet);
    room.seat({
      slot, wallet, queue: [], ack: -1, lastSeenTick: 0,
      send: () => {}, close: () => {}, pingId: 0, pingSentAt: 0, rtt: 0,
    });
  }
  assert.equal(room.freeSeats(), 0);
  assert.equal(room.joinable(), false);

  // A room with almost no round left is not worth sending anyone to, even
  // with a seat going.
  const late = new Room("free-late", openRoster(2), () => {}, 0, "free");
  late.start();
  late.stop();
  const tick = (late as unknown as { tick: () => void }).tick.bind(late);
  for (let i = 0; i < ROUND_TICKS - 5; i++) tick();
  assert.ok(late.secondsLeft() < 1);
  assert.equal(late.freeSeats(), 2);
  assert.equal(late.joinable(), false);
});

test("a free room waits a moment, then starts with bots", async () => {
  const room = new Room("free-wait", openRoster(6), () => {}, 0, "free", true, 60);
  assert.equal(room.isStarted, false);

  // Nobody has sat down, so nothing is scheduled: an empty room costs
  // nothing and never becomes a match on its own.
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(room.isStarted, false);

  room.claimFreeSeat("first");
  room.seat({
    slot: 0, wallet: "first", queue: [], ack: -1, lastSeenTick: 0,
    send: () => {}, close: () => {}, pingId: 0, pingSentAt: 0, rtt: 0,
  });
  assert.equal(room.isStarted, false, "it should wait for company first");
  await new Promise((r) => setTimeout(r, 160));
  assert.equal(room.isStarted, true, "and then start anyway");
  assert.equal(room.botCount(), 5, "with bots in the empty seats");
  room.stop();
});

test("a full house starts at once rather than waiting", () => {
  const room = new Room("free-rush", openRoster(2), () => {}, 0, "free", true, 60_000);
  for (const slot of [0, 1]) {
    const wallet = `g${slot}`;
    room.claimFreeSeat(wallet);
    room.seat({
      slot, wallet, queue: [], ack: -1, lastSeenTick: 0,
      send: () => {}, close: () => {}, pingId: 0, pingSentAt: 0, rtt: 0,
    });
  }
  assert.equal(room.isStarted, true);
  assert.equal(room.botCount(), 0);
  room.stop();
});

test("a staked room refuses to create a bot", () => {
  const room = new Room("staked-1", roster(6), () => {}, 0, "staked");
  assert.throws(() => room.addBot(2), /refusing to add a bot/);
  assert.throws(() => room.fillBots(), /refusing to add a bot/);
  assert.equal(room.botCount(), 0);
});

test("a staked room is the default, so forgetting to say is safe", () => {
  const room = new Room("default-1", roster(6), () => {});
  assert.equal(room.kind, "staked");
  assert.throws(() => room.addBot(0), /refusing to add a bot/);
});

test("a free room seats bots, and they do not count as connected players", () => {
  const room = new Room("free-1", roster(6), () => {}, 0, "free");
  room.fillBots();
  assert.equal(room.botCount(), 6);
  assert.equal(room.seatedCount(), 0);
});

test("bot inputs reach the match log through the player input path", () => {
  let finished: { ticks: { inputs: (Input | null)[] }[] } | null = null;
  const room = new Room("free-2", roster(6), (log) => { finished = log; }, 0, "free", true);
  room.start();
  assert.equal(room.botCount(), 6, "bots should fill the room when it starts");

  // Drive the loop by hand rather than waiting 90 seconds of wall clock.
  const tick = (room as unknown as { tick: () => void }).tick.bind(room);
  room.stop();
  for (let i = 0; i < 300; i++) tick();

  const log = (room as unknown as { log: { ticks: { inputs: (Input | null)[] }[] } }).log;
  assert.ok(log.ticks.length >= 300);
  let present = 0;
  for (const t of log.ticks) {
    for (const inp of t.inputs) if (inp) present++;
  }
  assert.ok(present > 1500, `expected bot inputs in the log, found ${present}`);

  // And they are ordinary inputs: nothing in one can assert an outcome.
  const sample = log.ticks[100].inputs.find((i) => i !== null)!;
  assert.deepEqual(
    Object.keys(sample).sort(),
    ["fire", "jump", "moveX", "moveY", "pitch", "reload", "tick", "view", "weapon", "yaw"],
  );
  assert.equal(finished, null);
});

test("a round of bots moves them, kills someone, and stays inside the map", () => {
  const room = new Room("free-3", roster(6), () => {}, 0, "free", true);
  room.start();
  const tick = (room as unknown as { tick: () => void }).tick.bind(room);
  room.stop();

  const start = room.world.players.map((p) => [p.x, p.y, p.z]);
  for (let i = 0; i < 30 * TICK_HZ; i++) tick();

  let moved = 0;
  for (let i = 0; i < 6; i++) {
    const p = room.world.players[i];
    const d = Math.abs(p.x - start[i][0]) + Math.abs(p.z - start[i][2]);
    if (d > 2) moved++;
    assert.ok(!boxBlocked(p.x, p.y, p.z), `bot ${i} ended inside geometry`);
    assert.ok(p.y >= 0 && p.y < GRID_Y, `bot ${i} left the world vertically at ${p.y}`);
    assert.ok(p.hp >= 0 && p.hp <= MAX_HP);
  }
  assert.ok(moved >= 4, `expected most bots to wander, ${moved} did`);

  const shots = room.world.players.reduce((n, p) => n + p.kills, 0);
  assert.ok(shots > 0, "expected the bots to kill each other at least once");
});
