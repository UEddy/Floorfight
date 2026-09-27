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
 *   - No Date.now, no Math.random, no iteration over object keys.
 */

export const TICK_HZ = 60;
export const TICK_MS = 1000 / TICK_HZ;
export const SNAPSHOT_EVERY = 3; // 20 Hz on the wire

export const ARENA_HALF = 30;
export const PLAYER_SPEED = 7.4;
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

/* ----------------------------------------------------------------- map --- */

export interface Box {
  x: number; z: number; hx: number; hz: number; top: number;
}

export const SPAWNS: readonly { x: number; z: number }[] = [
  { x: -22, z: -22 }, { x: 22, z: -22 }, { x: -22, z: 22 },
  { x: 22, z: 22 }, { x: 0, z: -25 }, { x: 0, z: 25 },
  { x: -25, z: 0 }, { x: 25, z: 0 },
];

/** Open ground kept around every spawn, measured from the spawn point. */
const SPAWN_CLEARANCE = 2;

function makeMap(seed: number): Box[] {
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const out: Box[] = [];
  while (out.length < 34) {
    const sx = 2 + rnd() * 4;
    const sy = 1.6 + rnd() * 3.4;
    const sz = 2 + rnd() * 4;
    const px = (rnd() - 0.5) * (ARENA_HALF * 1.8);
    let pz = (rnd() - 0.5) * (ARENA_HALF * 1.8);
    if (Math.abs(px) < 5 && Math.abs(pz) < 5) pz += 9;
    // A crate over a spawn traps whoever spawns there: they cannot move, and
    // a ray that starts inside a box hits the box, so they can neither shoot
    // nor be shot. Reject and draw again rather than trusting the seed.
    // Rejection only consumes more of the same deterministic stream, so the
    // map is still a pure function of the seed.
    const hx = sx / 2;
    const hz = sz / 2;
    let clear = true;
    for (let i = 0; i < SPAWNS.length; i++) {
      const sp = SPAWNS[i];
      const dx = px - sp.x;
      const dz = pz - sp.z;
      if ((dx < 0 ? -dx : dx) < hx + SPAWN_CLEARANCE && (dz < 0 ? -dz : dz) < hz + SPAWN_CLEARANCE) {
        clear = false;
        break;
      }
    }
    if (!clear) continue;
    out.push({ x: px, z: pz, hx, hz, top: sy });
  }
  return out;
}

export const MAP_SEED = 1337;
export const CRATES: readonly Box[] = makeMap(MAP_SEED);

/* --------------------------------------------------------------- state --- */

export interface PlayerState {
  id: number;
  x: number;
  z: number;
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
    id, x: s.x, z: s.z, yaw: 0, pitch: 0,
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
      z: new Float64Array(slots),
      alive: new Uint8Array(slots),
    });
  }
  return { tick: 0, players, history };
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
 */
export function hitscanFrame(
  frame: HistFrame,
  shooterSlot: number,
  ox: number,
  oz: number,
  yaw: number,
  pitch: number,
): { victimSlot: number; head: boolean; dist: number } | null {
  const cp = Math.cos(pitch);
  const dx = -sinU(yaw) * cp;
  const dy = Math.sin(pitch);
  const dz = -cosU(yaw) * cp;
  const oy = EYE_HEIGHT;

  // World geometry is static, so cover is checked against the live map.
  let wall = WEAPON_RANGE;
  for (let i = 0; i < CRATES.length; i++) {
    const c = CRATES[i];
    const d = rayBox(ox, oy, oz, dx, dy, dz,
      c.x - c.hx, 0, c.z - c.hz, c.x + c.hx, c.top, c.z + c.hz);
    if (d >= 0 && d < wall) wall = d;
  }

  let best: { victimSlot: number; head: boolean; dist: number } | null = null;
  for (let i = 0; i < frame.alive.length; i++) {
    if (i === shooterSlot || !frame.alive[i]) continue;
    const px = frame.x[i];
    const pz = frame.z[i];

    const dHead = rayBox(ox, oy, oz, dx, dy, dz,
      px - HEAD_HALF, HEAD_BOTTOM, pz - HEAD_HALF,
      px + HEAD_HALF, HEAD_TOP, pz + HEAD_HALF);
    const dBody = rayBox(ox, oy, oz, dx, dy, dz,
      px - BODY_HALF_X, 0, pz - BODY_HALF_Z,
      px + BODY_HALF_X, BODY_TOP, pz + BODY_HALF_Z);

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
 * for this tick and is treated as no movement and no fire. Dropped input is
 * the client's problem, never a licence for the server to invent motion.
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

    // Sanitise. Out of range means a malformed or hostile client.
    const mx = clamp(inp.moveX, -127, 127) / 127;
    const my = clamp(inp.moveY, -127, 127) / 127;
    p.yaw = (((inp.yaw | 0) % YAW_UNITS) + YAW_UNITS) % YAW_UNITS;
    p.pitch = clamp((inp.pitch / 32767) * PITCH_LIMIT, -PITCH_LIMIT, PITCH_LIMIT);
    p.lastInputTick = inp.tick;

    // Diagonal input must not beat straight input.
    const mag = Math.sqrt(mx * mx + my * my);
    let ax = mx, ay = my;
    if (mag > 1) { ax = mx / mag; ay = my / mag; }

    const s = sinU(p.yaw);
    const c = cosU(p.yaw);
    const vx = (c * ax - s * ay) * PLAYER_SPEED * dt;
    const vz = (-s * ax - c * ay) * PLAYER_SPEED * dt;

    if (!blocked(p.x + vx, p.z, PLAYER_RADIUS)) p.x += vx;
    if (!blocked(p.x, p.z + vz, PLAYER_RADIUS)) p.z += vz;
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
    const hit = hitscanFrame(frameAt(world, view), slot, p.x, p.z, p.yaw, p.pitch);
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
