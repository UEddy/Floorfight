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
 * Determinism notes:
 *   - Only +, -, *, / and comparisons on IEEE-754 doubles. These are exact and
 *     identical across engines.
 *   - Math.sin and Math.cos are NOT specified to the last bit, so all angles are
 *     quantised to integer units and resolved through a lookup table.
 *   - The table itself is built with Math.sin at module load. Server (Node) and
 *     client (Chromium WebView) are both V8, so they agree today. Before anyone
 *     verifies a replay on a non-V8 engine, freeze this table to a checked-in
 *     binary asset.
 *   - No Date.now, no Math.random, no iteration over object keys.
 */

export const TICK_HZ = 60;
export const TICK_MS = 1000 / TICK_HZ;
export const SNAPSHOT_EVERY = 3; // 20 Hz on the wire

export const ARENA_HALF = 30;
export const PLAYER_SPEED = 7.4; // units per second
export const PLAYER_RADIUS = 0.45;
export const EYE_HEIGHT = 1.7;

export const BODY_HALF_X = 0.42;
export const BODY_HALF_Z = 0.42;
export const BODY_TOP = 1.42;
export const HEAD_BOTTOM = 1.42;
export const HEAD_TOP = 1.92;
export const HEAD_HALF = 0.3;

export const WEAPON_RANGE = 90;
export const FIRE_COOLDOWN = 8; // ticks, about 133 ms
export const MAX_HP = 100;
export const DAMAGE_BODY = 34;
export const DAMAGE_HEAD = 100;
export const RESPAWN_TICKS = 90;
export const ROUND_TICKS = 90 * TICK_HZ;

export const YAW_UNITS = 8192; // quantisation of a full turn
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

/* ----------------------------------------------------------------- map --- */

export interface Box {
  x: number;
  z: number;
  hx: number;
  hz: number;
  top: number;
}

/** Seeded LCG. Only ever used at load time to build the static map. */
function makeMap(seed: number): Box[] {
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const out: Box[] = [];
  for (let i = 0; i < 34; i++) {
    const sx = 2 + rnd() * 4;
    const sy = 1.6 + rnd() * 3.4;
    const sz = 2 + rnd() * 4;
    let px = (rnd() - 0.5) * (ARENA_HALF * 1.8);
    let pz = (rnd() - 0.5) * (ARENA_HALF * 1.8);
    if (Math.abs(px) < 5 && Math.abs(pz) < 5) pz += 9;
    out.push({ x: px, z: pz, hx: sx / 2, hz: sz / 2, top: sy });
  }
  return out;
}

export const MAP_SEED = 1337;
export const CRATES: readonly Box[] = makeMap(MAP_SEED);

export const SPAWNS: readonly { x: number; z: number }[] = [
  { x: -22, z: -22 }, { x: 22, z: -22 }, { x: -22, z: 22 },
  { x: 22, z: 22 }, { x: 0, z: -25 }, { x: 0, z: 25 },
  { x: -25, z: 0 }, { x: 25, z: 0 },
];

/* --------------------------------------------------------------- state --- */

export interface PlayerState {
  id: number;
  x: number;
  z: number;
  yaw: number;   // integer, 0..YAW_UNITS
  pitch: number; // radians, clamped
  hp: number;
  kills: number;
  deaths: number;
  alive: boolean;
  respawnAt: number;
  lastFireTick: number;
  lastInputTick: number;
}

export interface WorldState {
  tick: number;
  players: PlayerState[]; // stable order, indexed by slot
}

export interface Input {
  tick: number;
  moveX: number; // -127..127, strafe
  moveY: number; // -127..127, forward positive
  yaw: number;   // 0..YAW_UNITS-1
  pitch: number; // -32767..32767 mapped to +/- PITCH_LIMIT
  fire: 0 | 1;
}

export interface HitEvent {
  tick: number;
  shooter: number;
  victim: number;
  head: boolean;
  lethal: boolean;
}

export function newPlayer(id: number, slot: number): PlayerState {
  const s = SPAWNS[slot % SPAWNS.length];
  return {
    id, x: s.x, z: s.z, yaw: 0, pitch: 0,
    hp: MAX_HP, kills: 0, deaths: 0, alive: true,
    respawnAt: 0, lastFireTick: -999, lastInputTick: -1,
  };
}

/* ----------------------------------------------------------- collision --- */

export function blocked(x: number, z: number, r: number): boolean {
  if (x > ARENA_HALF - 1.2 || x < -(ARENA_HALF - 1.2)) return true;
  if (z > ARENA_HALF - 1.2 || z < -(ARENA_HALF - 1.2)) return true;
  for (let i = 0; i < CRATES.length; i++) {
    const c = CRATES[i];
    const dx = x - c.x;
    const dz = z - c.z;
    if ((dx < 0 ? -dx : dx) < c.hx + r && (dz < 0 ? -dz : dz) < c.hz + r) return true;
  }
  return false;
}

/** Slab test. Returns distance along the ray, or -1. */
function rayBox(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
): number {
  let tmin = 0;
  let tmax = WEAPON_RANGE;

  // x
  if (dx === 0) { if (ox < minX || ox > maxX) return -1; }
  else {
    const inv = 1 / dx;
    let t1 = (minX - ox) * inv;
    let t2 = (maxX - ox) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  // y
  if (dy === 0) { if (oy < minY || oy > maxY) return -1; }
  else {
    const inv = 1 / dy;
    let t1 = (minY - oy) * inv;
    let t2 = (maxY - oy) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  // z
  if (dz === 0) { if (oz < minZ || oz > maxZ) return -1; }
  else {
    const inv = 1 / dz;
    let t1 = (minZ - oz) * inv;
    let t2 = (maxZ - oz) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin;
}

/**
 * Resolve one shot against a given world snapshot.
 *
 * Called by the server twice: once against the live world, and once against a
 * rewound snapshot for lag compensation. Never called with client-supplied
 * geometry.
 */
export function hitscan(
  world: WorldState,
  shooterSlot: number,
  yaw: number,
  pitch: number,
): { victimSlot: number; head: boolean; dist: number } | null {
  const shooter = world.players[shooterSlot];
  if (!shooter || !shooter.alive) return null;

  const cp = Math.cos(pitch);
  const dx = -sinU(yaw) * cp;
  const dy = Math.sin(pitch);
  const dz = -cosU(yaw) * cp;

  const ox = shooter.x;
  const oy = EYE_HEIGHT;
  const oz = shooter.z;

  // nearest wall or crate first, so cover actually works
  let wall = WEAPON_RANGE;
  for (let i = 0; i < CRATES.length; i++) {
    const c = CRATES[i];
    const d = rayBox(ox, oy, oz, dx, dy, dz,
      c.x - c.hx, 0, c.z - c.hz, c.x + c.hx, c.top, c.z + c.hz);
    if (d >= 0 && d < wall) wall = d;
  }

  let best: { victimSlot: number; head: boolean; dist: number } | null = null;
  for (let i = 0; i < world.players.length; i++) {
    if (i === shooterSlot) continue;
    const p = world.players[i];
    if (!p || !p.alive) continue;

    const dHead = rayBox(ox, oy, oz, dx, dy, dz,
      p.x - HEAD_HALF, HEAD_BOTTOM, p.z - HEAD_HALF,
      p.x + HEAD_HALF, HEAD_TOP, p.z + HEAD_HALF);
    const dBody = rayBox(ox, oy, oz, dx, dy, dz,
      p.x - BODY_HALF_X, 0, p.z - BODY_HALF_Z,
      p.x + BODY_HALF_X, BODY_TOP, p.z + BODY_HALF_Z);

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

/* ---------------------------------------------------------------- step --- */

/**
 * Advance the world exactly one tick.
 *
 * `inputs` is indexed by slot. A missing input means the player sent nothing
 * for this tick, which is treated as "no movement, no fire" rather than as a
 * reason to extrapolate. Dropping input is the client's problem, not a licence
 * for the server to invent motion.
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
        p.x = s.x; p.z = s.z; p.hp = MAX_HP; p.alive = true;
      }
      continue;
    }

    const inp = inputs[slot];
    if (!inp) continue;

    // Sanitise. Anything out of range is a malformed or hostile client.
    const mx = clamp(inp.moveX, -127, 127) / 127;
    const my = clamp(inp.moveY, -127, 127) / 127;
    p.yaw = ((inp.yaw | 0) % YAW_UNITS + YAW_UNITS) % YAW_UNITS;
    p.pitch = clamp((inp.pitch / 32767) * PITCH_LIMIT, -PITCH_LIMIT, PITCH_LIMIT);
    p.lastInputTick = inp.tick;

    // Magnitude clamp: diagonal input cannot beat straight input.
    let mag = Math.sqrt(mx * mx + my * my);
    let ax = mx, ay = my;
    if (mag > 1) { ax = mx / mag; ay = my / mag; }

    const s = sinU(p.yaw);
    const c = cosU(p.yaw);
    const vx = (c * ax - s * ay) * PLAYER_SPEED * dt;
    const vz = (-s * ax - c * ay) * PLAYER_SPEED * dt;

    if (!blocked(p.x + vx, p.z, PLAYER_RADIUS)) p.x += vx;
    if (!blocked(p.x, p.z + vz, PLAYER_RADIUS)) p.z += vz;
  }

  // Firing resolves after all movement so ordering cannot be gamed by slot.
  for (let slot = 0; slot < world.players.length; slot++) {
    const p = world.players[slot];
    const inp = inputs[slot];
    if (!p || !p.alive || !inp || !inp.fire) continue;
    if (tick - p.lastFireTick < FIRE_COOLDOWN) continue;
    p.lastFireTick = tick;

    const hit = hitscan(world, slot, p.yaw, p.pitch);
    if (!hit) continue;

    const victim = world.players[hit.victimSlot];
    const dmg = hit.head ? DAMAGE_HEAD : DAMAGE_BODY;
    victim.hp -= dmg;

    const lethal = victim.hp <= 0;
    if (lethal) {
      victim.alive = false;
      victim.hp = 0;
      victim.deaths++;
      victim.respawnAt = tick + RESPAWN_TICKS;
      p.kills++;
    }
    hits.push({ tick, shooter: slot, victim: hit.victimSlot, head: hit.head, lethal });
  }

  world.tick = tick + 1;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
