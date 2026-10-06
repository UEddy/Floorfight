/**
 * The Hall: the arena, as data.
 *
 * An original reading of a great Victorian exhibition hall, at the scale of
 * an open arena rather than a maze. One long central nave under the glass,
 * wide enough to fight across, with a fountain court in the middle of it.
 * Iron columns march down both sides of the nave and split it from two side
 * aisles: a market of stalls on the west and a glasshouse garden of hedges on
 * the east. A bandstand stands at the north end and a court of great engines
 * at the south. Galleries run along the west, north and east walls on cast
 * iron, reached by six block wide staircases, and the arcades under them are
 * covered walkways the length of the hall.
 *
 * Nothing here is branded. Signs carry invented names only, because the app
 * has to be publishable and because borrowing a real company's name for set
 * dressing is not worth a single argument.
 *
 * One block grid, 1 world unit per block, authored by hand and checked in.
 *
 * Determinism: the ops below are integers, the builder only writes array
 * cells, and nothing here calls Math.random or reads the clock. Two runs of
 * this module produce byte-identical grids, which is what lets a match log
 * replay against the same world the match was played in. MAP_ID travels in
 * the log so a verifier can tell which arena a log belongs to.
 */

import { sha256Hex } from "./sha256";

/* ---------------------------------------------------------------- size --- */

/**
 * 96 by 96 blocks of floor and 24 of height.
 *
 * At 7.4 blocks a second a player crosses the hall in about thirteen seconds
 * and reaches the nearest fight from any spawn in under six, which is the
 * size an open six player arena wants: room to manoeuvre and long lines down
 * the nave, without anyone spending a round looking for somebody to shoot.
 * Twenty four high leaves the galleries a full storey up and room above them
 * for the glass roof to read as a roof.
 */
export const GRID_X = 96;
export const GRID_Y = 24;
export const GRID_Z = 96;

/**
 * World origin sits at the middle of the grid, so the arena is centred on
 * (0, 0) the way the camera and the spawn maths expect. Block ix spans
 * [ix - HALF_X, ix + 1 - HALF_X] on the x axis. Both halves are integers, so
 * block boundaries land on exact world coordinates and a player standing on a
 * block has an exactly integral feet height.
 */
export const HALF_X = GRID_X / 2;
export const HALF_Z = GRID_Z / 2;

/** Walk surfaces, as feet heights. The layout is written in terms of these. */
export const LEVEL_GROUND = 1;
/** The bandstand's platform. */
export const LEVEL_STAGE = 3;
/** The three galleries. */
export const LEVEL_GALLERY = 7;

/** Human readable name. Only ever shown to people. */
export const MAP_NAME = "The Hall";

/* ----------------------------------------------------------- materials --- */

/**
 * Block values. 0 is air. Everything else is solid: the sim only ever asks
 * whether a cell is non-zero, and the value exists so the renderer can pick
 * each material's look.
 */
export const AIR = 0;
export const M_FLOOR = 1;    // board floor
export const M_BRICK = 2;    // perimeter wall, fountain plinth
export const M_BOOTH = 3;    // market stalls
export const M_BOOTH2 = 4;   // market stalls, second tone
export const M_STAIR = 5;    // stairs, deliberately loud
export const M_GALLERY = 6;  // gallery decks
export const M_IRON = 7;     // columns, engines
export const M_STAGE = 8;    // bandstand
export const M_TRIM = 9;     // balustrades, fountain rim, canopy
export const M_CRATE = 10;   // crates, the hall's loose cover
export const M_HEDGE = 11;   // garden hedges and planters
export const MATERIAL_COUNT = 12;

/* ------------------------------------------------------------------ ops --- */

interface Box {
  k: "box";
  x0: number; y0: number; z0: number;
  x1: number; y1: number; z1: number;
  m: number;
}
interface Air {
  k: "air";
  x0: number; y0: number; z0: number;
  x1: number; y1: number; z1: number;
}
interface Stair {
  k: "stair";
  x: number; y: number; z: number;
  w: number; steps: number;
  dir: "+x" | "-x" | "+z" | "-z";
  m: number;
}
type Op = Box | Air | Stair;

/** Inclusive block range, in grid indices. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: number): Box {
  return { k: "box", x0, y0, z0, x1, y1, z1, m };
}
function air(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Air {
  return { k: "air", x0, y0, z0, x1, y1, z1 };
}
/**
 * A run of one block steps climbing away from (x, z).
 *
 * Step i is filled from y up to y + i, so the last step's top is y + steps.
 * `w` is the width across the direction of travel. One block per step is what
 * the sim's step-up resolution expects, which is why every way up in the hall
 * is a staircase rather than a slope: a player walks straight up it.
 */
function stair(
  x: number, y: number, z: number,
  w: number, steps: number, dir: Stair["dir"], m = M_STAIR,
): Stair {
  return { k: "stair", x, y, z, w, steps, dir, m };
}

/** A block of cover standing on the floor: w by d, h high. */
function cover(x: number, z: number, w: number, d: number, h: number, m = M_CRATE, y = LEVEL_GROUND): Box {
  return box(x, y, z, x + w - 1, y + h - 1, z + d - 1, m);
}

/* --------------------------------------------------------------- layout --- */

const G = LEVEL_GROUND;   // 1
const L = LEVEL_GALLERY;  // 7
const TOP = GRID_Y - 1;   // 23
const MAXX = GRID_X - 1;  // 95
const MAXZ = GRID_Z - 1;  // 95

/**
 * The nave columns: 2 by 2 iron, the full height, in two rows down either
 * side of the nave. Ten blocks of open floor between each pair, so they are
 * cover to duck behind rather than a wall, and they frame the lines down the
 * nave instead of cutting them.
 */
export const NAVE_COLUMN_Z: readonly number[] = [12, 24, 36, 48, 60, 72, 84];
export const NAVE_COLUMN_X: readonly number[] = [26, 68];

/**
 * Cast iron columns carrying the gallery decks, on the deck's inner edge. The
 * arcade behind them stays six blocks clear the whole way along.
 */
export const GALLERY_COLUMNS: readonly number[] = [10, 18, 30, 40, 50, 58, 66, 80, 88];

/** The same for the north gallery, along x. */
export const NORTH_GALLERY_COLUMNS: readonly number[] = [16, 30, 62, 78];

/** Market stalls in the west aisle: x, z, height, material. */
export const STALLS: readonly { x: number; z: number; h: number }[] = [
  { x: 14, z: 30, h: 2 }, { x: 14, z: 40, h: 3 }, { x: 14, z: 50, h: 2 }, { x: 14, z: 60, h: 3 },
];
const STALL_W = 3;
const STALL_D = 4;

/** Garden hedges in the east aisle: x, z, length along x. */
export const HEDGES: readonly { x: number; z: number; w: number }[] = [
  { x: 72, z: 32, w: 5 }, { x: 79, z: 40, w: 5 }, { x: 72, z: 48, w: 5 },
  { x: 79, z: 56, w: 5 }, { x: 72, z: 64, w: 5 },
];

/** The fountain at the heart of the nave. */
export const FOUNTAIN = { x0: 40, z0: 40, x1: 55, z1: 55 } as const;

/** The bandstand at the north end of the nave. */
export const BANDSTAND = { x0: 40, z0: 18, x1: 55, z1: 27 } as const;

/** The engine court at the south end. */
export const ENGINES: readonly { x: number; z: number; w: number; d: number; h: number }[] = [
  { x: 32, z: 78, w: 6, d: 6, h: 3 },
  { x: 58, z: 78, w: 6, d: 6, h: 3 },
  { x: 44, z: 86, w: 8, d: 5, h: 4 },
];

/**
 * The combat zones, for the tests and for anyone reading the map: the middle
 * of each, as a cell on the floor (or the bandstand). Every spawn has to have
 * one of these within about six seconds' walk.
 */
export const ZONES: readonly { name: string; x: number; y: number; z: number }[] = [
  { name: "fountain court", x: 47, y: G, z: 37 },
  { name: "bandstand", x: 47, y: 3, z: 22 },
  { name: "engine court", x: 47, y: G, z: 80 },
  { name: "market", x: 19, y: G, z: 46 },
  { name: "garden", x: 77, y: G, z: 48 },
];

function galleries(): Op[] {
  const out: Op[] = [];
  // Decks, one block thick at y 6, so their tops are the gallery level.
  out.push(box(1, L - 1, 1, 7, L - 1, MAXZ - 1, M_GALLERY));          // west
  out.push(box(MAXX - 7, L - 1, 1, MAXX - 1, L - 1, MAXZ - 1, M_GALLERY)); // east
  out.push(box(8, L - 1, 1, MAXX - 8, L - 1, 7, M_GALLERY));           // north
  // Balustrades on the inner edges: one block, so a player can shoot over
  // them and be shot over them, which is the trade a gallery offers.
  out.push(box(7, L, 8, 7, L, MAXZ - 1, M_TRIM));
  out.push(box(MAXX - 7, L, 8, MAXX - 7, L, MAXZ - 1, M_TRIM));
  out.push(box(7, L, 7, MAXX - 7, L, 7, M_TRIM));
  // Every few blocks a taller post in the balustrade, the only cover up
  // there worth the name.
  for (const z of [14, 34, 46, 62, 84]) {
    out.push(box(7, L + 1, z, 7, L + 1, z, M_TRIM));
    out.push(box(MAXX - 7, L + 1, z, MAXX - 7, L + 1, z, M_TRIM));
  }
  for (const x of NORTH_GALLERY_COLUMNS) out.push(box(x, L + 1, 7, x, L + 1, 7, M_TRIM));
  // Columns under the decks' inner edges.
  for (const z of GALLERY_COLUMNS) {
    out.push(box(7, G, z, 7, L - 2, z, M_IRON));
    out.push(box(MAXX - 7, G, z, MAXX - 7, L - 2, z, M_IRON));
  }
  for (const x of NORTH_GALLERY_COLUMNS) out.push(box(x, G, 7, x, L - 2, 7, M_IRON));
  // A few crates on the decks against the back wall, leaving four blocks of
  // walkway past each one.
  for (const z of [24, 54, 76]) {
    out.push(cover(1, z, 2, 3, 2, M_CRATE, L));
    out.push(cover(MAXX - 2, z + 4, 2, 3, 2, M_CRATE, L));
  }
  out.push(cover(38, 1, 3, 2, 2, M_CRATE, L));
  out.push(cover(56, 1, 3, 2, 2, M_CRATE, L));
  return out;
}

function stairs(): Op[] {
  const out: Op[] = [];
  // Six wide, six steps, out into the aisles and climbing towards the wall.
  // The balustrade is opened where each one lands.
  for (const z of [20, 70]) {
    out.push(stair(13, G, z, 6, 6, "-x"));
    out.push(air(7, L, z, 7, L + 1, z + 5));
    out.push(stair(MAXX - 13, G, z, 6, 6, "+x"));
    out.push(air(MAXX - 7, L, z, MAXX - 7, L + 1, z + 5));
  }
  // The north gallery from the nave, behind the bandstand.
  out.push(stair(45, G, 13, 6, 6, "-z"));
  out.push(air(45, L, 7, 50, L + 1, 7));
  return out;
}

function nave(): Op[] {
  const out: Op[] = [];
  for (const x of NAVE_COLUMN_X) {
    for (const z of NAVE_COLUMN_Z) out.push(box(x, G, z, x + 1, TOP, z + 1, M_IRON));
  }

  // The fountain: a low rim you can step over, a pool, and a brick plinth in
  // the middle with a column on it, which is the one piece of hard cover in
  // the open centre of the nave.
  const f = FOUNTAIN;
  out.push(box(f.x0, G, f.z0, f.x1, G, f.z0, M_TRIM));
  out.push(box(f.x0, G, f.z1, f.x1, G, f.z1, M_TRIM));
  out.push(box(f.x0, G, f.z0, f.x0, G, f.z1, M_TRIM));
  out.push(box(f.x1, G, f.z0, f.x1, G, f.z1, M_TRIM));
  out.push(box(f.x0 + 5, G, f.z0 + 5, f.x1 - 5, G + 2, f.z1 - 5, M_BRICK));
  out.push(box(f.x0 + 7, G + 3, f.z0 + 7, f.x1 - 7, G + 6, f.z1 - 7, M_TRIM));

  // Islands of crates down the nave: enough to break up a run across it,
  // spaced so the nave still reads as one open floor.
  for (const [x, z, w, d, h] of [
    [34, 33, 3, 2, 2], [59, 33, 3, 2, 2], [33, 60, 2, 3, 2], [61, 60, 2, 3, 2],
    [46, 63, 4, 2, 2], [36, 12, 2, 2, 2], [58, 12, 2, 2, 2],
  ] as const) {
    out.push(cover(x, z, w, d, h));
  }
  return out;
}

function bandstand(): Op[] {
  const out: Op[] = [];
  const b = BANDSTAND;
  // Two blocks up, so its top is the stage level.
  out.push(box(b.x0, G, b.z0, b.x1, LEVEL_STAGE - 1, b.z1, M_STAGE));
  // Steps on the south and north faces, six wide, and a canopy on four
  // posts high enough to stand under.
  out.push(stair(45, G, b.z1 + 2, 6, 2, "-z"));
  out.push(stair(45, G, b.z0 - 2, 6, 2, "+z"));
  for (const [x, z] of [[b.x0, b.z0], [b.x1, b.z0], [b.x0, b.z1], [b.x1, b.z1]] as const) {
    out.push(box(x, LEVEL_STAGE, z, x, LEVEL_STAGE + 5, z, M_IRON));
  }
  out.push(box(b.x0, LEVEL_STAGE + 6, b.z0, b.x1, LEVEL_STAGE + 6, b.z1, M_TRIM));
  // Music stands, which on a bandstand are the cover.
  out.push(cover(45, 21, 2, 1, 1, M_TRIM, LEVEL_STAGE));
  out.push(cover(49, 24, 2, 1, 1, M_TRIM, LEVEL_STAGE));
  return out;
}

function aisles(): Op[] {
  const out: Op[] = [];
  // West: the market, one row of stalls down the middle of the aisle, with
  // crates between them.
  STALLS.forEach((s, i) => {
    out.push(cover(s.x, s.z, STALL_W, STALL_D, s.h, i % 2 === 0 ? M_BOOTH : M_BOOTH2));
  });
  for (const [x, z] of [[20, 35], [10, 45], [20, 55], [10, 64]] as const) out.push(cover(x, z, 2, 2, 2));
  // East: the garden, hedges staggered across the aisle.
  for (const h of HEDGES) out.push(cover(h.x, h.z, h.w, 2, 2, M_HEDGE));
  for (const [x, z] of [[85, 36], [74, 44], [84, 60]] as const) out.push(cover(x, z, 2, 2, 1, M_HEDGE));
  return out;
}

function engines(): Op[] {
  const out: Op[] = [];
  for (const e of ENGINES) {
    out.push(box(e.x, G, e.z, e.x + e.w - 1, G + e.h - 1, e.z + e.d - 1, M_IRON));
    // A chimney on each, which is what makes them read as engines.
    out.push(box(e.x + 1, G + e.h, e.z + 1, e.x + 2, G + e.h + 3, e.z + 2, M_BRICK));
  }
  for (const [x, z, w, d, h] of [
    [40, 74, 2, 2, 2], [54, 74, 2, 2, 2], [28, 88, 3, 2, 2], [64, 88, 3, 2, 2], [20, 82, 2, 3, 2],
    [74, 82, 2, 3, 2],
  ] as const) {
    out.push(cover(x, z, w, d, h));
  }
  return out;
}

/**
 * Bays along the south wall, between short buttresses. They are where most
 * of the floor level spawns are: off the floor's long lines, a step from the
 * engine court, and walled off from each other.
 */
function southBays(): Op[] {
  const out: Op[] = [];
  for (const x of [12, 24, 36, 59, 71, 83]) out.push(box(x, G, MAXZ - 5, x, G + 3, MAXZ - 1, M_BRICK));
  return out;
}

const OPS: readonly Op[] = [
  /* shell ---------------------------------------------------------------- */
  box(0, 0, 0, MAXX, 0, MAXZ, M_FLOOR),
  // Full height on all four sides. Nothing sees out, nothing shoots out.
  box(0, 1, 0, MAXX, TOP, 0, M_BRICK),
  box(0, 1, MAXZ, MAXX, TOP, MAXZ, M_BRICK),
  box(0, 1, 0, 0, TOP, MAXZ, M_BRICK),
  box(MAXX, 1, 0, MAXX, TOP, MAXZ, M_BRICK),

  ...galleries(),
  ...nave(),
  ...bandstand(),
  ...aisles(),
  ...engines(),
  ...southBays(),
  // Stairs last, so their landings cut through anything above.
  ...stairs(),
];

/* --------------------------------------------------------------- signs --- */

/**
 * Signage. Invented names only: no real conference, company or token
 * branding anywhere in the hall, so nothing here can be mistaken for an
 * endorsement and nothing has to come out before the app is published.
 *
 * Facing is the axis the text reads from: 0 looks towards -z, 1 towards +z,
 * 2 towards -x, 3 towards +x. The renderer draws these as one merged strip
 * off a single atlas texture, so all of them together cost one draw call.
 */
export interface Sign {
  x: number; y: number; z: number;
  w: number;
  facing: 0 | 1 | 2 | 3;
  text: string;
}

export const SIGNS: readonly Sign[] = [
  { x: 14, y: 1, z: 30, w: 3, facing: 0, text: "SILKS" },
  { x: 14, y: 2, z: 40, w: 3, facing: 0, text: "CLOCKS" },
  { x: 14, y: 1, z: 50, w: 3, facing: 0, text: "SPICES" },
  { x: 14, y: 2, z: 60, w: 3, facing: 0, text: "GLASS" },
  { x: 32, y: 2, z: 78, w: 6, facing: 0, text: "STEAM HAMMER" },
  { x: 58, y: 2, z: 78, w: 6, facing: 0, text: "BEAM ENGINE" },
  { x: 44, y: 3, z: 86, w: 8, facing: 0, text: "THE GREAT ENGINE" },
  { x: 40, y: 1, z: 27, w: 16, facing: 1, text: "THE BANDSTAND" },
  { x: 1, y: 10, z: 30, w: 12, facing: 3, text: "WEST GALLERY" },
  { x: 94, y: 10, z: 54, w: 12, facing: 2, text: "EAST GALLERY" },
  { x: 36, y: 10, z: 1, w: 24, facing: 1, text: "THE HALL" },
];

/* -------------------------------------------------------------- build --- */

function clampIndex(v: number, hi: number): number {
  return v < 0 ? 0 : v > hi ? hi : v;
}

function build(): Uint8Array {
  const g = new Uint8Array(GRID_X * GRID_Y * GRID_Z);

  const fill = (
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    m: number,
  ) => {
    const ax = clampIndex(x0, GRID_X - 1), bx = clampIndex(x1, GRID_X - 1);
    const ay = clampIndex(y0, GRID_Y - 1), by = clampIndex(y1, GRID_Y - 1);
    const az = clampIndex(z0, GRID_Z - 1), bz = clampIndex(z1, GRID_Z - 1);
    for (let y = ay; y <= by; y++) {
      for (let z = az; z <= bz; z++) {
        for (let x = ax; x <= bx; x++) g[index(x, y, z)] = m;
      }
    }
  };

  for (const op of OPS) {
    if (op.k === "box") {
      fill(op.x0, op.y0, op.z0, op.x1, op.y1, op.z1, op.m);
    } else if (op.k === "air") {
      fill(op.x0, op.y0, op.z0, op.x1, op.y1, op.z1, AIR);
    } else {
      for (let i = 0; i < op.steps; i++) {
        const hi = op.y + i;
        if (op.dir === "+x") fill(op.x + i, op.y, op.z, op.x + i, hi, op.z + op.w - 1, op.m);
        else if (op.dir === "-x") fill(op.x - i, op.y, op.z, op.x - i, hi, op.z + op.w - 1, op.m);
        else if (op.dir === "+z") fill(op.x, op.y, op.z + i, op.x + op.w - 1, hi, op.z + i, op.m);
        else fill(op.x, op.y, op.z - i, op.x + op.w - 1, hi, op.z - i, op.m);
      }
    }
  }
  return g;
}

/** Row major, x fastest. The renderer walks it in this order too. */
export function index(ix: number, iy: number, iz: number): number {
  return (iy * GRID_Z + iz) * GRID_X + ix;
}

export const GRID: Uint8Array = build();

/**
 * The map id: sha256 of the grid bytes, as hex.
 *
 * Derived rather than written down on purpose. A hand maintained version
 * string is a promise that someone remembers to bump it, and the one time it
 * is forgotten is the time two builds disagree about the world a match was
 * played in while claiming to be the same map. This cannot be forgotten:
 * change one block and the id changes, which is what the match log needs,
 * because the log plus the map is the whole replay.
 */
export const MAP_ID: string = sha256Hex(GRID);

/* ---------------------------------------------------------- accessors --- */

export function inBounds(ix: number, iy: number, iz: number): boolean {
  return ix >= 0 && ix < GRID_X && iy >= 0 && iy < GRID_Y && iz >= 0 && iz < GRID_Z;
}

/** Material at a cell, or M_BRICK outside the grid. */
export function blockAt(ix: number, iy: number, iz: number): number {
  if (!inBounds(ix, iy, iz)) return M_BRICK;
  return GRID[index(ix, iy, iz)];
}

/**
 * Solidity test. Everything outside the grid counts as solid: the perimeter
 * wall already seals the hall, and treating the outside as brick means no
 * collision or ray routine has to carry a special case for leaving the world.
 */
export function solidAt(ix: number, iy: number, iz: number): boolean {
  if (!inBounds(ix, iy, iz)) return true;
  return GRID[index(ix, iy, iz)] !== AIR;
}

/** World coordinate of a block's low edge. */
export function blockMinX(ix: number): number {
  return ix - HALF_X;
}
export function blockMinZ(iz: number): number {
  return iz - HALF_Z;
}

/** Block index containing a world coordinate. */
export function blockIX(x: number): number {
  return Math.floor(x + HALF_X);
}
export function blockIZ(z: number): number {
  return Math.floor(z + HALF_Z);
}

/** Centre of a block column, in world coordinates. */
export function cellCentreX(ix: number): number {
  return ix - HALF_X + 0.5;
}
export function cellCentreZ(iz: number): number {
  return iz - HALF_Z + 0.5;
}

/**
 * Spawn cells, as grid indices: x, feet height, z.
 *
 * Picked by walking the map: every reachable cell out at the edge of the hall
 * with cover close by and a combat zone within about forty blocks' walk, then
 * chosen one at a time, each as far as possible from the ones before and out
 * of sight of all of them. The order is that order, so the first six, which
 * are where a fresh round's seats start, are already spread round the hall.
 */
const SPAWN_CELLS: readonly [number, number, number][] = [
  [42, 1, 94], [78, 1, 1], [1, 7, 23], [94, 7, 62], [1, 1, 69], [39, 7, 3],
  [79, 1, 94], [75, 1, 34], [14, 1, 94], [21, 1, 34], [55, 1, 16], [56, 1, 76],
  [75, 1, 61], [24, 1, 74],
];

/* ------------------------------------------------------------- spawns --- */

/**
 * Fourteen spawns, spread round the hall and over its levels. Each one stands
 * on a surface, has cover within a few blocks, is within about six seconds'
 * walk of a combat zone, and cannot see any other spawn: those are tests in
 * sim.test.ts, so a map edit that breaks one fails loudly. Feet heights are
 * the walk surface, so a spawning player is standing, not falling.
 *
 * Which one a player gets is decided in sim.ts by pickSpawn, away from the
 * living enemies; this list only says where the choices are.
 */
export const SPAWNS: readonly { x: number; y: number; z: number }[] = SPAWN_CELLS.map(
  ([ix, iy, iz]) => ({ x: cellCentreX(ix), y: iy, z: cellCentreZ(iz) }),
);
