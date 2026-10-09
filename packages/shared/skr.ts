/**
 * SKR, the Solana Mobile token: holder badges and the SKR lounge.
 *
 * Read only. The server reads a wallet's SKR balance on mainnet after the
 * wallet has proved itself by signing a join, and turns it into a badge
 * tier. Nothing here moves funds, and the badge is cosmetic and access only:
 * it never reaches the simulation, the spread, the damage or the movement.
 *
 * Decimals are not written down anywhere in this file on purpose. They come
 * from the mint, through the RPC's parsed token account, every time a balance
 * is read: a hard coded decimals value that turned out wrong would hand out
 * badges a thousand times too easily or never.
 */

/** SKR on mainnet. */
export const SKR_MINT = "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3";

/**
 * The SKR staking program. Recorded for reference only: its account layout
 * is not published in a form this project could verify, so staked SKR is
 * not read and does not count towards a badge. Only the wallet's own
 * balance does.
 */
export const SKR_STAKING_PROGRAM = "SKRskrmtL83pcL4YqLWt6iPefDqwXQWHSw9S9vz94BZ";

/** Where the menu sends people who want to stake. */
export const SKR_STAKE_URL = "https://stake.solanamobile.com";

/**
 * Badge tiers, in whole SKR, lowest first. Tier 0 is no badge; tier i is
 * held with at least SKR_TIERS[i - 1].min SKR. Edit freely: the server, the
 * menu and the tests all read this list.
 */
export const SKR_TIERS: readonly { name: string; min: number; colour: number }[] = [
  { name: "Holder", min: 1, colour: 0x9be7c4 },
  { name: "Backer", min: 1_000, colour: 0x6ec1ff },
  { name: "Patron", min: 25_000, colour: 0xffd23a },
];

/** The lowest tier allowed into the SKR lounge. */
export const LOUNGE_MIN_TIER = 1;

/** How long a wallet's balance is trusted before it is read again. */
export const SKR_CACHE_MS = 60_000;

/**
 * The tier a raw balance earns, with the mint's own decimals. Integer math
 * only: SKR amounts are u64 and a float would round a large balance.
 */
export function skrTier(raw: bigint, decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || raw <= 0n) return 0;
  const unit = 10n ** BigInt(decimals);
  let tier = 0;
  SKR_TIERS.forEach((t, i) => {
    if (raw >= BigInt(t.min) * unit) tier = i + 1;
  });
  return tier;
}

/** A raw balance as a person reads it, from the mint's decimals. */
export function formatSkr(raw: bigint, decimals: number): string {
  if (decimals <= 0) return raw.toString();
  const unit = 10n ** BigInt(decimals);
  const whole = raw / unit;
  const frac = (raw % unit).toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 2);
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** A tier's name, or null for no badge. */
export function tierName(tier: number): string | null {
  return tier >= 1 && tier <= SKR_TIERS.length ? SKR_TIERS[tier - 1].name : null;
}

/**
 * A roster's tier field as it may be trusted on the client: an integer in
 * range, anything else no badge. The server is the only thing that sets it.
 */
export function cleanTier(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= SKR_TIERS.length ? v : 0;
}
