/**
 * Everything about where this app points, in one file.
 *
 * None of it is configurable at runtime and none of it comes from the page.
 * A build of this app talks to one origin and one program, and if either is
 * wrong the fix is a new build.
 */

/**
 * The game, which is remote, third party as far as this app is concerned, and
 * not to be trusted. Everything the WebView asks for is checked against the
 * rules in bridge.ts before the wallet is ever involved.
 *
 * https only. A plain http origin here would let anyone on the same network
 * rewrite the page and then start asking for signatures.
 */
export const GAME_ORIGIN = "https://floorfight.duckdns.org";
export const GAME_URL = `${GAME_ORIGIN}/`;

/**
 * The escrow program, from Anchor.toml. The IDL in src/idl carries the same
 * address and the two are checked against each other at startup, so a stale
 * IDL copy fails loudly instead of building transactions for the wrong
 * program.
 */
export const PROGRAM_ID = "HoktNWjdhuts9nzV76UyqUn6FCqJ57LwAizFYbjD4TCe";

/**
 * Which cluster. Devnet until the program is deployed to mainnet and the
 * dApp Store question in CLAUDE.md is settled.
 *
 * `chain` is the CAIP-2 identifier Mobile Wallet Adapter authorises against.
 * It and `rpc` have to agree: authorising on devnet and then sending to a
 * mainnet RPC is a confusing failure rather than a loud one.
 */
export const CHAIN = "solana:devnet";
export const RPC_URL = "https://api.devnet.solana.com";

/**
 * How this app introduces itself to the wallet. The wallet shows this to the
 * person deciding whether to authorise, so it has to be honest: the name is
 * the app's name and the uri is the site it actually loads.
 */
export const APP_IDENTITY = {
  name: "Floorfight",
  uri: GAME_ORIGIN,
  icon: "favicon.ico",
};

/** Protocol versions of the join message this build will sign. */
export const MIN_PROTOCOL_VERSION = 5;
export const MAX_PROTOCOL_VERSION = 99;

/** Lamports in one SOL, for the amounts shown on the confirmation sheet. */
export const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Stake tiers for holders matches, in lamports, devnet.
 *
 * This list is the authority on what a create costs. The page asks for a tier
 * by its index and nothing else; this side looks the amount up here, builds
 * the transaction and shows the amount on the confirmation sheet before the
 * wallet opens. packages/shared/tiers.ts has the same amounts for the server
 * and the page's labels, and test/tiers.test.ts fails if the two differ.
 */
export const STAKE_TIERS: readonly bigint[] = [
  10_000_000n,  // 0.01 SOL
  50_000_000n,  // 0.05 SOL
  100_000_000n, // 0.1 SOL
];

/** Every holders match this app creates: six seats, ten minutes to join. */
export const HOLDERS_MAX_PLAYERS = 6;
export const HOLDERS_JOIN_WINDOW = 600;
