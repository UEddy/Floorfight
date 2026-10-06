/**
 * Stake tiers for holders matches, and the shape every holders match has.
 *
 * The server uses these to list open matches at a tier, and the page uses
 * them for labels. Neither is the authority on what anybody pays: the native
 * app holds its own copy of the lamport amounts (apps/mobile/src/config.ts),
 * builds the create transaction from that copy, and shows the amount before
 * the wallet opens. The page sends a tier index and nothing more. A test in
 * apps/mobile checks the two lists agree, so they cannot drift apart quietly.
 *
 * Devnet amounts. Mainnet tiers wait on the dApp Store question in CLAUDE.md.
 */

export interface StakeTier {
  /** Lamports each player stakes, as a decimal string (a u64 can exceed 2^53). */
  lamports: string;
  /** What a person sees. */
  label: string;
}

export const STAKE_TIERS: readonly StakeTier[] = [
  { lamports: "10000000", label: "0.01 SOL" },
  { lamports: "50000000", label: "0.05 SOL" },
  { lamports: "100000000", label: "0.1 SOL" },
];

/** Seats in a holders match. The same six as free play. */
export const HOLDERS_MAX_PLAYERS = 6;

/**
 * Seconds a new holders match stays open for joining. Ten minutes: long
 * enough to share a match with friends, inside the program's 30 to 3600.
 */
export const HOLDERS_JOIN_WINDOW = 600;

/**
 * The lobby locks a match that has at least two players once this little of
 * its join window is left, whether or not everyone is in the lobby. Later
 * than this and a slow lock transaction could miss the deadline, after which
 * the program refuses to lock and the match can only refund.
 */
export const LOCK_BEFORE_DEADLINE = 60;
