import {
  BANDSTAND,
  ENGINES,
  FOUNTAIN,
  GALLERY_COLUMNS,
  GRID_X,
  GRID_Y,
  GRID_Z,
  LEVEL_GALLERY,
  LEVEL_GROUND,
  LEVEL_STAGE,
  NAVE_COLUMN_X,
  NAVE_COLUMN_Z,
  NORTH_GALLERY_COLUMNS,
  STALLS,
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
 * column throws a shadow across the floor behind it.
 *
 * None of this costs anything per frame. A real point light per lantern
 * would be hundreds of lights in a forward renderer on a phone, which is not a
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
  /** A lamp on each face of a w by d footprint, at height y. */
  const ring = (x: number, z: number, w: number, d: number, y: number, h = 0.6, k = 1) => {
    const mx = x + (w >> 1);
    const mz = z + (d >> 1);
    hang(mx, y, z - 1, 0, 1, h, k);
    hang(mx, y, z + d, 0, -1, h, k);
    hang(x - 1, y, mz, 1, 0, h, k);
    hang(x + w, y, mz, -1, 0, h, k);
  };

  // The nave columns, a lamp on every face above head height, so the nave
  // floor is lit in pools between them and the columns read down its length.
  for (const x of NAVE_COLUMN_X) {
    for (const z of NAVE_COLUMN_Z) ring(x, z, 2, 2, 4);
  }

  // The gallery columns, on both faces: one into the nave, one into the
  // arcade under the deck, which has no sky to speak of.
  for (const z of GALLERY_COLUMNS) {
    hang(8, 3, z, -1, 0);
    hang(6, 3, z, 1, 0);
    hang(GRID_X - 7, 3, z, 1, 0);
    hang(GRID_X - 9, 3, z, -1, 0);
  }
  for (const x of NORTH_GALLERY_COLUMNS) {
    hang(x, 3, 8, 0, -1);
    hang(x, 3, 6, 0, 1);
  }

  // Sconces round the perimeter wall: in the arcades, and again on the
  // galleries themselves.
  for (let i = 3; i < GRID_X - 2; i += 6) {
    for (const y of [3, LEVEL_GALLERY + 2]) {
      hang(i, y, 1, 0, -1, 0.3);
      hang(i, y, GRID_Z - 2, 0, 1, 0.3);
      hang(1, y, i, -1, 0, 0.3);
      hang(GRID_X - 2, y, i, 1, 0, 0.3);
    }
  }

  // The bandstand: lamps on the inside of its canopy posts.
  const b = BANDSTAND;
  for (const [x, z, wx, wz] of [
    [b.x0 + 1, b.z0, -1, 0], [b.x1 - 1, b.z0, 1, 0], [b.x0 + 1, b.z1, -1, 0], [b.x1 - 1, b.z1, 1, 0],
  ] as const) {
    hang(x, LEVEL_STAGE + 3, z, wx, wz, 0.5);
  }

  // Market stalls, the engines and the fountain plinth, each lit from its
  // sides, low and a little dim, like lamps on a counter.
  for (const s of STALLS) ring(s.x, s.z, 3, 4, LEVEL_GROUND + s.h - 1, 0.4, 0.8);
  for (const e of ENGINES) ring(e.x, e.z, e.w, e.d, LEVEL_GROUND + 1, 0.6, 0.9);
  const f = FOUNTAIN;
  ring(f.x0 + 5, f.z0 + 5, f.x1 - f.x0 - 9, f.z1 - f.z0 - 9, LEVEL_GROUND + 2, 0.4, 0.9);

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
