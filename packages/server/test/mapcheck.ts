// Layout checks for The Hall, shared by the map tests and by anyone editing
// the map. Not a *.test.ts, so the runner does not run it on its own.
//
// Everything here walks the block grid the way a player can: two blocks of
// headroom to stand, a one block step up without jumping, any drop down.

import {
  EYE_HEIGHT,
  GRID_X,
  GRID_Y,
  GRID_Z,
  blockAt,
  cellCentreX,
  cellCentreZ,
  rayGrid,
  solidAt,
} from "../../shared/sim";
import { M_STAIR } from "../../shared/map";

export const key = (x: number, y: number, z: number) => (y * GRID_Z + z) * GRID_X + x;
export const unkey = (k: number): [number, number, number] =>
  [k % GRID_X, Math.floor(k / (GRID_X * GRID_Z)), Math.floor(k / GRID_X) % GRID_Z];

/** A cell a player can stand in: ground under it and two blocks of air. */
export function standable(x: number, y: number, z: number): boolean {
  if (x < 1 || z < 1 || x >= GRID_X - 1 || z >= GRID_Z - 1 || y < 1 || y >= GRID_Y - 1) return false;
  return solidAt(x, y - 1, z) && !solidAt(x, y, z) && !solidAt(x, y + 1, z);
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

/** Where a player standing in (x, y, z) can get to in one move to (nx, nz). */
function moveTo(x: number, y: number, z: number, nx: number, nz: number): number | null {
  // Level, or a one block step up (walking climbs it), or a drop of any height.
  if (standable(nx, y, nz)) return y;
  if (standable(nx, y + 1, nz) && !solidAt(x, y + 2, z)) return y + 1;
  if (!solidAt(nx, y, nz) && !solidAt(nx, y + 1, nz)) {
    for (let fy = y - 1; fy >= 1; fy--) if (standable(nx, fy, nz)) return fy;
  }
  return null;
}

/** Every cell reachable on foot from the given cells, no jumping. */
export function reachable(from: readonly [number, number, number][]): Set<number> {
  const seen = new Set<number>();
  const queue: [number, number, number][] = [];
  for (const c of from) {
    if (!standable(...c)) continue;
    seen.add(key(...c));
    queue.push(c);
  }
  while (queue.length) {
    const [x, y, z] = queue.pop()!;
    for (const [dx, dz] of DIRS) {
      const ny = moveTo(x, y, z, x + dx, z + dz);
      if (ny === null) continue;
      const k = key(x + dx, ny, z + dz);
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push([x + dx, ny, z + dz]);
    }
  }
  return seen;
}

/**
 * Walking distance in blocks from one cell to each reachable cell, eight way
 * with diagonals at root two, the way a player cuts a corner.
 */
export function walkDistances(from: [number, number, number]): Map<number, number> {
  const dist = new Map<number, number>([[key(...from), 0]]);
  // A plain binary heap of [distance, key].
  const heap: [number, number][] = [[0, key(...from)]];
  const push = (d: number, k: number) => {
    heap.push([d, k]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  const steps: [number, number, number][] = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
  ];
  while (heap.length) {
    const [d, k] = pop();
    if (d > (dist.get(k) ?? Infinity)) continue;
    const [x, y, z] = unkey(k);
    for (const [dx, dz, c] of steps) {
      // A diagonal only where both sides are open, so it does not squeeze
      // between two blocks that meet at a corner.
      if (dx !== 0 && dz !== 0 && (moveTo(x, y, z, x + dx, z) === null || moveTo(x, y, z, x, z + dz) === null)) {
        continue;
      }
      const ny = moveTo(x, y, z, x + dx, z + dz);
      if (ny === null) continue;
      const nk = key(x + dx, ny, z + dz);
      const nd = d + c;
      if (nd < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, nd);
        push(nd, nk);
      }
    }
  }
  return dist;
}

/** Is this cell the tread of a staircase? Stairs are exempt from width rules. */
export function onStair(x: number, y: number, z: number): boolean {
  return blockAt(x, y - 1, z) === M_STAIR;
}

/**
 * Is this standable cell inside some 4 by 4 square of standable cells on the
 * same level? A cell that is not is in a gap or a pocket narrower than four.
 */
export function inWideSpace(x: number, y: number, z: number, size = 4): boolean {
  for (let ox = x - size + 1; ox <= x; ox++) {
    for (let oz = z - size + 1; oz <= z; oz++) {
      let ok = true;
      for (let i = 0; i < size && ok; i++) {
        for (let j = 0; j < size && ok; j++) {
          if (!standable(ox + i, y, oz + j)) ok = false;
        }
      }
      if (ok) return true;
    }
  }
  return false;
}

/** Can an eye at one cell see an eye or a chest at the other? */
export function sees(a: [number, number, number], b: [number, number, number]): boolean {
  const ax = cellCentreX(a[0]), ay = a[1] + EYE_HEIGHT, az = cellCentreZ(a[2]);
  for (const h of [EYE_HEIGHT, 1.0]) {
    const bx = cellCentreX(b[0]), by = b[1] + h, bz = cellCentreZ(b[2]);
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const d = Math.hypot(dx, dy, dz);
    if (rayGrid(ax, ay, az, dx / d, dy / d, dz / d, d) >= d) return true;
  }
  return false;
}

/** Nearest wall or cover from a cell, at eye height, in sixteen directions. */
export function nearestCover(x: number, y: number, z: number): number {
  let nearest = Infinity;
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const d = rayGrid(cellCentreX(x), y + 1.0, cellCentreZ(z), Math.sin(a), 0, Math.cos(a), 60);
    if (d < nearest) nearest = d;
  }
  return nearest;
}

/**
 * Cells in a pocket narrower than four: standable, reachable, not a stair
 * tread, not inside a 4 by 4 open square, and not one step from a cell that
 * is. A one block ledge (a fountain rim, the top of a balustrade) passes,
 * because a player on it can step straight off into open floor; a slot
 * between a wall and a column, deeper than a step, does not.
 */
export function pocketCells(reach: Set<number>): number[] {
  const wide = (x: number, y: number, z: number) => onStair(x, y, z) || inWideSpace(x, y, z);
  const out: number[] = [];
  for (const k of reach) {
    const [x, y, z] = unkey(k);
    if (wide(x, y, z)) continue;
    let escape = false;
    for (const [dx, dz] of DIRS) {
      const ny = moveTo(x, y, z, x + dx, z + dz);
      if (ny !== null && wide(x + dx, ny, z + dz)) { escape = true; break; }
    }
    if (!escape) out.push(k);
  }
  return out;
}
