/**
 * The Hall: the arena, as data.
 *
 * A blocky reading of a large Victorian exhibition hall. Ground floor is a
 * grid of expo booths of varying heights, so the floor is a maze of narrow
 * lanes with cover in every one of them. A raised main stage fills the north
 * end under a balcony. Galleries run the full way around all four walls,
 * reached by stairs in the four corners. Above everything, iron roof girders
 * link four pavilion tops: the shortest way across the hall and the one with
 * nothing to hide behind.
 *
 * Nothing here is branded. Booth signs carry invented names only, because the
 * app has to be publishable and because borrowing a real company's name for
 * set dressing is not worth a single argument.
 *
 * One block grid, 1 world unit per block, authored by hand and checked in. It
 * replaces the seeded crate scatter that came before it. A seeded map was
 * reproducible but could not be designed, and sightlines, cover and the route
 * between levels are the whole game.
 *
 * Determinism: the ops below are integers, the builder only writes array
 * cells, and nothing here calls Math.random or reads the clock. Two runs of
 * this module produce byte-identical grids, which is what lets a match log
 * replay against the same world the match was played in. MAP_ID travels in
 * the log so a verifier can tell which arena a log belongs to.
 */

import { sha256Hex } from "./sha256";

/* ---------------------------------------------------------------- size --- */

export const GRID_X = 48;
export const GRID_Y = 17;
export const GRID_Z = 48;

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
export const LEVEL_STAGE = 3;
export const LEVEL_GALLERY = 7;
export const LEVEL_GIRDER = 11;

/** Human readable name. Only ever shown to people. */
export const MAP_NAME = "The Hall";

/* ----------------------------------------------------------- materials --- */

/**
 * Block values. 0 is air. Everything else is solid: the sim only ever asks
 * whether a cell is non-zero, and the value exists so the renderer can draw
 * each material as one merged mesh, one draw call.
 */
export const AIR = 0;
export const M_FLOOR = 1;    // board floor
export const M_BRICK = 2;    // perimeter wall
export const M_BOOTH = 3;    // booth stalls
export const M_BOOTH2 = 4;   // booth stalls, second tone
export const M_STAIR = 5;    // stairs and ramps, deliberately loud
export const M_GALLERY = 6;  // gallery decks and bridges
export const M_IRON = 7;     // girders, trusses, pavilion tops
export const M_STAGE = 8;    // stage platform and organ case
export const M_TRIM = 9;     // balustrades, parapets, clock faces
export const MATERIAL_COUNT = 10;

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
 * A run of one-block steps climbing away from (x, z).
 *
 * Step i is filled from y up to y + i, so the last step's top is y + steps.
 * `w` is the width across the direction of travel. One block per step is what
 * the sim's step-up resolution expects, which is why every ramp in the hall is
 * a staircase rather than a slope.
 */
function stair(
  x: number, y: number, z: number,
  w: number, steps: number, dir: Stair["dir"], m = M_STAIR,
): Stair {
  return { k: "stair", x, y, z, w, steps, dir, m };
}

/** Low cover: two blocks is enough to break a standing player's sightline. */
function stall(x: number, z: number, w = 2, d = 2, h = 2, y = LEVEL_GROUND, m = M_BOOTH): Box {
  return box(x, y, z, x + w - 1, y + h - 1, z + d - 1, m);
}

/* --------------------------------------------------------------- layout --- */

const G = LEVEL_GROUND;   // 1
const S = LEVEL_STAGE;    // 3
const L = LEVEL_GALLERY;  // 7
const R = LEVEL_GIRDER;   // 11
const TOP = GRID_Y - 1;   // 16

/**
 * Booth grid. Five bays across, four deep, on a seven block pitch: a five
 * block booth and a two block lane. Values are booth heights in blocks, so
 * the floor reads as a city of stalls of different sizes rather than a flat
 * field of identical crates. 0 leaves the bay to a pavilion or to the clock
 * tower.
 *
 * The grid stops short of all four walls. The strips it leaves are the side
 * aisles, under the galleries, and they carry their own stalls further down.
 */
const BAY_X: readonly number[] = [9, 16, 23, 30, 37];
const BAY_Z: readonly number[] = [16, 23, 30, 37];
const BOOTHS: readonly (readonly number[])[] = [
  [0, 2, 4, 0, 3],
  [2, 3, 0, 2, 4],
  [0, 4, 0, 0, 2],
  [4, 2, 3, 4, 3],
];

/** Pavilions: tall booths whose roofs carry the girders. */
const PAVILIONS: readonly { x: number; z: number }[] = [
  { x: 9, z: 16 }, { x: 30, z: 16 }, { x: 9, z: 30 }, { x: 30, z: 30 },
];

/**
 * Lane crossings closed by a stall, as a three by four grid over the gaps
 * between bays. Closing them in a staggered pattern keeps every lane short
 * without cutting the floor into disconnected pockets.
 */
const CROSSINGS: readonly (readonly number[])[] = [
  [1, 0, 1, 0],
  [0, 1, 0, 1],
  [1, 0, 1, 0],
];

function booths(): Op[] {
  const out: Op[] = [];
  for (let r = 0; r < BAY_Z.length; r++) {
    for (let c = 0; c < BAY_X.length; c++) {
      const h = BOOTHS[r][c];
      if (h === 0) continue;
      const x = BAY_X[c];
      const z = BAY_Z[r];
      out.push(box(x, G, z, x + 4, G + h - 1, z + 4, (r + c) % 2 === 0 ? M_BOOTH : M_BOOTH2));
      // One of the hall's roof piers stands in the middle of every bay. They
      // run the full height of the grid, which is the whole point: a pier
      // that stopped short of the roof would leave a lane open above it, and
      // a column that reaches the roof has no standable top for anyone to
      // shoot from. The booth is built around its pier, and the girders
      // overhead thread between them.
      out.push(box(x + 1, G, z + 1, x + 3, TOP, z + 3, M_IRON));
    }
  }
  for (let r = 0; r < CROSSINGS.length; r++) {
    for (let c = 0; c < CROSSINGS[r].length; c++) {
      if (!CROSSINGS[r][c]) continue;
      out.push(stall(BAY_X[c] + 5, BAY_Z[r] + 5, 2, 2, 3, G, M_BOOTH2));
    }
  }
  return out;
}

/** The four pavilion masses, their girder pads and their truss webs. */
function pavilions(): Op[] {
  const out: Op[] = [];
  for (const p of PAVILIONS) {
    const x0 = p.x, x1 = p.x + 4;
    const z0 = p.z, z1 = p.z + 4;
    out.push(box(x0, G, z0, x1, R - 2, z1, M_BOOTH2));
    out.push(box(x0, R - 1, z0, x1, R - 1, z1, M_IRON));
    // Truss webs on the two faces that point at a wall. They terminate the
    // sightline along the girder that lands there and double as the only
    // fall protection on the roof. The two faces that point into the hall
    // are deliberately open ledges.
    const west = p.x < GRID_X / 2;
    const north = p.z < GRID_Z / 2;
    out.push(box(west ? x0 : x1, R, z0, west ? x0 : x1, R + 2, z1, M_IRON));
    out.push(box(x0, R, north ? z0 : z1, x1, R + 2, north ? z0 : z1, M_IRON));
  }
  return out;
}

/**
 * The roof route: two catwalks, one over each of the outer booth rows,
 * linking the pavilion roofs across the hall.
 *
 * Each one zigzags between the roof piers rather than running straight, and
 * that is not decoration. A straight girder from one pavilion to the other
 * would be a twenty six block sightline with no cover on it at any point,
 * which is exactly the firing lane the rest of the hall is built to avoid.
 * Threaded between the piers, no leg of the walk is open for more than about
 * fourteen blocks, and crossing from one side of the hall to the other means
 * stepping into the open four separate times.
 *
 * Each cell listed here is carved clear to head height and then floored, so
 * the route is continuous by construction, through piers and trusses
 * included. The hole a girder leaves in a pier is how a girder meets a
 * column anyway.
 */
const CATWALK: readonly { x0: number; z0: number; x1: number; z1: number }[] = [
  // North catwalk, over the booth row at z 16 to 20.
  { x0: 14, z0: 20, x1: 16, z1: 20 },
  { x0: 16, z0: 16, x1: 16, z1: 20 },
  { x0: 17, z0: 16, x1: 23, z1: 16 },
  { x0: 23, z0: 16, x1: 23, z1: 20 },
  { x0: 24, z0: 20, x1: 29, z1: 20 },
  // South catwalk, over the booth row at z 30 to 34.
  { x0: 14, z0: 30, x1: 16, z1: 30 },
  { x0: 16, z0: 30, x1: 16, z1: 34 },
  { x0: 17, z0: 34, x1: 23, z1: 34 },
  { x0: 23, z0: 30, x1: 23, z1: 34 },
  { x0: 24, z0: 30, x1: 29, z1: 30 },
];

function catwalks(): Op[] {
  const out: Op[] = [];
  for (const c of CATWALK) {
    out.push(air(c.x0, R, c.z0, c.x1, R + 1, c.z1));
    out.push(box(c.x0, R - 1, c.z0, c.x1, R - 1, c.z1, M_IRON));
  }
  return out;
}

/**
 * Gallery piers: one block deep, blocking two of the gallery's three walking
 * cells and leaving the third open.
 *
 * The open cell is never the middle one, and it alternates between the inner
 * and the outer lane along the run. That is what bounds the sightline: a shot
 * angled across the gallery has to cross the middle lane and is stopped by
 * the first pier it meets, and a shot straight down either outer lane is
 * stopped by the next pier that opens the other side. The positions are
 * listed rather than spaced evenly because they have to miss the four
 * stairwells, the two bridges and the trusses.
 */
const PIERS_NS: readonly number[] = [7, 11, 18, 22, 25, 32, 36, 40];
const PIERS_WE: readonly number[] = [5, 12, 16, 22, 25, 29, 35, 42];

function galleryPiers(): Op[] {
  const out: Op[] = [];
  let cycle = 0;
  const run = (at: (i: number, cell: number) => [number, number], list: readonly number[]) => {
    for (const i of list) {
      const open = (cycle++ % 2) * 2;
      for (let cell = 0; cell < 3; cell++) {
        if (cell === open) continue;
        const [x, z] = at(i, cell);
        out.push(box(x, L, z, x, L + 3, z, M_TRIM));
      }
    }
  };
  run((i, cell) => [i, 1 + cell], PIERS_NS);
  run((i, cell) => [i, 46 - cell], PIERS_NS);
  run((i, cell) => [1 + cell, i], PIERS_WE);
  run((i, cell) => [46 - cell, i], PIERS_WE);
  return out;
}

/**
 * The hall. Order matters: later ops overwrite earlier ones, which is how
 * doorways are cut into walls, how the galleries are opened over their
 * stairwells and how the catwalks are carved through the roof structure.
 */
const OPS: readonly Op[] = [
  /* shell ---------------------------------------------------------------- */

  box(0, 0, 0, GRID_X - 1, 0, GRID_Z - 1, M_FLOOR),
  // Full height on all four sides. Nothing sees out, nothing shoots out, and
  // the roof route cannot be left over the top of the wall.
  box(0, 1, 0, GRID_X - 1, TOP, 0, M_BRICK),
  box(0, 1, GRID_Z - 1, GRID_X - 1, TOP, GRID_Z - 1, M_BRICK),
  box(0, 1, 0, 0, TOP, GRID_Z - 1, M_BRICK),
  box(GRID_X - 1, 1, 0, GRID_X - 1, TOP, GRID_Z - 1, M_BRICK),

  /* booths and pavilions ------------------------------------------------- */

  ...booths(),
  ...pavilions(),

  /* side aisle stalls ---------------------------------------------------- */

  // The aisles under the galleries would otherwise be four clear runs the
  // length of the hall. Each stall here spans most of its aisle and the gap
  // it leaves alternates from one side to the other, so no straight channel
  // survives more than about twenty blocks.
  stall(1, 13, 6, 2, 4), stall(3, 17, 6, 2, 4, G, M_BOOTH2),
  stall(1, 22, 6, 2, 4), stall(3, 28, 6, 2, 4, G, M_BOOTH2),
  stall(1, 32, 6, 2, 4), stall(3, 37, 6, 2, 4, G, M_BOOTH2),
  stall(42, 13, 6, 2, 4), stall(40, 17, 6, 2, 4, G, M_BOOTH2),
  stall(42, 22, 6, 2, 4), stall(40, 28, 6, 2, 4, G, M_BOOTH2),
  stall(42, 32, 6, 2, 4), stall(40, 37, 6, 2, 4, G, M_BOOTH2),
  stall(13, 42, 2, 5, 4), stall(18, 40, 2, 7, 4, G, M_BOOTH2),
  stall(24, 42, 2, 5, 4), stall(30, 40, 2, 7, 4, G, M_BOOTH2),
  stall(36, 42, 2, 5, 4),
  stall(6, 6, 2, 3, 4, G, M_BOOTH2), stall(42, 6, 2, 3, 4, G, M_BOOTH2),

  /* the stage ------------------------------------------------------------ */

  // Two blocks up, filling the north end. The north gallery runs above its
  // back as a balcony, and the front is open to the hall, so the stage is
  // fought over from three sides at once.
  box(9, G, 1, 38, S - 1, 14, M_STAGE),
  // One step run per stage bay, in the one block lane in front of the stage.
  // They cannot reach back to z 16: that is the first booth row.
  stair(10, G, 15, 3, 2, "-z"),
  stair(22, G, 15, 3, 2, "-z"),
  stair(33, G, 15, 3, 2, "-z"),
  // The organ case. A tall mass at the north end, and the single most useful
  // piece of geometry in the hall for cutting lines down its length.
  box(20, S, 6, 27, 13, 9, M_STAGE),
  box(21, 13, 7, 26, 13, 8, M_TRIM),
  // Podiums at the stage lip, which also chop the lane along its front.
  stall(16, 14, 3, 3, 3, G, M_STAGE),
  stall(25, 14, 3, 3, 3, G, M_STAGE),
  stall(35, 14, 3, 3, 3, G, M_STAGE),
  // Display cases on the stage, placed to break the view through the two
  // proscenium arches. Without these the stage is one long shot end to end.
  stall(16, 2, 3, 3, 3, S, M_BOOTH),
  stall(31, 4, 3, 4, 3, S, M_BOOTH),
  stall(17, 11, 2, 2, 2, S, M_BOOTH2),
  stall(30, 11, 3, 3, 3, S, M_BOOTH2),
  stall(34, 9, 3, 3, 2, S, M_BOOTH),
  stall(10, 6, 3, 3, 3, S, M_BOOTH2),

  /* galleries ------------------------------------------------------------ */

  // Three blocks of deck all the way round, so the hall is overlooked from
  // every wall. A Victorian hall does this in cast iron; here it is one slab,
  // a balustrade thin enough to shoot over, and a pier every few blocks.
  box(1, L - 1, 1, 46, L - 1, 4, M_GALLERY),
  box(1, L - 1, 43, 46, L - 1, 46, M_GALLERY),
  box(1, L - 1, 5, 4, L - 1, 42, M_GALLERY),
  box(43, L - 1, 5, 46, L - 1, 42, M_GALLERY),
  // The balustrade stands on the innermost cell of the deck, which leaves a
  // walkway three blocks wide behind it.
  box(1, L, 4, 46, L, 4, M_TRIM),
  box(1, L, 43, 46, L, 43, M_TRIM),
  box(4, L, 5, 4, L, 42, M_TRIM),
  box(43, L, 5, 43, L, 42, M_TRIM),
  ...galleryPiers(),

  /* corner stairs to the galleries --------------------------------------- */

  // Six steps, three wide, one in each corner. The gallery slab is cut away
  // over each run, which is what makes a corner a stairwell rather than a
  // ceiling two blocks above the steps.
  // Two blocks wide, not three: the stairwell has to leave one lane of deck
  // beside it or it cuts the gallery ring in half.
  stair(1, G, 10, 2, 6, "-z"),
  air(1, L - 1, 6, 2, L - 1, 10),
  stair(45, G, 10, 2, 6, "-z"),
  air(45, L - 1, 6, 46, L - 1, 10),
  stair(1, G, 37, 2, 6, "+z"),
  air(1, L - 1, 37, 2, L - 1, 41),
  stair(45, G, 37, 2, 6, "+z"),
  air(45, L - 1, 37, 46, L - 1, 41),

  /* roof structure ------------------------------------------------------- */

  // Lattice trusses spanning the hall, one block thick, carried on the piers.
  // Over the floor they sit four blocks up, so the aisles walk freely under
  // them. Over the stage they run to the ground as proscenium walls, because
  // the stage surface is already three blocks up and a truss above it would
  // leave a clear shot the full width of the hall at head height.
  //
  // Between these four and the piers, the volume above the booths is cut into
  // compartments around fourteen blocks across. That is the entire reason the
  // galleries and the roof route are not firing positions over the whole map.
  box(14, 4, 15, 14, TOP, 46, M_IRON),
  box(28, 4, 15, 28, TOP, 46, M_IRON),
  box(14, G, 1, 14, TOP, 14, M_IRON),
  box(28, G, 1, 28, TOP, 14, M_IRON),
  box(1, 4, 21, 46, TOP, 21, M_IRON),
  box(1, 4, 35, 46, TOP, 35, M_IRON),

  // Two more roof piers, standing on the stage itself. The hall's roof needs
  // carrying over the stage as much as over the floor, and these are what
  // stop the long diagonal from a side gallery across the stage to the far
  // wall, which is otherwise the worst line in the building.
  box(10, G, 5, 12, TOP, 8, M_IRON),
  box(32, G, 5, 34, TOP, 8, M_IRON),

  // Two posts carrying the ends of the catwalks. They exist to stop the
  // sightline along the open face of a pavilion roof, which is the one line
  // the zigzag does not break on its own.
  box(19, R, 20, 20, TOP, 20, M_IRON),
  box(19, R, 30, 20, TOP, 30, M_IRON),
  box(39, R, 27, 40, TOP, 31, M_IRON),

  // The proscenium truss, across the front of the stage. It starts six
  // blocks up rather than four, so the stage still overlooks the hall at head
  // height while the galleries and the roof cannot see over the stage wall.
  box(1, 6, 15, 46, TOP, 15, M_IRON),

  // Arched openings through the trusses, two blocks of headroom each. The
  // proscenium walls are deliberately not arched at stage level: each of the
  // three stage bays is entered up its own steps from the hall floor, which
  // is what keeps the stage from being one clear shot end to end.
  air(14, L, 1, 14, L + 1, 3),
  air(28, L, 1, 28, L + 1, 3),
  air(14, L, 44, 14, L + 1, 46),
  air(28, L, 44, 28, L + 1, 46),
  air(1, L, 21, 3, L + 1, 21),
  air(44, L, 21, 46, L + 1, 21),
  air(1, L, 35, 3, L + 1, 35),
  air(44, L, 35, 46, L + 1, 35),
  air(1, L, 15, 3, L + 1, 15),
  air(44, L, 15, 46, L + 1, 15),

  /* the clock tower ------------------------------------------------------ */

  // The centrepiece, and the piece of geometry the sightline budget leans on
  // hardest: the only thing standing in the middle of the hall that is taller
  // than the roof route, so no line crosses the centre at any level.
  box(21, G, 23, 27, TOP, 29, M_BRICK),
  box(21, 12, 23, 27, 13, 29, M_IRON),
  box(22, 14, 23, 26, 15, 23, M_TRIM),
  box(22, 14, 29, 26, 15, 29, M_TRIM),
  box(21, 14, 24, 21, 15, 28, M_TRIM),
  box(27, 14, 24, 27, 15, 28, M_TRIM),

  /* the roof route ------------------------------------------------------- */

  ...catwalks(),

  // Two ways up, on opposite corners of the hall: a bridge out from the
  // gallery, then four steps onto a pavilion roof. The last step lands in a
  // notch cut through that pavilion's truss web.
  box(5, L - 1, 17, 8, L - 1, 18, M_GALLERY),
  air(4, L, 17, 4, L, 18),
  stair(6, L, 17, 2, 4, "+x"),
  air(9, R, 17, 9, R + 2, 18),
  box(39, L - 1, 29, 42, L - 1, 30, M_GALLERY),
  air(43, L, 29, 43, L, 30),
  stair(38, L, 29, 2, 4, "-x"),
  air(34, R, 29, 34, R + 2, 30),
];

/* --------------------------------------------------------------- signs --- */

/**
 * Booth signage. Invented names only: no real conference, company or token
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
  { x: 16, y: 2, z: 16, w: 5, facing: 0, text: "HALL OF LOOMS" },
  { x: 23, y: 4, z: 16, w: 5, facing: 0, text: "AERATED WATERS" },
  { x: 37, y: 3, z: 16, w: 5, facing: 0, text: "PNEUMATIC POST" },
  { x: 9, y: 2, z: 27, w: 5, facing: 1, text: "GLASSWORKS" },
  { x: 16, y: 3, z: 27, w: 5, facing: 1, text: "MINERAL CABINET" },
  { x: 30, y: 2, z: 27, w: 5, facing: 1, text: "SILK AND DAMASK" },
  { x: 37, y: 4, z: 27, w: 5, facing: 1, text: "IRON AND STEAM" },
  { x: 16, y: 4, z: 34, w: 5, facing: 1, text: "BOTANIC HOUSE" },
  { x: 37, y: 2, z: 34, w: 5, facing: 1, text: "TELEGRAPHY" },
  { x: 9, y: 4, z: 41, w: 5, facing: 1, text: "ORRERY NO. 4" },
  { x: 16, y: 2, z: 41, w: 5, facing: 1, text: "CARRIAGE WORKS" },
  { x: 23, y: 3, z: 41, w: 5, facing: 1, text: "ELECTRIC LIGHT" },
  { x: 30, y: 4, z: 41, w: 5, facing: 1, text: "GRAND BAZAAR" },
  { x: 37, y: 3, z: 41, w: 5, facing: 1, text: "CLOCKWORK COURT" },
  { x: 9, y: 6, z: 16, w: 5, facing: 2, text: "WEST PAVILION" },
  { x: 34, y: 6, z: 30, w: 5, facing: 3, text: "EAST PAVILION" },
  { x: 20, y: 11, z: 9, w: 8, facing: 1, text: "THE GREAT ORGAN" },
  { x: 21, y: 11, z: 23, w: 7, facing: 0, text: "THE HALL" },
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

/* ------------------------------------------------------------- spawns --- */

/**
 * Six spawns, one per seat, spread over every level: two on the hall floor at
 * opposite corners, one on the stage, two on the galleries and one on the
 * roof. Feet heights are the walk surface, so a spawning player is standing,
 * not falling. The map test checks each spawn is standable and has cover
 * within a few blocks, because spawning in the open on a floor this dense is
 * a death sentence.
 */
export const SPAWNS: readonly { x: number; y: number; z: number }[] = [
  { x: cellCentreX(6), y: LEVEL_GROUND, z: cellCentreZ(20) },
  { x: cellCentreX(44), y: LEVEL_GROUND, z: cellCentreZ(26) },
  { x: cellCentreX(21), y: LEVEL_STAGE, z: cellCentreZ(2) },
  { x: cellCentreX(2), y: LEVEL_GALLERY, z: cellCentreZ(14) },
  { x: cellCentreX(45), y: LEVEL_GALLERY, z: cellCentreZ(33) },
  { x: cellCentreX(11), y: LEVEL_GIRDER, z: cellCentreZ(31) },
];
