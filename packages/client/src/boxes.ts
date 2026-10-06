import * as THREE from "three";
import { tileUV } from "./textures";

/**
 * Blocky models built out of boxes, merged into one geometry each.
 *
 * Every box face samples one atlas tile and carries a baked brightness for
 * the way it faces, the same trick the hall uses: nothing built here needs a
 * light, so a gun, a body part or a potted plant is one geometry and costs
 * one draw call whatever it is made of.
 */

export interface Part {
  /** Centre. */
  x: number; y: number; z: number;
  /** Full size. */
  w: number; h: number; d: number;
  /** Atlas tile for the sides, and optionally for top and bottom. */
  tile: number;
  top?: number;
  bottom?: number;
  /** Tile for the -z face only, where a face or a muzzle goes. */
  front?: number;
  /** Colour multiplied over the texture. */
  tint?: number;
  /** Rotation, in radians, about the box's own centre. */
  rx?: number; ry?: number; rz?: number;
}

/** +x -x +y -y +z -z, the same order and the same values as the hall. */
const SHADE = [0.8, 0.8, 1.0, 0.55, 0.9, 0.7];

/** Unit cube faces: outward normal, then four corners counter clockwise. */
const CUBE: readonly { n: number; c: readonly [number, number, number][] }[] = [
  { n: 0, c: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },
  { n: 1, c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
  { n: 2, c: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { n: 3, c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { n: 4, c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { n: 5, c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },
];
const QUAD_UV: readonly [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];

const m = new THREE.Matrix4();
const e = new THREE.Euler();
const q = new THREE.Quaternion();
const v = new THREE.Vector3();
const one = new THREE.Vector3(1, 1, 1);
const col = new THREE.Color();

export interface Built {
  geometry: THREE.BufferGeometry;
  /** Vertex range of each part, for anything that wants to find one again. */
  ranges: [number, number][];
}

/**
 * Merge parts into one indexed geometry. With `groupFront`, the -z faces of
 * parts that name a `front` tile go into a second draw group, so a mesh can
 * give them a material of their own (the character's face, where an NFT
 * image will go).
 */
export function buildParts(parts: readonly Part[], groupFront = false): Built {
  const pos: number[] = [];
  const uv: number[] = [];
  const clr: number[] = [];
  const idx: number[] = [];
  const frontIdx: number[] = [];
  const ranges: [number, number][] = [];

  for (const p of parts) {
    const start = pos.length / 3;
    e.set(p.rx ?? 0, p.ry ?? 0, p.rz ?? 0, "YXZ");
    m.compose(v.set(p.x, p.y, p.z), q.setFromEuler(e), one);
    col.set(p.tint ?? 0xffffff);
    for (const face of CUBE) {
      const tile = face.n === 2 ? p.top ?? p.tile
        : face.n === 3 ? p.bottom ?? p.tile
          : face.n === 5 ? p.front ?? p.tile
            : p.tile;
      const [u0, v0, u1, v1] = tileUV(tile);
      const k = SHADE[face.n];
      const base = pos.length / 3;
      for (let i = 0; i < 4; i++) {
        const [cx, cy, cz] = face.c[i];
        v.set((cx - 0.5) * p.w, (cy - 0.5) * p.h, (cz - 0.5) * p.d).applyMatrix4(m);
        pos.push(v.x, v.y, v.z);
        const [a, b] = QUAD_UV[i];
        uv.push(u0 + (u1 - u0) * a, v0 + (v1 - v0) * b);
        clr.push(col.r * k, col.g * k, col.b * k);
      }
      const target = groupFront && face.n === 5 && p.front !== undefined ? frontIdx : idx;
      target.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    ranges.push([start, pos.length / 3]);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("color", new THREE.Float32BufferAttribute(clr, 3));
  g.setIndex([...idx, ...frontIdx]);
  if (groupFront) {
    g.addGroup(0, idx.length, 0);
    g.addGroup(idx.length, frontIdx.length, 1);
  }
  g.computeBoundingSphere();
  return { geometry: g, ranges };
}
