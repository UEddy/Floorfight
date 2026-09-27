import bs58 from "bs58";
import nacl from "tweetnacl";
import type { RosterEntry } from "../../shared/protocol";
import { DEV_SEATS, devSeedLabel } from "../../shared/dev";

/**
 * Decide whether the dev room may open.
 *
 * The dev room lets anyone holding the public dev keys play, so it must never
 * be reachable on the droplet. Two separate conditions guard it: ARENA_DEV has
 * to be set to exactly "1", and NODE_ENV must not be production. If both are
 * set at once the environment is contradictory, most likely a dev flag left in
 * a deploy script, and the server refuses to start at all rather than quietly
 * picking one. Failing loudly there is the point.
 */
export function devModeFromEnv(env: NodeJS.ProcessEnv): boolean {
  const flag = env.ARENA_DEV;
  const production = env.NODE_ENV === "production";
  if (flag !== undefined && flag !== "" && production) {
    throw new Error(
      "ARENA_DEV is set while NODE_ENV=production. Refusing to start. " +
        "Remove ARENA_DEV from the production environment.",
    );
  }
  return flag === "1" && !production;
}

export function devWarning(): string {
  const bar = "!".repeat(72);
  return [
    bar,
    "!!  ARENA DEV MODE IS ON",
    "!!  A room with a public, derivable roster is open. Anyone who can reach",
    "!!  this port can join it. Never run this on the droplet.",
    bar,
  ].join("\n");
}

/** The dev roster: slot i belongs to the key derived from devSeedLabel(i). */
export function devRoster(): RosterEntry[] {
  const out: RosterEntry[] = [];
  for (let slot = 0; slot < DEV_SEATS; slot++) {
    const seed = nacl.hash(new TextEncoder().encode(devSeedLabel(slot))).slice(0, 32);
    const kp = nacl.sign.keyPair.fromSeed(seed);
    out.push({ slot, wallet: bs58.encode(kp.publicKey), collection: null, mint: null });
  }
  return out;
}
