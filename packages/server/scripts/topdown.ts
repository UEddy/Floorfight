/**
 * A plan of The Hall, drawn straight from the block grid, as a PNG.
 *
 *   npm run topdown -- out.png
 *
 * Each block column is coloured by the material of its highest solid block
 * and shaded by that block's height, so the galleries, the bandstand and the
 * cover read as raised. Spawns are white squares ringed in black; the combat
 * zones in shared/map.ts are red rings. No renderer and no browser: it is
 * what the server and the replay see, not a picture of the client.
 */
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import {
  GRID_X, GRID_Y, GRID_Z, SPAWNS, ZONES, blockAt,
  M_BOOTH, M_BOOTH2, M_BRICK, M_CRATE, M_FLOOR, M_GALLERY, M_HEDGE, M_IRON, M_STAGE, M_STAIR, M_TRIM,
} from "../../shared/map";

const PX = 8;
const out = process.argv[2] ?? "topdown.png";

const COLOURS: Record<number, [number, number, number]> = {
  [M_FLOOR]: [150, 104, 64],
  [M_BRICK]: [160, 70, 50],
  [M_BOOTH]: [214, 82, 60],
  [M_BOOTH2]: [60, 150, 170],
  [M_STAIR]: [240, 200, 70],
  [M_GALLERY]: [70, 110, 190],
  [M_IRON]: [80, 92, 120],
  [M_STAGE]: [150, 60, 90],
  [M_TRIM]: [225, 225, 215],
  [M_CRATE]: [190, 140, 80],
  [M_HEDGE]: [60, 130, 50],
};

const W = GRID_X * PX;
const H = GRID_Z * PX;
const img = new Uint8Array(W * H * 3);
const put = (x: number, y: number, c: readonly number[]) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  img[i] = c[0]; img[i + 1] = c[1]; img[i + 2] = c[2];
};

for (let iz = 0; iz < GRID_Z; iz++) {
  for (let ix = 0; ix < GRID_X; ix++) {
    let top = 0;
    let m = 0;
    for (let iy = GRID_Y - 1; iy >= 0; iy--) {
      const b = blockAt(ix, iy, iz);
      if (b) { top = iy; m = b; break; }
    }
    const base = COLOURS[m] ?? [0, 0, 0];
    // Full height walls and columns are drawn dark, so the floor plan reads.
    const k = top >= GRID_Y - 1 ? 0.45 : 0.7 + Math.min(top, 10) * 0.05;
    const c = base.map((v) => Math.min(255, Math.round(v * k)));
    for (let y = 0; y < PX; y++) {
      for (let x = 0; x < PX; x++) {
        // A faint grid line every block, a stronger one every eight.
        const line = (x === 0 && ix % 8 === 0) || (y === 0 && iz % 8 === 0) ? 0.75 : x === 0 || y === 0 ? 0.92 : 1;
        put(ix * PX + x, iz * PX + y, c.map((v) => Math.round(v * line)));
      }
    }
  }
}

const ring = (cx: number, cy: number, r: number, t: number, c: readonly number[]) => {
  for (let y = -r - t; y <= r + t; y++) {
    for (let x = -r - t; x <= r + t; x++) {
      const d = Math.hypot(x, y);
      if (d >= r - t / 2 && d <= r + t / 2) put(cx + x, cy + y, c);
    }
  }
};
for (const z of ZONES) ring(z.x * PX + PX / 2, z.z * PX + PX / 2, 6 * PX, 3, [230, 40, 40]);
for (const s of SPAWNS) {
  const cx = Math.round((s.x + GRID_X / 2) * PX);
  const cy = Math.round((s.z + GRID_Z / 2) * PX);
  for (let y = -6; y <= 6; y++) {
    for (let x = -6; x <= 6; x++) put(cx + x, cy + y, Math.max(Math.abs(x), Math.abs(y)) >= 5 ? [0, 0, 0] : [255, 255, 255]);
  }
}

/* A minimal PNG writer: one IDAT, filter 0 on every row. */
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const body = Buffer.concat([head.subarray(4), Buffer.from(data)]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc(body), 0);
  return Buffer.concat([head.subarray(0, 4), body, tail]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // truecolour
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0;
  Buffer.from(img.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1);
}
writeFileSync(out, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", new Uint8Array(0)),
]));
console.log(`wrote ${out}, ${W} by ${H}`);
