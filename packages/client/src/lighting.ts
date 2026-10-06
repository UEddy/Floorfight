import {
  BAY_X,
  BAY_Z,
  BOOTHS,
  GRID_X,
  GRID_Y,
  GRID_Z,
  LEVEL_GALLERY,
  LEVEL_GROUND,
  LEVEL_STAGE,
  PAVILIONS,
  blockMinX,
  blockMinZ,
  solidAt,
} from "../../shared/map";
import { rayGrid } from "../../shared/sim";

/**
 * Light for the hall, worked out once at load and baked into vertex colours.
 *
 * Two terms. Sky: how much of the glass roof a surface can see, so the
 * aisles under the galleries and the floor under the trusses sit in shade
 * while the open lanes are lit from above. Lanterns: warm points hung round
 * the hall, each lighting what it can see within a few blocks, tested
 * against the block grid with the same ray the server uses for shots, so a
 * booth throws a shadow across the lane behind it.
 *
 * None of this costs anything per frame. A real point light per lantern
 * would be ninety lights in a forward renderer on a phone, which is not a
 * thing a Galaxy S10 does at 60 fps; baked, it is the same single draw call
 * the hall already was.
 */

export interface Lantern {
  x: number; y: number; z: number;
  /** Which way the wall it hangs from is, as a unit step in x or z. */
  wx: number; wz: number;
  /** Brightness multiplier. Footlights are dimmer than hanging lamps. */
  k: number;
}

/** Colour of lantern light, and of the sky through the glass. */
export const WARM: readonly [number, number, number] = [1.0, 0.66, 0.36];
export const SKY: readonly [number, number, number] = [0.66, 0.68, 0.9];
const RADIUS = 7.5;
const SKY_FLOOR = 0.42;

const air = (ix: number, iy: number, iz: number) =>
  ix >= 0 && ix < GRID_X && iz >= 0 && iz < GRID_Z && iy >= 0 && iy < GRID_Y && !solidAt(ix, iy, iz);

function place(): Lantern[] {
  const out: Lantern[] = [];
  /**
   * A lantern in air cell (ix, iy, iz), hanging off the solid cell one step
   * along (wx, wz). Skipped if either half of that is not true, so a change
   * to the map can only lose a lantern, never bury one in a wall.
   */
  const hang = (ix: number, iy: number, iz: number, wx: number, wz: number, h = 0.6, k = 1) => {
    if (!air(ix, iy, iz) || !solidAt(ix + wx, iy, iz + wz)) return;
    out.push({
      x: blockMinX(ix) + 0.5 + wx * 0.28,
      y: iy + h,
      z: blockMinZ(iz) + 0.5 + wz * 0.28,
      wx, wz, k,
    });
  };

  // On the roof pier in the middle of every booth, just above the booth, on
  // the two faces that look down a lane. Alternating which two, so the lanes
  // get light from both directions along their length.
  for (let r = 0; r < BAY_Z.length; r++) {
    for (let c = 0; c < BAY_X.length; c++) {
      const h = BOOTHS[r][c];
      if (h === 0) continue;
      const x = BAY_X[c];
      const z = BAY_Z[r];
      const y = LEVEL_GROUND + h;
      if ((r + c) % 2 === 0) {
        hang(x + 2, y, z, 0, 1);
        hang(x + 2, y, z + 4, 0, -1);
      } else {
        hang(x, y, z + 2, 1, 0);
        hang(x + 4, y, z + 2, -1, 0);
      }
    }
  }

  // Pavilion sides, a lamp in the middle of each face at head height.
  for (const p of PAVILIONS) {
    hang(p.x + 2, 3, p.z - 1, 0, 1, 0.9);
    hang(p.x + 2, 3, p.z + 5, 0, -1, 0.9);
    hang(p.x - 1, 3, p.z + 2, 1, 0, 0.9);
    hang(p.x + 5, 3, p.z + 2, -1, 0, 0.9);
  }

  // Sconces round the perimeter wall: under the galleries, lighting the
  // side aisles, and again on the galleries themselves.
  for (let i = 3; i < GRID_X - 2; i += 5) {
    for (const y of [3, LEVEL_GALLERY + 2]) {
      hang(i, y, 1, 0, -1, 0.3);
      hang(i, y, GRID_Z - 2, 0, 1, 0.3);
      hang(1, y, i, -1, 0, 0.3);
      hang(GRID_X - 2, y, i, 1, 0, 0.3);
    }
  }

  // Footlights along the stage lip, low and dim, facing the hall.
  for (let x = 10; x <= 37; x += 3) hang(x, LEVEL_STAGE, 13, 0, -1, 0.15, 0.55);

  // The clock tower, lit from its four sides at the height of the booths.
  for (const [x, z, wx, wz] of [
    [24, 22, 0, 1], [24, 30, 0, -1], [20, 26, 1, 0], [28, 26, -1, 0],
    [22, 22, 0, 1], [26, 30, 0, -1],
  ] as const) {
    hang(x, 4, z, wx, wz, 0.5);
  }

  return out;
}

export const LANTERNS: readonly Lantern[] = place();

/** Lanterns bucketed on a coarse grid, so a face only checks its neighbours. */
const BUCKET = 8;
const buckets = new Map<number, Lantern[]>();
for (const l of LANTERNS) {
  const bx = Math.floor((l.x + GRID_X / 2) / BUCKET);
  const bz = Math.floor((l.z + GRID_Z / 2) / BUCKET);
  const key = bx * 64 + bz;
  let b = buckets.get(key);
  if (!b) buckets.set(key, (b = []));
  b.push(l);
}

function near(x: number, z: number): Lantern[] {
  const bx = Math.floor((x + GRID_X / 2) / BUCKET);
  const bz = Math.floor((z + GRID_Z / 2) / BUCKET);
  const out: Lantern[] = [];
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const b = buckets.get((bx + i) * 64 + bz + j);
      if (b) out.push(...b);
    }
  }
  return out;
}

/** Up, and four directions tipped towards the roof. */
const SKY_DIRS: readonly [number, number, number][] = [
  [0, 1, 0], [0.5, 0.86, 0], [-0.5, 0.86, 0], [0, 0.86, 0.5], [0, 0.86, -0.5],
];

/** Fraction of the sky visible from a point. */
export function skyAt(x: number, y: number, z: number): number {
  let open = 0;
  for (const [dx, dy, dz] of SKY_DIRS) {
    if (rayGrid(x, y, z, dx, dy, dz, 40) >= 40) open++;
  }
  return open / SKY_DIRS.length;
}

/**
 * The lanterns a face can see, with how squarely it faces each one. Worked
 * out once per face from its centre, then reused for its four corners.
 */
export interface Seen { l: Lantern; facing: number }

export function lanternsSeenFrom(
  cx: number, cy: number, cz: number, nx: number, ny: number, nz: number,
): Seen[] {
  const out: Seen[] = [];
  // Start the ray just off the face, so it does not begin inside its own
  // block.
  const ox = cx + nx * 0.02;
  const oy = cy + ny * 0.02;
  const oz = cz + nz * 0.02;
  for (const l of near(cx, cz)) {
    const dx = l.x - ox;
    const dy = l.y - oy;
    const dz = l.z - oz;
    const d = Math.hypot(dx, dy, dz);
    if (d > RADIUS || d < 1e-3) continue;
    const facing = (dx * nx + dy * ny + dz * nz) / d;
    if (facing <= 0.02) continue;
    // A lantern hangs half inside the cell next to its wall, so stop the
    // test a little short of it.
    if (rayGrid(ox, oy, oz, dx / d, dy / d, dz / d, d - 0.35) < d - 0.35) continue;
    out.push({ l, facing });
  }
  return out;
}

/** Warm light at a point from the lanterns a face can see. */
export function warmAt(x: number, y: number, z: number, seen: readonly Seen[]): number {
  let sum = 0;
  for (const { l, facing } of seen) {
    const d = Math.hypot(l.x - x, l.y - y, l.z - z);
    if (d >= RADIUS) continue;
    const fall = 1 - d / RADIUS;
    sum += l.k * fall * fall * (0.35 + 0.65 * facing) * 1.7;
  }
  return sum;
}

/**
 * Light for something that moves, like a player: sky at that point plus the
 * lanterns it can see, with no particular facing. Cached per cell, because
 * six players asking sixty times a second about the same few cells should
 * not cost sixty ray casts each.
 */
const probeCache = new Map<number, [number, number, number]>();
export function probe(x: number, y: number, z: number): [number, number, number] {
  const ix = Math.floor(x + GRID_X / 2);
  const iy = Math.max(0, Math.min(GRID_Y - 1, Math.floor(y)));
  const iz = Math.floor(z + GRID_Z / 2);
  const key = (iy * GRID_Z + iz) * GRID_X + ix;
  const hit = probeCache.get(key);
  if (hit) return hit;
  const px = blockMinX(ix) + 0.5;
  const py = iy + 0.9;
  const pz = blockMinZ(iz) + 0.5;
  const sky = SKY_FLOOR + (1 - SKY_FLOOR) * skyAt(px, py, pz);
  let warm = 0;
  for (const l of near(px, pz)) {
    const dx = l.x - px, dy = l.y - py, dz = l.z - pz;
    const d = Math.hypot(dx, dy, dz);
    if (d > RADIUS) continue;
    if (rayGrid(px, py, pz, dx / d, dy / d, dz / d, d - 0.35) < d - 0.35) continue;
    const fall = 1 - d / RADIUS;
    warm += l.k * fall * fall;
  }
  const out: [number, number, number] = [
    Math.min(1.3, SKY[0] * sky + WARM[0] * warm),
    Math.min(1.3, SKY[1] * sky + WARM[1] * warm),
    Math.min(1.3, SKY[2] * sky + WARM[2] * warm),
  ];
  probeCache.set(key, out);
  return out;
}

export { SKY_FLOOR };
