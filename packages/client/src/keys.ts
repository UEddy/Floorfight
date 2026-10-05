import nacl from "tweetnacl";
import { DEV_SEATS, devSeedLabel } from "../../shared/dev";

/**
 * Dev seat keypair, derived from a public label exactly as the server derives
 * the dev roster. Only reachable in a dev build with ?seat=N, and only useful
 * against a server running with ARENA_DEV. See shared/dev.ts for why these
 * keys being public is acceptable.
 */
export function devKeypair(seat: number): nacl.SignKeyPair {
  if (!Number.isInteger(seat) || seat < 0 || seat >= DEV_SEATS) {
    throw new Error(`seat must be 0 to ${DEV_SEATS - 1}`);
  }
  const seed = nacl.hash(new TextEncoder().encode(devSeedLabel(seat))).slice(0, 32);
  return nacl.sign.keyPair.fromSeed(seed);
}

/**
 * A guest key, made up here and kept in memory for this page load.
 *
 * This is the identity a free match uses. It is deliberately not persisted:
 * nothing in localStorage, nothing in a cookie, nothing in IndexedDB.
 *
 * Reload the page and you are a new player, which is the honest description
 * of what a free match identity is worth. A key kept across sessions would be
 * something to steal, something to ban, and something that looks like an
 * account without any of the protection one should have. The identity that
 * matters is the wallet, and that one lives in the wallet app and signs
 * through Mobile Wallet Adapter for a staked match.
 */
export function guestKeypair(): nacl.SignKeyPair {
  return nacl.sign.keyPair();
}
