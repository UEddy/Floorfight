import nacl from "tweetnacl";
import { DEV_SEATS, devSeedLabel } from "../../shared/dev";

/**
 * Dev seat keypair, derived from a public label exactly as the server derives
 * the dev roster. Stands in for Mobile Wallet Adapter until the Expo shell
 * exists. See shared/dev.ts for why these keys being public is acceptable.
 */
export function devKeypair(seat: number): nacl.SignKeyPair {
  if (!Number.isInteger(seat) || seat < 0 || seat >= DEV_SEATS) {
    throw new Error(`seat must be 0 to ${DEV_SEATS - 1}`);
  }
  const seed = nacl.hash(new TextEncoder().encode(devSeedLabel(seat))).slice(0, 32);
  return nacl.sign.keyPair.fromSeed(seed);
}
