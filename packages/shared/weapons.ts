/**
 * Weapons, as data.
 *
 * Three of them, each answering a different question about the hall. The
 * rifle is the default and works at the lane lengths the map is built around.
 * The pistol rewards aim with a one shot head shot and punishes spray with a
 * twelve round magazine and a slow trigger. The shotgun owns the booth lanes
 * and the stairwells and is useless across the floor, because its pellets
 * spread and its range stops well short of a sightline.
 *
 * All of it is read by the server. The client reads the same table to draw
 * the ammo counter and pick a firing sound, but nothing the client does with
 * it matters: the shot that counts is the one the server resolves.
 */

export const W_RIFLE = 0;
export const W_PISTOL = 1;
export const W_SHOTGUN = 2;
export const WEAPON_COUNT = 3;

/** Ticks a weapon swap takes before the new weapon can fire. */
export const SWITCH_TICKS = 18;

export interface WeaponSpec {
  readonly id: number;
  readonly name: string;
  /** Rounds in a full magazine. */
  readonly mag: number;
  /** Ticks a reload takes. */
  readonly reloadTicks: number;
  /** Minimum ticks between shots. */
  readonly fireInterval: number;
  /** Damage per pellet to the body. */
  readonly damage: number;
  /** Head shot multiplier, as authored. */
  readonly headMult: number;
  /**
   * Damage per pellet to the head, rounded once here rather than every shot.
   * Rounding in the hot path would be one more thing a replay has to
   * reproduce exactly for no benefit.
   */
  readonly headDamage: number;
  /** Maximum aim deviation, in yaw units. 8192 units is a full turn. */
  readonly spread: number;
  /** Pellets per shot. */
  readonly pellets: number;
  /** True if holding the trigger keeps firing. */
  readonly auto: boolean;
  /** Range in blocks. Past this the shot simply stops. */
  readonly range: number;
}

function spec(
  id: number, name: string, mag: number, reloadTicks: number, fireInterval: number,
  damage: number, headMult: number, spread: number, pellets: number,
  auto: boolean, range: number,
): WeaponSpec {
  return {
    id, name, mag, reloadTicks, fireInterval, damage, headMult,
    headDamage: Math.round(damage * headMult),
    spread, pellets, auto, range,
  };
}

export const WEAPONS: readonly WeaponSpec[] = [
  // Six body shots or three heads. 1.5 second reload.
  spec(W_RIFLE, "Rifle", 30, 90, 7, 18, 2, 60, 1, true, 90),
  // 100 damage to the head: one shot, and the only weapon in the game that
  // can do it. Three to the body, at five rounds a second at best.
  spec(W_PISTOL, "Pistol", 12, 75, 13, 40, 2.5, 14, 1, false, 90),
  // Eight pellets of 14: everything lands at touching distance, and the shot
  // stops dead at sixteen blocks. The hall's longest sightline is about
  // twenty one, so the range limit is what keeps this a weapon for the booth
  // lanes and the stairwells rather than one more way to hold a long lane.
  spec(W_SHOTGUN, "Shotgun", 6, 150, 45, 14, 1.5, 420, 8, false, 16),
];

/**
 * Deterministic spread.
 *
 * Every pellet's deviation comes from hashing (tick, slot, pellet index).
 * Math.random would be the obvious choice and it would destroy the audit
 * story: the match log records inputs, so a replay has to be able to derive
 * every random looking number the match used from values the log contains. A
 * tick, a slot and a pellet index are all in the log, so they are.
 *
 * Integer mixing only: Math.imul, shifts and xor, which are exact on every
 * engine. The constants are the usual xxhash and murmur ones.
 */
export function spreadHash(tick: number, slot: number, pellet: number): number {
  let h = Math.imul((tick | 0) ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ ((slot | 0) + 0x165667b1), 0xc2b2ae35);
  h = Math.imul(h ^ Math.imul(pellet | 0, 0x27d4eb2f), 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

export function weaponName(id: number): string {
  const w = WEAPONS[id];
  return w ? w.name : "Unknown";
}
