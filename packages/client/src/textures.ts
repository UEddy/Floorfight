import * as THREE from "three";

/**
 * Block textures, drawn here pixel by pixel into one atlas.
 *
 * Every tile is 16 by 16 and original: nothing is loaded, traced or copied,
 * so there is no asset licence to check before the app is published. The
 * patterns come from a seeded generator, so the hall looks the same on every
 * load and a screenshot taken today matches one taken tomorrow.
 *
 * Each tile sits in the middle of a 32 pixel cell, and the 8 pixel border
 * round it is the same tile wrapped. Mipmaps average neighbouring pixels, and
 * without that border the far wall would pick up a fringe of whatever tile
 * happens to sit next to it in the atlas. With it, the first three mip levels
 * see only their own tile, and by the fourth the fog has the wall anyway.
 */

export const TILE = 16;
const CELL = 32;
const PAD = (CELL - TILE) / 2;
const COLS = 8;
const ROWS = 5;
export const ATLAS_W = CELL * COLS;
export const ATLAS_H = CELL * ROWS;

/** Tile ids. The order is the atlas order, row by row. */
export const T = {
  BRICK: 0, BRICK_MOSS: 1, STONE: 2, STONE_CAP: 3,
  PLANK: 4, PLANK_WORN: 5, CARPET: 6, CARPET_WORN: 7,
  GRASS: 8, GRASS_SIDE: 9, LEAVES: 10, IRON: 11,
  IRON_RIVET: 12, IRON_TOP: 13, FABRIC_A: 14, FABRIC_B: 15,
  CANVAS: 16, STAIR: 17, STAIR_SIDE: 18, DECK: 19,
  DECK_SIDE: 20, VELVET: 21, STAGE_TOP: 22, TRIM: 23,
  TRIM_TOP: 24, FABRIC_A2: 25, FABRIC_B2: 26, CRATE: 27,
  GLASS: 28, SKIN: 29, CLOTH: 30, GUNMETAL: 31,
  GUNWOOD: 32, ACCENT: 33, POLYMER: 34, BOOT: 35,
  HAIR: 36, FACE: 37, LEATHER: 38,
} as const;

type RGB = [number, number, number];

/** Small seeded generator. Cosmetic only, never anything the sim reads. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function hex(c: number): RGB {
  return [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}

function shade(c: RGB, k: number): RGB {
  return [c[0] * k, c[1] * k, c[2] * k];
}

class Tile {
  px = new Float32Array(TILE * TILE * 3);
  constructor(public r: () => number) {}
  set(x: number, y: number, c: RGB): void {
    const i = ((y & 15) * TILE + (x & 15)) * 3;
    this.px[i] = c[0]; this.px[i + 1] = c[1]; this.px[i + 2] = c[2];
  }
  get(x: number, y: number): RGB {
    const i = ((y & 15) * TILE + (x & 15)) * 3;
    return [this.px[i], this.px[i + 1], this.px[i + 2]];
  }
  fill(c: RGB, jitter = 0): void {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) this.set(x, y, shade(c, 1 + (this.r() - 0.5) * jitter));
    }
  }
  rect(x0: number, y0: number, w: number, h: number, c: RGB, jitter = 0): void {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) this.set(x, y, shade(c, 1 + (this.r() - 0.5) * jitter));
    }
  }
  mul(x: number, y: number, k: number): void {
    this.set(x, y, shade(this.get(x, y), k));
  }
}

/* ------------------------------------------------------------ tiles --- */

function bricks(t: Tile, base: RGB, mortar: RGB, moss: boolean): void {
  t.fill(mortar, 0.12);
  for (let row = 0; row < 4; row++) {
    const off = row % 2 === 0 ? 0 : 4;
    for (let b = -1; b < 2; b++) {
      const x0 = b * 8 + off;
      const k = 0.82 + t.r() * 0.3;
      for (let y = row * 4; y < row * 4 + 3; y++) {
        for (let x = x0; x < x0 + 7; x++) {
          if (x < 0 || x > 15) continue;
          let c = shade(base, k * (1 + (t.r() - 0.5) * 0.14));
          if (y === row * 4) c = shade(c, 1.12);
          if (y === row * 4 + 2) c = shade(c, 0.86);
          t.set(x, y, c);
        }
      }
    }
  }
  if (moss) {
    const green: RGB = hex(0x4f8a2e);
    for (let i = 0; i < 26; i++) {
      const x = Math.floor(t.r() * 16);
      const y = 10 + Math.floor(t.r() * 6);
      t.set(x, y, shade(green, 0.75 + t.r() * 0.5));
      if (t.r() < 0.5) t.set(x, y - 1, shade(green, 0.7 + t.r() * 0.4));
    }
  }
}

function stone(t: Tile, base: RGB, cap: boolean): void {
  t.fill(base, 0.16);
  const line = shade(base, 0.62);
  const lite = shade(base, 1.18);
  if (cap) {
    // A coping stone: one slab with a bevelled edge all round.
    for (let i = 0; i < 16; i++) {
      t.set(i, 0, lite); t.set(0, i, lite);
      t.set(i, 15, line); t.set(15, i, line);
    }
    for (let i = 0; i < 5; i++) t.mul(Math.floor(t.r() * 14) + 1, Math.floor(t.r() * 14) + 1, 0.8);
    return;
  }
  // Cut blocks, two courses, joints staggered.
  for (let x = 0; x < 16; x++) { t.set(x, 7, line); t.set(x, 15, line); t.set(x, 8, lite); t.set(x, 0, lite); }
  for (let y = 0; y < 7; y++) { t.set(5, y, line); t.set(6, y, lite); }
  for (let y = 8; y < 15; y++) { t.set(12, y, line); t.set(13, y, lite); }
  for (let i = 0; i < 6; i++) t.mul(Math.floor(t.r() * 16), Math.floor(t.r() * 16), 0.82);
}

function planks(t: Tile, base: RGB, worn: boolean): void {
  // Four boards, each with its own tone, grain streaks and a butt joint.
  for (let b = 0; b < 4; b++) {
    const k = 0.84 + t.r() * 0.3;
    const joint = Math.floor(t.r() * 16);
    for (let y = b * 4; y < b * 4 + 4; y++) {
      for (let x = 0; x < 16; x++) {
        let c = shade(base, k * (1 + (t.r() - 0.5) * 0.08));
        if (y === b * 4 + 3) c = shade(base, 0.55);
        else if (y === b * 4) c = shade(c, 1.08);
        if (x === joint && y !== b * 4 + 3) c = shade(base, 0.6);
        t.set(x, y, c);
      }
    }
    // Grain.
    for (let i = 0; i < 3; i++) {
      const y = b * 4 + 1 + Math.floor(t.r() * 2);
      const x0 = Math.floor(t.r() * 16);
      for (let x = x0; x < x0 + 3 + Math.floor(t.r() * 4); x++) t.mul(x, y, 0.88);
    }
    t.mul((joint + 2) & 15, b * 4 + 1, 0.55);
  }
  if (worn) {
    for (let i = 0; i < 18; i++) t.mul(Math.floor(t.r() * 16), Math.floor(t.r() * 16), 1.12);
  }
}

function carpet(t: Tile, base: RGB, edge: RGB, worn: boolean): void {
  t.fill(base, 0.1);
  // A woven diamond, the sort of thing laid down an exhibition aisle.
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const d = Math.abs(x - 7.5) + Math.abs(y - 7.5);
      if (d > 5 && d < 6.6) t.set(x, y, shade(edge, 0.95 + t.r() * 0.1));
      if ((x + y) % 4 === 0) t.mul(x, y, 0.93);
    }
  }
  if (worn) for (let i = 0; i < 20; i++) t.mul(Math.floor(t.r() * 16), Math.floor(t.r() * 16), 1.1);
}

function grass(t: Tile): void {
  const g: RGB = hex(0x5ea83a);
  t.fill(g, 0.22);
  for (let i = 0; i < 30; i++) t.mul(Math.floor(t.r() * 16), Math.floor(t.r() * 16), 0.78);
  for (let i = 0; i < 12; i++) t.mul(Math.floor(t.r() * 16), Math.floor(t.r() * 16), 1.18);
}

function grassSide(t: Tile): void {
  const dirt: RGB = hex(0x7a5233);
  t.fill(dirt, 0.2);
  const g: RGB = hex(0x5ea83a);
  for (let x = 0; x < 16; x++) {
    const h = 3 + Math.floor(t.r() * 3);
    for (let y = 0; y < h; y++) t.set(x, y, shade(g, 0.8 + t.r() * 0.35));
  }
  for (let i = 0; i < 10; i++) t.mul(Math.floor(t.r() * 16), 6 + Math.floor(t.r() * 10), 0.75);
}

function leaves(t: Tile): void {
  const g: RGB = hex(0x3f7f2c);
  t.fill(g, 0.3);
  for (let i = 0; i < 40; i++) t.mul(Math.floor(t.r() * 16), Math.floor(t.r() * 16), 0.65);
  for (let i = 0; i < 20; i++) t.mul(Math.floor(t.r() * 16), Math.floor(t.r() * 16), 1.3);
}

/** Painted cast iron. Panel seams, and rivets if asked. */
function iron(t: Tile, base: RGB, rivets: boolean, top: boolean): void {
  t.fill(base, 0.07);
  const dark = shade(base, 0.7);
  const lite = shade(base, 1.14);
  if (top) {
    // Tread plate: little raised bars in alternating directions.
    for (let y = 1; y < 16; y += 4) {
      for (let x = 1; x < 16; x += 4) {
        const flip = ((x + y) >> 2) % 2 === 0;
        t.set(x, y, lite); t.set(flip ? x + 1 : x, flip ? y : y + 1, lite);
        t.set(flip ? x + 1 : x, flip ? y + 1 : y + 1, dark);
      }
    }
    return;
  }
  for (let i = 0; i < 16; i++) {
    t.set(i, 0, lite); t.set(i, 15, dark);
    t.set(0, i, lite); t.set(15, i, dark);
  }
  if (rivets) {
    for (const [x, y] of [[2, 2], [13, 2], [2, 13], [13, 13], [7, 2], [7, 13], [2, 7], [13, 7]] as const) {
      t.set(x, y, lite); t.set(x + 1, y + 1, dark); t.set(x + 1, y, base); t.set(x, y + 1, base);
    }
  } else {
    // Lattice web, the open truss of an exhibition hall roof.
    const web = shade(base, 0.8);
    for (let i = 1; i < 15; i++) {
      t.set(i, i, web); t.set(15 - i, i, web);
    }
  }
}

/** Booth drapes: vertical pleats, a darker hem, a bright pelmet band. */
function fabric(t: Tile, a: RGB, b: RGB, stripes: boolean): void {
  for (let x = 0; x < 16; x++) {
    const pleat = 0.86 + 0.16 * Math.sin((x / 16) * Math.PI * 4);
    const c = stripes && (x >> 2) % 2 === 1 ? b : a;
    for (let y = 0; y < 16; y++) {
      t.set(x, y, shade(c, pleat * (1 + (t.r() - 0.5) * 0.06)));
    }
  }
  for (let x = 0; x < 16; x++) {
    t.set(x, 0, shade(b, 1.1));
    t.set(x, 1, shade(b, 0.9));
    t.set(x, 15, shade(a, 0.62));
  }
}

function canvasTop(t: Tile, base: RGB): void {
  t.fill(base, 0.08);
  for (let i = 0; i < 16; i++) { t.mul(i, 0, 0.8); t.mul(0, i, 0.8); }
  for (let y = 3; y < 16; y += 4) for (let x = 0; x < 16; x++) t.mul(x, y, 0.94);
}

function stair(t: Tile, wood: RGB, nose: RGB, side: boolean): void {
  planks(t, wood, false);
  if (side) {
    for (let y = 0; y < 2; y++) for (let x = 0; x < 16; x++) t.set(x, y, shade(nose, y === 0 ? 1.1 : 0.9));
    return;
  }
  // A painted nosing on the leading edge so the step reads from above.
  for (let x = 0; x < 16; x++) {
    t.set(x, 0, shade(nose, 1.1)); t.set(x, 1, nose); t.set(x, 2, shade(nose, 0.8));
  }
}

function velvet(t: Tile, base: RGB): void {
  for (let x = 0; x < 16; x++) {
    const fold = 0.72 + 0.32 * Math.abs(Math.sin((x / 16) * Math.PI * 3));
    for (let y = 0; y < 16; y++) t.set(x, y, shade(base, fold * (1 + (t.r() - 0.5) * 0.05)));
  }
  for (let x = 0; x < 16; x++) { t.set(x, 15, hex(0xe0b040)); t.set(x, 14, hex(0x9c7420)); }
}

function trim(t: Tile, base: RGB, top: boolean): void {
  t.fill(base, 0.05);
  const dark = shade(base, 0.68);
  if (top) {
    for (let i = 0; i < 16; i++) { t.set(i, 0, dark); t.set(i, 15, dark); }
    return;
  }
  // Balustrade: rail, posts and little arches.
  for (let x = 0; x < 16; x++) { t.set(x, 0, shade(base, 1.1)); t.set(x, 1, dark); t.set(x, 14, dark); }
  for (let y = 3; y < 14; y++) {
    for (const x of [2, 6, 10, 14]) { t.set(x, y, dark); t.set(x + 1, y, shade(base, 0.85)); }
  }
  for (const x of [4, 8, 12, 0]) { t.set(x, 4, dark); t.set(x, 5, dark); }
}

function crate(t: Tile, base: RGB): void {
  planks(t, base, false);
  const frame = shade(base, 0.62);
  for (let i = 0; i < 16; i++) {
    t.set(i, 0, frame); t.set(i, 15, frame); t.set(0, i, frame); t.set(15, i, frame);
    t.set(i, i, shade(base, 0.72));
  }
}

function glass(t: Tile): void {
  t.fill(hex(0xcfe6ee), 0.04);
  const bar = hex(0xf2f2ee);
  for (let i = 0; i < 16; i++) { t.set(i, 0, bar); t.set(0, i, bar); t.set(8, i, bar); }
  for (let i = 2; i < 6; i++) t.set(i + 2, i, hex(0xffffff));
}

/** Skin: flat, with a little warmth at the edges so a fist reads as a fist. */
function skin(t: Tile): void {
  const base = hex(0xe8b08a);
  t.fill(base, 0.05);
  for (let i = 0; i < 16; i++) { t.mul(i, 15, 0.86); t.mul(15, i, 0.9); }
  for (let i = 0; i < 4; i++) t.mul(Math.floor(t.r() * 16), Math.floor(t.r() * 16), 0.94);
}

/**
 * Cloth, drawn near white so a per player colour multiplied over it keeps
 * the weave. Sleeves and shirts are this tile tinted.
 */
function cloth(t: Tile): void {
  const base: RGB = [236, 236, 236];
  t.fill(base, 0.06);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if ((x + y * 3) % 5 === 0) t.mul(x, y, 0.9);
  for (let x = 0; x < 16; x++) { t.mul(x, 0, 0.82); t.mul(x, 15, 0.78); }
  // A seam and a pocket line.
  for (let y = 2; y < 15; y++) t.mul(7, y, 0.88);
  for (let x = 2; x < 6; x++) t.mul(x, 5, 0.85);
}

function metal(t: Tile, base: RGB): void {
  t.fill(base, 0.06);
  const lite = shade(base, 1.35);
  const dark = shade(base, 0.7);
  for (let i = 0; i < 16; i++) { t.set(i, 0, lite); t.set(i, 15, dark); }
  for (let i = 0; i < 6; i++) t.set(2 + i * 2, 4, lite);
  for (let y = 7; y < 13; y++) for (let x = 3; x < 13; x += 3) t.set(x, y, dark);
}

function hair(t: Tile): void {
  const base = hex(0x3b2a20);
  t.fill(base, 0.2);
  for (let i = 0; i < 24; i++) t.mul(Math.floor(t.r() * 16), Math.floor(t.r() * 16), 1.3);
}

/** The default face, used when a player has no verified NFT to wear. */
function face(t: Tile): void {
  skin(t);
  const eye = hex(0x22262e);
  const white = hex(0xf8f8f8);
  t.rect(3, 6, 3, 3, white); t.rect(10, 6, 3, 3, white);
  t.rect(4, 7, 2, 2, eye); t.rect(11, 7, 2, 2, eye);
  t.rect(3, 4, 3, 1, hex(0x5a3a26)); t.rect(10, 4, 3, 1, hex(0x5a3a26));
  t.rect(6, 12, 4, 1, hex(0xb0644a));
  t.rect(0, 0, 16, 3, hex(0x3b2a20), 0.2);
}

/* ------------------------------------------------------------ atlas --- */

const DRAW: Record<number, (t: Tile) => void> = {
  [T.BRICK]: (t) => bricks(t, hex(0x9a4a35), hex(0x55473f), false),
  [T.BRICK_MOSS]: (t) => bricks(t, hex(0x8e4532), hex(0x50443c), true),
  [T.STONE]: (t) => stone(t, hex(0x8a8a96), false),
  [T.STONE_CAP]: (t) => stone(t, hex(0xa5a3a0), true),
  [T.PLANK]: (t) => planks(t, hex(0xa86b3c), false),
  [T.PLANK_WORN]: (t) => planks(t, hex(0x9c6235), true),
  [T.CARPET]: (t) => carpet(t, hex(0x1f8f9a), hex(0x8fd6d6), false),
  [T.CARPET_WORN]: (t) => carpet(t, hex(0x1c8590), hex(0x86cccc), true),
  [T.GRASS]: grass,
  [T.GRASS_SIDE]: grassSide,
  [T.LEAVES]: leaves,
  [T.IRON]: (t) => iron(t, hex(0x5d6b86), false, false),
  [T.IRON_RIVET]: (t) => iron(t, hex(0x55627c), true, false),
  [T.IRON_TOP]: (t) => iron(t, hex(0x6f7684), false, true),
  [T.FABRIC_A]: (t) => fabric(t, hex(0x16a08f), hex(0xf2efe6), false),
  [T.FABRIC_B]: (t) => fabric(t, hex(0xe4532f), hex(0xf6c443), false),
  [T.CANVAS]: (t) => canvasTop(t, hex(0xe9e3d3)),
  [T.STAIR]: (t) => stair(t, hex(0x8c5a32), hex(0xf2b632), false),
  [T.STAIR_SIDE]: (t) => stair(t, hex(0x7c4f2c), hex(0xf2b632), true),
  [T.DECK]: (t) => planks(t, hex(0x6e4a30), false),
  [T.DECK_SIDE]: (t) => iron(t, hex(0x2f5fb0), true, false),
  [T.VELVET]: (t) => velvet(t, hex(0x7a1f4f)),
  [T.STAGE_TOP]: (t) => planks(t, hex(0x5a3a26), false),
  [T.TRIM]: (t) => trim(t, hex(0xf1ead8), false),
  [T.TRIM_TOP]: (t) => trim(t, hex(0xf1ead8), true),
  [T.FABRIC_A2]: (t) => fabric(t, hex(0x2a6fd0), hex(0xf2efe6), true),
  [T.FABRIC_B2]: (t) => fabric(t, hex(0xe8467a), hex(0xfbe9f0), true),
  [T.CRATE]: (t) => crate(t, hex(0xb98a4e)),
  [T.GLASS]: glass,
  [T.SKIN]: skin,
  [T.CLOTH]: cloth,
  [T.GUNMETAL]: (t) => metal(t, hex(0x3a3f47)),
  [T.GUNWOOD]: (t) => planks(t, hex(0x8a5a32), false),
  [T.ACCENT]: (t) => metal(t, hex(0xf07a2a)),
  [T.POLYMER]: (t) => metal(t, hex(0x9aa0a8)),
  [T.BOOT]: (t) => metal(t, hex(0x3a2c24)),
  [T.HAIR]: hair,
  [T.FACE]: face,
  [T.LEATHER]: (t) => planks(t, hex(0x6a4630), true),
};

/**
 * UV rectangle of a tile's 16 pixel middle, as [u0, v0, u1, v1]. v runs up
 * the atlas, which is flipped on upload, so v0 is the tile's bottom row.
 */
export function tileUV(id: number): [number, number, number, number] {
  const cx = (id % COLS) * CELL + PAD;
  const cy = Math.floor(id / COLS) * CELL + PAD;
  return [
    cx / ATLAS_W,
    1 - (cy + TILE) / ATLAS_H,
    (cx + TILE) / ATLAS_W,
    1 - cy / ATLAS_H,
  ];
}

/** The atlas as a canvas, so the view model and props can draw from it too. */
let atlasCanvas: HTMLCanvasElement | null = null;
export function atlasImage(): HTMLCanvasElement {
  if (atlasCanvas) return atlasCanvas;
  const c = document.createElement("canvas");
  c.width = ATLAS_W;
  c.height = ATLAS_H;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(ATLAS_W, ATLAS_H);
  for (const [k, draw] of Object.entries(DRAW)) {
    const id = Number(k);
    const t = new Tile(rng(0x9e3779b9 ^ (id * 2654435761)));
    draw(t);
    const ox = (id % COLS) * CELL;
    const oy = Math.floor(id / COLS) * CELL;
    // The whole 32 pixel cell, with the tile wrapped into its border.
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const [r, g, b] = t.get(x - PAD, y - PAD);
        const i = ((oy + y) * ATLAS_W + ox + x) * 4;
        img.data[i] = Math.max(0, Math.min(255, r));
        img.data[i + 1] = Math.max(0, Math.min(255, g));
        img.data[i + 2] = Math.max(0, Math.min(255, b));
        img.data[i + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  atlasCanvas = c;
  return c;
}

let atlasTexture: THREE.Texture | null = null;
/**
 * Nearest neighbour up close, so each texel is a crisp square, and trilinear
 * mipmaps further away, so a brick wall at twenty blocks does not shimmer.
 */
export function atlas(): THREE.Texture {
  if (atlasTexture) return atlasTexture;
  const tex = new THREE.CanvasTexture(atlasImage());
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  atlasTexture = tex;
  return tex;
}
