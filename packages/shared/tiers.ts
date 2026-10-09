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

/**
 * The currencies a holders match can be staked in. The page picks one of
 * these by name and nothing else: it never names a mint, a token account or
 * an amount. "skr" is a devnet test mint for now (see SKR_POT_LABEL), mapped
 * to its address by the native app and by the server's SKR_POT_MINT, never
 * by the page.
 */
export const CURRENCIES = ["sol", "skr"] as const;
export type Currency = (typeof CURRENCIES)[number];

export function isCurrency(v: unknown): v is Currency {
  return typeof v === "string" && (CURRENCIES as readonly string[]).includes(v);
}

/** What the token pot is called wherever a person can see it. */
export const SKR_POT_LABEL = "Test SKR (devnet)";

export interface TokenStakeTier {
  /**
   * Whole tokens each player stakes, as a decimal string. Converted to raw
   * units with the mint's own decimals, read from the chain at the moment
   * of use: decimals are never written down here.
   */
  whole: string;
  label: string;
}

export const SKR_STAKE_TIERS: readonly TokenStakeTier[] = [
  { whole: "10", label: "10 Test SKR" },
  { whole: "50", label: "50 Test SKR" },
  { whole: "100", label: "100 Test SKR" },
];

/** The tier list for a currency. */
export function tiersFor(currency: Currency): readonly { label: string }[] {
  return currency === "sol" ? STAKE_TIERS : SKR_STAKE_TIERS;
}

/**
 * Whole tokens to raw units, in integers only. Throws on anything that is
 * not a plain whole number or that would not fit a u64.
 */
export function wholeToRaw(whole: string, decimals: number): bigint {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(whole)) throw new Error(`${whole} is not a whole number of tokens`);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error(`bad decimals ${decimals}`);
  const raw = BigInt(whole) * 10n ** BigInt(decimals);
  if (raw > 18_446_744_073_709_551_615n) throw new Error("stake does not fit a u64");
  return raw;
}

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
