// Simulation, map and bot tests.
//
// The replay determinism check is the one that matters most: the match log is
// the audit artifact, and a log that does not reproduce the match is worse
// than no log at all, because it looks like evidence.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  EYE_HEIGHT,
  GRAVITY,
  GRID_X,
  GRID_Y,
  GRID_Z,
  JUMP_SPEED,
  LEVEL_GALLERY,
  LEVEL_GIRDER,
  LEVEL_GROUND,
  LEVEL_STAGE,
  MAX_HP,
  PLAYER_HEIGHT,
  SPAWNS,
  TICK_HZ,
  YAW_UNITS,
  boxBlocked,
  cellCentreX,
  cellCentreZ,
  createWorld,
  onGround,
  rayGrid,
  solidAt,
  step,
  supportTop,
  type HitEvent,
  type Input,
} from "../../shared/sim";
import { REPLAY_SEED, REPLAY_TICKS, runMatch } from "./replay";
import { Room } from "../src/room";
import type { RosterEntry } from "../../shared/protocol";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------ helpers --- */

function input(over: Partial<Input> = {}): Input {
  return {
    tick: 0, view: 0, moveX: 0, moveY: 0, yaw: 0, pitch: 0, fire: 0, jump: 0, ...over,
  };
}

/** Advance one player for n ticks with a fixed input. */
function run(world: ReturnType<typeof createWorld>, slot: number, inp: Input, n: number): void {
  const hits: HitEvent[] = [];
  for (let i = 0; i < n; i++) {
    const inputs: (Input | null)[] = new Array(world.players.length).fill(null);
    inputs[slot] = { ...inp, tick: world.tick };
    step(world, inputs, hits);
  }
}

function roster(n: number): RosterEntry[] {
  const out: RosterEntry[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ slot: i, wallet: `w${i}`, collection: null, mint: null });
  }
  return out;
}

const cellKey = (x: number, y: number, z: number) => (y * GRID_Z + z) * GRID_X + x;

/**
 * Cells a player can stand in and get to on foot from the given starts.
 *
 * Walk, climb one block, or fall any distance: exactly the moves sim.step
 * allows without jumping. Used by the map tests so that neither the sightline
 * budget nor the reachability check counts a perch nobody can occupy.
 */
function reachable(starts: readonly { x: number; y: number; z: number }[]): Set<number> {
  const standable = (ix: number, iy: number, iz: number) =>
    solidAt(ix, iy - 1, iz) && !solidAt(ix, iy, iz) &&
    !solidAt(ix, iy + Math.ceil(PLAYER_HEIGHT) - 1, iz);

  const seen = new Set<number>();
  const queue: [number, number, number][] = [];
  for (const s of starts) {
    const c: [number, number, number] = [
      Math.floor(s.x + GRID_X / 2), s.y, Math.floor(s.z + GRID_Z / 2),
    ];
    seen.add(cellKey(...c));
    queue.push(c);
  }
  while (queue.length > 0) {
    const [x, y, z] = queue.pop()!;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
      for (let ny = y + 1; ny >= 1; ny--) {
        if (ny >= GRID_Y - 1) continue;
        if (!standable(x + dx, ny, z + dz)) continue;
        const k = cellKey(x + dx, ny, z + dz);
        if (!seen.has(k)) { seen.add(k); queue.push([x + dx, ny, z + dz]); }
        break;
      }
    }
  }
  return seen;
}

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
  // A stage lip is two blocks above the floor. The stair beside it is two
  // separate one block steps, which is the difference the map relies on.
  const w = createWorld(1);
  const p = w.players[0];

  // Stand in the lane in front of the middle stage bay and walk north into
  // its step run, which climbs the two block stage lip one block at a time.
  p.x = cellCentreX(22);
  p.z = cellCentreZ(19);
  p.y = LEVEL_GROUND;
  p.vy = 0;
  // Yaw 0 looks along -z, so this walks north up the lane into the steps.
  run(w, 0, input({ moveY: 127, yaw: 0 }), 180);
  assert.equal(p.y, LEVEL_STAGE, `expected to be on the stage at ${LEVEL_STAGE}, got ${p.y}`);
});

test("supportTop and onGround agree with the grid", () => {
  for (const s of SPAWNS) {
    assert.equal(supportTop(s.x, s.z, s.y), s.y, "spawn should rest exactly on its surface");
    assert.ok(onGround(s.x, s.y, s.z));
    assert.ok(!boxBlocked(s.x, s.y, s.z), "spawn should not be inside a block");
  }
});

/* ----------------------------------------------------------- hitscan --- */

test("a ray stops at the first solid block", () => {
  // Straight down from a spawn hits the floor it is standing on.
  const s = SPAWNS[0];
  const d = rayGrid(s.x, s.y + EYE_HEIGHT, s.z, 0, -1, 0, 90);
  assert.ok(Math.abs(d - EYE_HEIGHT) < 1e-9, `expected ${EYE_HEIGHT}, got ${d}`);
});

test("a ray fired up through the open roof hits nothing", () => {
  // Over the hall floor between the stage and the first booth row there is no
  // roof structure, so a shot straight up leaves the world.
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

  // Three blocks apart in the open pocket on the stage: the shot lands.
  shooter.x = cellCentreX(22);
  shooter.z = cellCentreZ(10);
  shooter.y = LEVEL_STAGE;
  victim.x = cellCentreX(22);
  victim.z = cellCentreZ(13);
  victim.y = LEVEL_STAGE;
  // Yaw 0 looks along -z, so looking at +z is half a turn.
  const toward = YAW_UNITS / 2;
  run(w, 0, input({ yaw: toward }), 1); // record a history frame
  const before = victim.hp;
  run(w, 0, input({ yaw: toward, fire: 1 }), 1);
  assert.ok(victim.hp < before, "expected a hit down an open aisle");
  assert.ok(hits.length >= 0);

  // Now put a booth between them. Shooting through it must not land.
  const w2 = createWorld(2);
  const s2 = w2.players[0];
  const v2 = w2.players[1];
  s2.x = cellCentreX(6);
  s2.z = cellCentreZ(20);
  s2.y = LEVEL_GROUND;
  // Across the hall: there are booths, piers and trusses in between.
  v2.x = cellCentreX(41);
  v2.z = cellCentreZ(20);
  v2.y = LEVEL_GROUND;
  const hp2 = v2.hp;
  run(w2, 0, input({ yaw: YAW_UNITS / 4 }), 1);
  run(w2, 0, input({ yaw: YAW_UNITS / 4, fire: 1 }), 20);
  assert.equal(v2.hp, hp2, "a shot across the hall should be stopped by cover");
});

test("a shot at someone on the floor below is stopped by the gallery deck", () => {
  const w = createWorld(2);
  const up = w.players[0];
  const down = w.players[1];

  // Gallery above the west aisle, and someone directly underneath it.
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

test("a head shot kills outright and a body shot does not", () => {
  const w = createWorld(2);
  const s = w.players[0];
  const v = w.players[1];
  s.x = cellCentreX(22);
  s.z = cellCentreZ(10);
  s.y = LEVEL_STAGE;
  v.x = cellCentreX(22);
  v.z = cellCentreZ(13);
  v.y = LEVEL_STAGE;

  const hits: HitEvent[] = [];
  const inputs: (Input | null)[] = [input({ yaw: YAW_UNITS / 2 }), null];
  step(w, inputs, hits);
  // Eyes are at head height and both players stand on the same surface, so a
  // level shot is a head shot.
  step(w, [input({ tick: 1, view: 1, yaw: YAW_UNITS / 2, fire: 1 }), null], hits);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].head, true);
  assert.equal(hits[0].lethal, true);
  assert.equal(v.hp, 0);
  assert.equal(v.alive, false);
  assert.equal(s.kills, 1);
});

/* --------------------------------------------------------------- map --- */

test("every spawn is standable, spread over the levels, and under cover", () => {
  assert.equal(SPAWNS.length, 6);
  const levels = new Set(SPAWNS.map((s) => s.y));
  assert.ok(levels.size >= 3, `spawns should span at least three levels, got ${[...levels]}`);
  assert.ok(levels.has(LEVEL_GROUND));
  assert.ok(levels.has(LEVEL_GALLERY));
  assert.ok(levels.has(LEVEL_GIRDER) || levels.has(LEVEL_STAGE));

  for (const s of SPAWNS) {
    const ix = Math.floor(s.x + GRID_X / 2);
    const iz = Math.floor(s.z + GRID_Z / 2);
    assert.ok(solidAt(ix, s.y - 1, iz), "nothing to stand on");
    assert.ok(!boxBlocked(s.x, s.y, s.z), "inside a block");
    // Cover within a few blocks in at least one direction, so a spawn is not
    // in the open on a map this dense.
    let nearest = Infinity;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const d = rayGrid(s.x, s.y + EYE_HEIGHT, s.z, Math.sin(a), 0, Math.cos(a), 40);
      if (d < nearest) nearest = d;
    }
    assert.ok(nearest < 5, `spawn at ${s.x},${s.z} has no cover within 5 blocks`);
  }
});

test("no open sightline runs much past twenty blocks", () => {
  // The design rule for The Hall. Measured from every cell a player can
  // actually stand in and reach, in 32 horizontal directions at eye height.
  // Unreachable perches are excluded because nobody can shoot from one.
  const seen = reachable(SPAWNS);

  const dirs: [number, number][] = [];
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    dirs.push([Math.sin(a), Math.cos(a)]);
  }

  let worst = 0;
  let where = "";
  for (const k of seen) {
    const ix = k % GRID_X;
    const iz = Math.floor(k / GRID_X) % GRID_Z;
    const iy = Math.floor(k / (GRID_X * GRID_Z));
    for (const [dx, dz] of dirs) {
      const d = rayGrid(cellCentreX(ix), iy + EYE_HEIGHT, cellCentreZ(iz), dx, 0, dz, 70);
      if (d > worst) { worst = d; where = `(${ix},${iy},${iz})`; }
    }
  }
  assert.ok(worst <= 22, `longest sightline is ${worst.toFixed(1)} blocks from ${where}`);
});

test("every level and the roof route are reachable on foot from the floor", () => {
  // Walk and one block climbs only, from a ground spawn. No jumping, which is
  // the conservative set: if the galleries and the catwalks are reachable
  // without it, they are reachable.
  const reach = reachable([SPAWNS[0]]);
  const counts = new Map<number, number>();
  for (const k of reach) {
    const iy = Math.floor(k / (GRID_X * GRID_Z));
    counts.set(iy, (counts.get(iy) ?? 0) + 1);
  }
  for (const level of [LEVEL_GROUND, LEVEL_STAGE, LEVEL_GALLERY, LEVEL_GIRDER]) {
    assert.ok((counts.get(level) ?? 0) > 20, `level ${level} barely reachable: ${counts.get(level)}`);
  }
  // And every spawn, since a player respawning into a sealed pocket is stuck
  // there for the rest of the round.
  for (const s of SPAWNS) {
    const k = cellKey(Math.floor(s.x + GRID_X / 2), s.y, Math.floor(s.z + GRID_Z / 2));
    assert.ok(reach.has(k), `spawn at ${s.x},${s.y},${s.z} is cut off from the floor`);
  }
});

/* -------------------------------------------------------------- rooms --- */

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
    ["fire", "jump", "moveX", "moveY", "pitch", "tick", "view", "yaw"],
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
