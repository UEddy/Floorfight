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
  RESPAWN_TICKS,
  ROUND_TICKS,
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
import {
  FREE_SALT, FREE_SALT_BYTES, SWITCH_TICKS, WEAPONS, WEAPON_COUNT,
  W_PISTOL, W_RIFLE, W_SHOTGUN, saltSeeds, spreadHash,
} from "../../shared/weapons";
import { GRID, MAP_ID, MAP_NAME } from "../../shared/map";
import { fromHex, sha256Hex, toHex } from "../../shared/sha256";
import { REPLAY_SEED, REPLAY_TICKS, runMatch } from "./replay";
import { Room } from "../src/room";
import type { MatchLog, RosterEntry } from "../../shared/protocol";

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
  run(w, 0, input({ yaw: toward, fire: 1 }), 1, hits);
  assert.ok(victim.hp < before, "expected a hit down an open aisle");
  assert.ok(hits.length > 0, "and a hit event for it");

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
  run(w2, 0, input({ yaw: YAW_UNITS / 4, fire: 1 }), 20, hits);
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

test("a head shot with the pistol kills outright, a body shot does not", () => {
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

/**
 * The sightline budget, in blocks.
 *
 * The design target is twenty. The limit is twenty two because the galleries
 * are deliberately the long sightline level: they are a thin walkway with a
 * balustrade you can shoot over, no cover to speak of, and the longest lines
 * in the building run along them and across the stage from them. That is what
 * they are for. Anyone standing there trades cover for a view, and the eleven
 * lines in the hall that exceed twenty are all theirs.
 *
 * The floor, the stage and the roof route all come in well under twenty. If a
 * map edit pushes the worst line past this, the fix is geometry, not a bigger
 * number here.
 */
const SIGHTLINE_LIMIT = 22;

test("no open sightline runs much past twenty blocks", () => {
  // Measured from every cell a player can actually stand in and reach, in 32
  // horizontal directions at eye height. Unreachable perches are excluded
  // because nobody can shoot from one.
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
  assert.ok(
    worst <= SIGHTLINE_LIMIT,
    `longest sightline is ${worst.toFixed(1)} blocks from ${where}`,
  );
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

/** Put two players nose to nose in the open pocket on the stage. */
function duel(): ReturnType<typeof createWorld> {
  const w = createWorld(2);
  const s = w.players[0];
  const v = w.players[1];
  s.x = cellCentreX(22);
  s.z = cellCentreZ(10);
  s.y = LEVEL_STAGE;
  v.x = cellCentreX(22);
  v.z = cellCentreZ(12);
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
  p.x = cellCentreX(22);
  p.z = cellCentreZ(10);
  p.y = LEVEL_STAGE;
  w.players[1].x = cellCentreX(22);
  w.players[1].z = cellCentreZ(12);
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
