import {
  GRID_X,
  M_BRICK, M_CRATE, M_FLOOR, M_GALLERY, M_HEDGE, M_IRON, M_STAGE, M_STAIR, M_TRIM,
  blockAt,
} from "../../shared/map";

/**
 * What the floor is made of, where it matters to more than one file: the
 * renderer picks its tiles from these, and the footsteps pick their sound,
 * so the carpet you see is the carpet you hear.
 */

/**
 * Where the floor is carpeted: a runner down the middle of the nave, and one
 * across it between the fountain and the engines.
 */
export const runner = (ix: number, iz: number) =>
  (ix >= 46 && ix <= 49 && iz >= 8) || (iz >= 67 && iz <= 68 && ix >= 8 && ix <= GRID_X - 9);

/** Flagstones in the arcades under the galleries. */
export const arcade = (ix: number, iz: number) => ix <= 6 || ix >= GRID_X - 7 || iz <= 6;

export type Surface = "wood" | "stone" | "carpet" | "metal" | "grass";

/** The surface under a pair of feet standing on block (ix, iy - 1, iz). */
export function surfaceAt(ix: number, iy: number, iz: number): Surface {
  switch (blockAt(ix, iy - 1, iz)) {
    case M_FLOOR:
      if (runner(ix, iz)) return "carpet";
      return arcade(ix, iz) ? "stone" : "wood";
    case M_BRICK:
    case M_TRIM:
      return "stone";
    case M_IRON:
      return "metal";
    case M_HEDGE:
      return "grass";
    case M_GALLERY:
    case M_STAIR:
    case M_STAGE:
    case M_CRATE:
    default:
      return "wood";
  }
}
