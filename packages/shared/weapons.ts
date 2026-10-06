import { sha256, utf8 } from "./sha256";

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
  /**
   * Extra spread at full running speed, or in the air, in yaw units. Scaled
   * by how fast the shooter is going, so a standing shot is the base spread
   * and a strafing one is not.
   */
  readonly moveSpread: number;
  /** Extra spread per shot in an unbroken string of shots, in yaw units. */
  readonly bloom: number;
  /** Most the bloom can add, in yaw units. */
  readonly bloomMax: number;
  /** How the weapon climbs and settles. See recoilShot in sim.ts. */
  readonly recoil: Recoil;
}

/**
 * Recoil, as the sim applies it. A shot lifts the aim by `kick` radians, up
 * to `kickMax`, and pushes it sideways along a fixed sway pattern scaled by
 * `sway` yaw units. Once the trigger has rested for RECOIL_SETTLE_DELAY ticks
 * the aim settles back by `settle` radians a tick, and by a yaw unit or two.
 */
export interface Recoil {
  readonly kick: number;
  readonly kickMax: number;
  readonly sway: number;
  readonly settle: number;
}

function spec(
  id: number, name: string, mag: number, reloadTicks: number, fireInterval: number,
  damage: number, headMult: number, spread: number, pellets: number,
  auto: boolean, range: number, moveSpread: number, bloom: number, bloomMax: number,
  recoil: Recoil,
): WeaponSpec {
  return {
    id, name, mag, reloadTicks, fireInterval, damage, headMult,
    headDamage: Math.round(damage * headMult),
    spread, pellets, auto, range, moveSpread, bloom, bloomMax, recoil,
  };
}

/**
 * Ticks after a shot within which the next one counts as the same string,
 * for bloom. A little longer than any weapon's fire interval, so holding the
 * rifle's trigger keeps the string going and a pause of a quarter second
 * resets it.
 */
export const BLOOM_GAP = 15;

export const WEAPONS: readonly WeaponSpec[] = [
  // Five body shots or three heads, at 100 health. Was 18 a shot, six to the
  // body: 20 brings the body kill to five, under half a second held on
  // target, which on a hall this open is what makes the rifle the gun that
  // wins a straight fight across the nave. The head multiplier comes down
  // from 2 to 1.75 so the head kill stays at three rather than dropping to
  // two at 40 a shot.
  // Range is the length of the hall and more, so the nave's long lines are
  // the rifle's to hold.
  // It climbs about a degree a shot held down, to five degrees, and walks
  // side to side as it goes: pulling down against it is the skill.
  spec(W_RIFLE, "Rifle", 30, 90, 7, 20, 1.75, 60, 1, true, 140, 40, 8, 48,
    { kick: 0.017, kickMax: 0.09, sway: 9, settle: 0.003 }),
  // 100 damage to the head: one shot, and the only weapon in the game that
  // can do it. Three to the body, at under five rounds a second. Unchanged:
  // it is the gun where the head shot decides everything, so a miss at the
  // head costs two more pulls at the body and the person aiming well wins.
  // The one shot head kill wants a still shooter: running, the pistol is
  // three times as wide.
  // A sharp three degree flip a shot that has mostly settled by the next.
  spec(W_PISTOL, "Pistol", 12, 75, 13, 40, 2.5, 14, 1, false, 140, 30, 10, 20,
    { kick: 0.05, kickMax: 0.1, sway: 6, settle: 0.006 }),
  // Two hits to kill up close, never one. Was eight pellets of 14 with a
  // 1.5 head multiplier in an 18 degree cone: 112 damage at touching
  // distance (a kill in one) and under 40 a shot from four blocks out
  // (useless at the distance a shotgun is for). Now eight pellets of 11 with
  // no head bonus, so a whole pattern is 88 and nothing kills in one, in a
  // cone of 8.8 degrees, which keeps the whole pattern on a body to about
  // three blocks and two hits a kill to about five (scripts/pattern.ts).
  // The pump is quicker, 36 ticks from 45, so two hits take 0.6 s rather
  // than 0.75 and it still wins the fight it is built for.
  // It stops dead at sixteen blocks. The nave's lines run eighty and more,
  // so the range is what keeps this a weapon for the market, the garden
  // hedges and the stairs rather than one more way to hold a long lane.
  // The pattern is already the spread. Moving does not widen it.
  // A five degree heave, settled well before the pump is done.
  spec(W_SHOTGUN, "Shotgun", 6, 150, 36, 11, 1, 200, 8, false, 16, 0, 0, 0,
    { kick: 0.09, kickMax: 0.12, sway: 14, settle: 0.006 }),
];

/* --------------------------------------------------------------- spread --- */

/**
 * A match's spread salt, folded into two 32 bit words.
 *
 * The salt itself is 32 bytes. Only 64 bits of it reach the hash, which is
 * the honest limit of this: it is enough that nobody can work out where their
 * pellets will go, and it is not a 256 bit security claim. What the full 32
 * bytes buy is the commitment, because the commit is sha256 of all of them.
 */
export interface SpreadSalt {
  readonly a: number;
  readonly b: number;
}

/** Fold salt bytes into the two words the hash uses. Integer ops only. */
export function saltSeeds(bytes: Uint8Array): SpreadSalt {
  let a = 0x9e3779b9;
  let b = 0x85ebca6b;
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i], 0x27d4eb2f);
    a = ((a << 13) | (a >>> 19)) >>> 0;
    b = Math.imul(b ^ (bytes[i] + i), 0x165667b1);
    b = (b ^ (b >>> 11)) >>> 0;
  }
  return { a: a >>> 0, b: b >>> 0 };
}

/**
 * The salt a free room uses: a fixed, public value derived from a label.
 *
 * Free rooms have nothing to win, so there is nobody to convince and no
 * reason to make the client wait for a commitment. It also means a test, a
 * bot and a dev tab all agree on the spread without a handshake. A staked
 * room never uses this: it generates 32 random bytes, publishes the hash of
 * them at join and reveals the bytes in the match log at the end.
 */
export const FREE_SALT_LABEL = "floorfight:free-spread:v1";
export const FREE_SALT_BYTES: Uint8Array = sha256(utf8(FREE_SALT_LABEL));
export const FREE_SALT: SpreadSalt = saltSeeds(FREE_SALT_BYTES);

/**
 * Deterministic spread.
 *
 * Every pellet's deviation comes from hashing the match salt with (tick,
 * slot, pellet index). Math.random would be the obvious choice and it would
 * destroy the audit story: the match log records inputs, so a replay has to
 * be able to derive every random looking number the match used from values
 * the log contains. The tick, the slot and the pellet index are in the log,
 * and so is the salt, written there when the match ends.
 *
 * The salt is what stops the pattern being known in advance. Without it the
 * sequence is a pure function of public numbers, so a player who worked out
 * the hash could know exactly where every pellet of their next shot would go,
 * and so could everyone else know where theirs went. With it, nobody knows
 * until the server reveals it, and because the hash of the salt was published
 * before the first shot, the server cannot choose it afterwards to suit the
 * result.
 *
 * Integer mixing only: Math.imul, shifts and xor, which are exact on every
 * engine. The constants are the usual xxhash and murmur ones.
 */
export function spreadHash(
  salt: SpreadSalt, tick: number, slot: number, pellet: number,
): number {
  let h = Math.imul((tick | 0) ^ salt.a, 0x85ebca6b);
  h = Math.imul(h ^ ((slot | 0) + 0x165667b1), 0xc2b2ae35);
  h = Math.imul(h ^ Math.imul(pellet | 0, 0x27d4eb2f), 0x9e3779b1);
  h = Math.imul(h ^ salt.b, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

export function weaponName(id: number): string {
  const w = WEAPONS[id];
  return w ? w.name : "Unknown";
}
