/**
 * Deterministic match simulation.
 *
 * The same module runs in three places:
 *   1. the authoritative server, which is the only source of truth
 *   2. the client, for prediction of the local player only
 *   3. a replay verifier, which re-runs a match from its input log
 *
 * Rule that must never be broken: clients send input intents. They never send
 * positions, never send hits, never send scores. If a value can be produced by
 * a phone, it is untrusted.
 *
 * Lag compensation lives inside this file on purpose. The obvious design is to
 * rewind by the connection's measured latency, but latency is not in the match
 * log, so a replay would not reproduce the result and the audit story would be
 * worthless. Instead the client declares which tick it was rendering, the
 * server clamps it to MAX_REWIND, and the clamped value travels in the input.
 * Rewind then reproduces exactly on replay.
 *
 * Determinism notes:
 *   - Only +, -, *, / and comparisons on IEEE-754 doubles.
 *   - Math.sin and Math.cos are not specified to the last bit, so yaw is
 *     quantised to integer units and resolved through a lookup table.
 *   - That table is built with Math.sin at load. Server (Node) and client
 *     (Chromium WebView) are both V8, so they agree. Before anyone verifies a
 *     replay on a non-V8 engine, freeze the table to a checked-in binary.
 *   - Pitch still uses Math.sin and Math.cos directly. It only affects the ray
 *     direction and both ends run V8. If that stops being true, quantise pitch
 *     the same way as yaw.
 *   - The world is a fixed block grid built from integers (see map.ts), and
 *     every routine here reads it with floors and comparisons only. Gravity,
 *     jumping, collision and hitscan are all plain arithmetic: no trig was
 *     added for any of them.
 *   - No Date.now, no Math.random, no iteration over object keys.
 */

import {
  GRID_Y,
  HALF_X,
  HALF_Z,
  SPAWNS,
  solidAt,
} from "./map";

export {
  GRID_X, GRID_Y, GRID_Z, HALF_X, HALF_Z, MAP_ID, SPAWNS,
  LEVEL_GROUND, LEVEL_STAGE, LEVEL_GALLERY, LEVEL_GIRDER,
  blockAt, solidAt, cellCentreX, cellCentreZ,
} from "./map";

export const TICK_HZ = 60;
export const TICK_MS = 1000 / TICK_HZ;
export const SNAPSHOT_EVERY = 3; // 20 Hz on the wire

export const PLAYER_SPEED = 7.4;
export const PLAYER_RADIUS = 0.45;
export const EYE_HEIGHT = 1.7;

export const BODY_HALF_X = 0.42;
export const BODY_HALF_Z = 0.42;
export const BODY_TOP = 1.42;
export const HEAD_BOTTOM = 1.42;
export const HEAD_TOP = 1.92;
export const HEAD_HALF = 0.3;

/** Collision height. The drawn head is the top of it, so cover is honest. */
export const PLAYER_HEIGHT = HEAD_TOP;

/* ------------------------------------------------------------- motion --- */

/**
 * Vertical motion, in units per second and units per second squared.
 *
 * Tuned together, not independently. Peak jump height is
 * JUMP_SPEED squared over twice GRAVITY, which is 1.33 blocks: enough to
 * clear a one block ledge and nowhere near a two block one. That single
 * number decides the whole map's vertical grammar, which is why every route
 * between levels in The Hall is a staircase and no level can be reached by
 * jumping at a wall.
 */
export const GRAVITY = 24;
export const JUMP_SPEED = 8;
export const TERMINAL_FALL = 40;

/**
 * How high a blocked move may climb by itself. One block, because every stair
 * and ramp in the map is built from one block steps. Without this a player
 * would have to jump up every single step.
 */
export const STEP_HEIGHT = 1;

/**
 * Slack for the standing test. An exact power of two so it is exact in binary
 * and the test cannot disagree between two engines by one ulp.
 */
export const GROUND_EPS = 1 / 64;

export const WEAPON_RANGE = 90;
export const FIRE_COOLDOWN = 8; // ticks, about 133 ms
export const MAX_HP = 100;
export const DAMAGE_BODY = 34;
export const DAMAGE_HEAD = 100;
export const RESPAWN_TICKS = 90;
export const ROUND_TICKS = 90 * TICK_HZ;

export const MAX_REWIND = 15;     // ticks, 250 ms
export const HISTORY_TICKS = 20;  // ring size, must exceed MAX_REWIND

export const YAW_UNITS = 8192;
export const PITCH_LIMIT = 1.45;

/* ---------------------------------------------------------------- trig --- */

const SIN = new Float64Array(YAW_UNITS);
for (let i = 0; i < YAW_UNITS; i++) {
  SIN[i] = Math.sin((i / YAW_UNITS) * Math.PI * 2);
}

export function sinU(u: number): number {
  return SIN[(((u | 0) % YAW_UNITS) + YAW_UNITS) % YAW_UNITS];
}
export function cosU(u: number): number {
  return sinU((u | 0) + (YAW_UNITS >> 2));
}
export function yawToRadians(u: number): number {
  return (u / YAW_UNITS) * Math.PI * 2;
}

/* --------------------------------------------------------------- state --- */

export interface PlayerState {
  id: number;
  x: number;
  y: number;   // feet height
  z: number;
  vy: number;  // vertical velocity, units per second
  yaw: number;   // integer units
  pitch: number; // radians, clamped
  hp: number;
  kills: number;
  deaths: number;
  alive: boolean;
  respawnAt: number;
  lastFireTick: number;
  lastInputTick: number;
}

/** Positions as they stood at the end of one tick. Used only for rewind. */
export interface HistFrame {
  tick: number;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  alive: Uint8Array;
}

export interface WorldState {
  tick: number;
  players: PlayerState[];  // stable order, indexed by slot
  history: HistFrame[];    // ring of HISTORY_TICKS, indexed tick % HISTORY_TICKS
}

export interface Input {
  tick: number;  // the tick this input is meant for
  view: number;  // the tick the client was rendering when it fired
  moveX: number; // -127..127, strafe
  moveY: number; // -127..127, forward positive
  yaw: number;   // 0..YAW_UNITS-1
  pitch: number; // -32767..32767 mapped to +/- PITCH_LIMIT
  fire: 0 | 1;
  jump: 0 | 1;
}

export interface HitEvent {
  tick: number;
  shooter: number;
  victim: number;
  head: boolean;
  lethal: boolean;
  rewind: number; // ticks the server rewound, after clamping
}

export function newPlayer(id: number, slot: number): PlayerState {
  const s = SPAWNS[slot % SPAWNS.length];
  return {
    id, x: s.x, y: s.y, z: s.z, vy: 0, yaw: 0, pitch: 0,
    hp: MAX_HP, kills: 0, deaths: 0, alive: true,
    respawnAt: 0, lastFireTick: -999, lastInputTick: -1,
  };
}

export function createWorld(slots: number): WorldState {
  const players: PlayerState[] = [];
  for (let i = 0; i < slots; i++) players.push(newPlayer(i, i));

  const history: HistFrame[] = [];
  for (let i = 0; i < HISTORY_TICKS; i++) {
    history.push({
      tick: -1,
      x: new Float64Array(slots),
      y: new Float64Array(slots),
      z: new Float64Array(slots),
      alive: new Uint8Array(slots),
    });
  }
  return { tick: 0, players, history };
}

/* ----------------------------------------------------------- collision --- */

/**
 * Does the player's box at this position overlap any solid block?
 *
 * The box is treated as open at its high faces: a face sitting exactly on a
 * block boundary does not count the block beyond it. That is what lets a
 * player stand at an exactly integral height on top of a block without
 * colliding with the block they are standing on, and it is why every surface
 * height in the map is an integer.
 */
export function boxBlocked(x: number, y: number, z: number): boolean {
  const ax = Math.floor(x - PLAYER_RADIUS + HALF_X);
  const bx = Math.ceil(x + PLAYER_RADIUS + HALF_X) - 1;
  const az = Math.floor(z - PLAYER_RADIUS + HALF_Z);
  const bz = Math.ceil(z + PLAYER_RADIUS + HALF_Z) - 1;
  const ay = Math.floor(y);
  const by = Math.ceil(y + PLAYER_HEIGHT) - 1;
  for (let iy = ay; iy <= by; iy++) {
    for (let iz = az; iz <= bz; iz++) {
      for (let ix = ax; ix <= bx; ix++) {
        if (solidAt(ix, iy, iz)) return true;
      }
    }
  }
  return false;
}

/**
 * Height of the highest block top at or below `feetY` under the player's
 * footprint. This is where a falling player lands.
 *
 * Returns 0 if there is nothing, which cannot happen in practice: the map has
 * a solid plate at the bottom and everything outside the grid counts as
 * solid, so there is no hole to fall through.
 */
export function supportTop(x: number, z: number, feetY: number): number {
  const ax = Math.floor(x - PLAYER_RADIUS + HALF_X);
  const bx = Math.ceil(x + PLAYER_RADIUS + HALF_X) - 1;
  const az = Math.floor(z - PLAYER_RADIUS + HALF_Z);
  const bz = Math.ceil(z + PLAYER_RADIUS + HALF_Z) - 1;
  let top = 0;
  for (let iz = az; iz <= bz; iz++) {
    for (let ix = ax; ix <= bx; ix++) {
      for (let iy = Math.ceil(feetY) - 1; iy >= 0; iy--) {
        if (iy + 1 > feetY) continue;
        if (!solidAt(ix, iy, iz)) continue;
        if (iy + 1 > top) top = iy + 1;
        break;
      }
    }
  }
  return top;
}

/** Standing on something solid, within a sliver of slack. */
export function onGround(x: number, y: number, z: number): boolean {
  return y - supportTop(x, z, y) <= GROUND_EPS;
}

/**
 * Move horizontally, resolving against the grid. Returns true if the move
 * climbed a step.
 *
 * Called once per axis so that a player pressing into a wall at an angle
 * slides along it instead of stopping dead. Resolving both axes at once would
 * also mean a corner could reject a move that is legal on one axis.
 */
function moveAxis(p: PlayerState, dx: number, dz: number, mayStep: boolean): boolean {
  const nx = p.x + dx;
  const nz = p.z + dz;
  if (!boxBlocked(nx, p.y, nz)) {
    p.x = nx;
    p.z = nz;
    return false;
  }
  if (!mayStep) return false;

  // Stairs and ramps are built from one block steps, so a blocked move is
  // retried one block higher. Only from the ground: allowing it in mid-air
  // would let a player climb a flat wall by jumping into it repeatedly.
  //
  // The lift is exactly STEP_HEIGHT rather than a measured contact height
  // because the only thing that can have blocked the move is a block whose
  // top is one unit above the feet. Gravity settles the player onto it on the
  // same tick, so the result is exact.
  const up = p.y + STEP_HEIGHT;
  if (boxBlocked(nx, up, nz)) return false;
  p.x = nx;
  p.z = nz;
  p.y = up;
  return true;
}

/**
 * Distance along a ray to the first solid block, or maxT if it reaches that
 * far. Standard voxel traversal: step to whichever axis boundary is nearest,
 * test the cell, repeat.
 *
 * A ray starting inside a solid block returns 0, so a shot that somehow
 * originates in geometry hits that geometry rather than passing through it.
 */
export function rayGrid(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxT: number,
): number {
  const gx = ox + HALF_X;
  const gz = oz + HALF_Z;
  let ix = Math.floor(gx);
  let iy = Math.floor(oy);
  let iz = Math.floor(gz);
  if (solidAt(ix, iy, iz)) return 0;

  const sx = dx > 0 ? 1 : -1;
  const sy = dy > 0 ? 1 : -1;
  const sz = dz > 0 ? 1 : -1;

  // Distance to cross one whole cell, and to reach the first boundary. A zero
  // component never crosses a boundary on that axis, which Infinity expresses
  // exactly under IEEE-754, so no special case is needed in the loop.
  const tdx = dx === 0 ? Infinity : (dx > 0 ? 1 / dx : -1 / dx);
  const tdy = dy === 0 ? Infinity : (dy > 0 ? 1 / dy : -1 / dy);
  const tdz = dz === 0 ? Infinity : (dz > 0 ? 1 / dz : -1 / dz);
  let tx = dx === 0 ? Infinity : ((dx > 0 ? ix + 1 : ix) - gx) / dx;
  let ty = dy === 0 ? Infinity : ((dy > 0 ? iy + 1 : iy) - oy) / dy;
  let tz = dz === 0 ? Infinity : ((dz > 0 ? iz + 1 : iz) - gz) / dz;

  for (;;) {
    let t: number;
    if (tx <= ty && tx <= tz) { ix += sx; t = tx; tx += tdx; }
    else if (ty <= tz) { iy += sy; t = ty; ty += tdy; }
    else { iz += sz; t = tz; tz += tdz; }

    if (t > maxT) return maxT;
    // Leaving the grid vertically is not solid at the top: a shot fired up
    // out of the hall simply misses. Everything else outside the grid is
    // solid, which solidAt already handles.
    if (iy >= GRID_Y) return maxT;
    if (solidAt(ix, iy, iz)) return t;
  }
}

/** Slab test against one axis aligned box. Returns distance, or -1. */
function rayBox(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
): number {
  let tmin = 0;
  let tmax = WEAPON_RANGE;

  if (dx === 0) { if (ox < minX || ox > maxX) return -1; }
  else {
    const inv = 1 / dx;
    let t1 = (minX - ox) * inv, t2 = (maxX - ox) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  if (dy === 0) { if (oy < minY || oy > maxY) return -1; }
  else {
    const inv = 1 / dy;
    let t1 = (minY - oy) * inv, t2 = (maxY - oy) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  if (dz === 0) { if (oz < minZ || oz > maxZ) return -1; }
  else {
    const inv = 1 / dz;
    let t1 = (minZ - oz) * inv, t2 = (maxZ - oz) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin;
}

/**
 * Resolve one shot against a historical frame.
 *
 * Only victims are rewound. The shooter fires from where they are now, because
 * they were never wrong about their own position. This asymmetry is what makes
 * "I shot them, they were right there" agree with what the server decides.
 *
 * The world is checked first, and a body only counts if it is nearer than the
 * first block the ray meets. Walls, booths, stage fronts, girders and the
 * floor itself all stop a shot that way, including a shot aimed down through
 * a gallery deck at someone underneath it.
 */
export function hitscanFrame(
  frame: HistFrame,
  shooterSlot: number,
  ox: number,
  oy: number,
  oz: number,
  yaw: number,
  pitch: number,
): { victimSlot: number; head: boolean; dist: number } | null {
  const cp = Math.cos(pitch);
  const dx = -sinU(yaw) * cp;
  const dy = Math.sin(pitch);
  const dz = -cosU(yaw) * cp;

  // World geometry is static, so cover is checked against the live grid.
  const wall = rayGrid(ox, oy, oz, dx, dy, dz, WEAPON_RANGE);

  let best: { victimSlot: number; head: boolean; dist: number } | null = null;
  for (let i = 0; i < frame.alive.length; i++) {
    if (i === shooterSlot || !frame.alive[i]) continue;
    const px = frame.x[i];
    const py = frame.y[i];
    const pz = frame.z[i];

    const dHead = rayBox(ox, oy, oz, dx, dy, dz,
      px - HEAD_HALF, py + HEAD_BOTTOM, pz - HEAD_HALF,
      px + HEAD_HALF, py + HEAD_TOP, pz + HEAD_HALF);
    const dBody = rayBox(ox, oy, oz, dx, dy, dz,
      px - BODY_HALF_X, py, pz - BODY_HALF_Z,
      px + BODY_HALF_X, py + BODY_TOP, pz + BODY_HALF_Z);

    let d = -1;
    let head = false;
    if (dHead >= 0 && (dBody < 0 || dHead <= dBody)) { d = dHead; head = true; }
    else if (dBody >= 0) { d = dBody; }

    if (d >= 0 && d < wall && (best === null || d < best.dist)) {
      best = { victimSlot: i, head, dist: d };
    }
  }
  return best;
}

function record(world: WorldState): void {
  const f = world.history[world.tick % HISTORY_TICKS];
  f.tick = world.tick;
  for (let i = 0; i < world.players.length; i++) {
    const p = world.players[i];
    f.x[i] = p.x;
    f.y[i] = p.y;
    f.z[i] = p.z;
    f.alive[i] = p.alive ? 1 : 0;
  }
}

function frameAt(world: WorldState, tick: number): HistFrame {
  const f = world.history[((tick % HISTORY_TICKS) + HISTORY_TICKS) % HISTORY_TICKS];
  // A ring slot holding a different tick means the request fell outside the
  // window. Fall back to the current frame rather than trusting stale data.
  return f.tick === tick ? f : world.history[world.tick % HISTORY_TICKS];
}

/* ---------------------------------------------------------------- step --- */

/**
 * Advance the world exactly one tick.
 *
 * `inputs` is indexed by slot. A missing input means the player sent nothing
 * for this tick and is treated as no movement, no jump and no fire. Dropped
 * input is the client's problem, never a licence for the server to invent
 * motion. Gravity is not input, so it still applies: a player whose
 * connection stalls in mid-air falls rather than hanging there.
 */
export function step(
  world: WorldState,
  inputs: (Input | null)[],
  hits: HitEvent[],
): void {
  const tick = world.tick;
  const dt = 1 / TICK_HZ;

  for (let slot = 0; slot < world.players.length; slot++) {
    const p = world.players[slot];
    if (!p) continue;

    if (!p.alive) {
      if (tick >= p.respawnAt) {
        const s = SPAWNS[(slot + p.deaths) % SPAWNS.length];
        p.x = s.x; p.y = s.y; p.z = s.z; p.vy = 0;
        p.hp = MAX_HP; p.alive = true;
      }
      continue;
    }

    const inp = inputs[slot];
    let ax = 0;
    let ay = 0;
    let wantJump = false;

    if (inp) {
      // Sanitise. Out of range means a malformed or hostile client.
      const mx = clamp(inp.moveX, -127, 127) / 127;
      const my = clamp(inp.moveY, -127, 127) / 127;
      p.yaw = (((inp.yaw | 0) % YAW_UNITS) + YAW_UNITS) % YAW_UNITS;
      p.pitch = clamp((inp.pitch / 32767) * PITCH_LIMIT, -PITCH_LIMIT, PITCH_LIMIT);
      p.lastInputTick = inp.tick;
      wantJump = inp.jump === 1;

      // Diagonal input must not beat straight input.
      const mag = Math.sqrt(mx * mx + my * my);
      ax = mx;
      ay = my;
      if (mag > 1) { ax = mx / mag; ay = my / mag; }
    }

    const ground = onGround(p.x, p.y, p.z);
    if (ground) {
      if (p.vy < 0) p.vy = 0;
      // Jump only from the ground. A held jump bit therefore hops on landing
      // rather than flying, and a client that sets it every tick gains
      // nothing over one that sets it once.
      if (wantJump) p.vy = JUMP_SPEED;
    }

    const s = sinU(p.yaw);
    const c = cosU(p.yaw);
    const vx = (c * ax - s * ay) * PLAYER_SPEED * dt;
    const vz = (-s * ax - c * ay) * PLAYER_SPEED * dt;

    // One step up per tick at most, whichever axis earns it.
    let stepped = false;
    if (vx !== 0) stepped = moveAxis(p, vx, 0, ground);
    if (vz !== 0) moveAxis(p, 0, vz, ground && !stepped);

    p.vy -= GRAVITY * dt;
    if (p.vy < -TERMINAL_FALL) p.vy = -TERMINAL_FALL;
    const ny = p.y + p.vy * dt;
    if (p.vy <= 0) {
      const top = supportTop(p.x, p.z, p.y);
      if (ny <= top) { p.y = top; p.vy = 0; }
      else p.y = ny;
    } else if (boxBlocked(p.x, ny, p.z)) {
      // Head into a girder. Lose the climb and stay put: one tick of missing
      // rise is invisible, where an approximated contact height would be a
      // non-integral standing height and would spoil the step-up maths.
      p.vy = 0;
    } else {
      p.y = ny;
    }
  }

  // Positions for this tick are final. Record before any shot resolves, so a
  // shot that rewinds zero ticks sees the state the shooter is looking at.
  record(world);

  // Firing resolves in a second pass, so slot order cannot buy an advantage.
  for (let slot = 0; slot < world.players.length; slot++) {
    const p = world.players[slot];
    const inp = inputs[slot];
    if (!p || !p.alive || !inp || !inp.fire) continue;
    if (tick - p.lastFireTick < FIRE_COOLDOWN) continue;
    p.lastFireTick = tick;

    const view = clamp(inp.view | 0, tick - MAX_REWIND, tick);
    const rewind = tick - view;
    const hit = hitscanFrame(
      frameAt(world, view), slot, p.x, p.y + EYE_HEIGHT, p.z, p.yaw, p.pitch,
    );
    if (!hit) continue;

    const victim = world.players[hit.victimSlot];
    // The victim may have died between the rewound frame and now. A shot into
    // the past does not kill someone twice.
    if (!victim.alive) continue;

    victim.hp -= hit.head ? DAMAGE_HEAD : DAMAGE_BODY;

    const lethal = victim.hp <= 0;
    if (lethal) {
      victim.alive = false;
      victim.hp = 0;
      victim.deaths++;
      victim.respawnAt = tick + RESPAWN_TICKS;
      p.kills++;
    }
    hits.push({
      tick, shooter: slot, victim: hit.victimSlot,
      head: hit.head, lethal, rewind,
    });
  }

  world.tick = tick + 1;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
