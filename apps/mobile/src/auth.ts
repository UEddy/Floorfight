/**
 * Authorising a Mobile Wallet Adapter session, without the native module, so
 * it can be tested on its own.
 *
 * Why this exists: the first version reconnected a second session with
 * `reauthorize({ auth_token, identity })`. That is the MWA 1.x call. It is
 * deprecated in 2.x, it carries no chain, and current wallets answer it with
 * ERROR_AUTHORIZATION_FAILED (-1), most of all for a devnet token. So
 * "connect" worked, and the very next session (creating a match) failed with
 * "-1/authorization request failed", and kept failing because the dead token
 * stayed cached.
 *
 * Now every session calls `authorize` with the chain and, when there is one,
 * the cached token, which is how MWA 2.x reconnects without asking again. If
 * the wallet turns the token down it is dropped and the session asks once
 * more without it, which is the wallet's normal approval screen. Any other
 * failure is passed through untouched.
 */

/** A CAIP-2 chain id, the form MWA 2.x takes: "solana:devnet". */
export type ChainId = `${string}:${string}`;

/** The part of a wallet session this needs. */
export interface AuthorizingWallet {
  authorize(params: {
    chain: ChainId;
    identity: { name: string; uri: string; icon: string };
    auth_token?: string;
  }): Promise<{ auth_token: string; accounts: readonly { address: string }[] }>;
}

/** MWA's protocol error for a refused authorisation. */
export const ERROR_AUTHORIZATION_FAILED = -1;
const ERROR_NOT_SIGNED = -3;
const ERROR_NOT_SUBMITTED = -4;

function codeOf(e: unknown): unknown {
  return typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
}

/**
 * Authorise this session. Returns the result and the token to keep, which is
 * the new one the wallet issued.
 */
export async function authorizeSession(
  wallet: AuthorizingWallet,
  cached: string | undefined,
  chain: ChainId,
  identity: { name: string; uri: string; icon: string },
): Promise<{ auth_token: string; accounts: readonly { address: string }[] }> {
  if (cached) {
    try {
      return await wallet.authorize({ chain, identity, auth_token: cached });
    } catch (e) {
      // A token the wallet no longer honours: forget it and ask afresh. The
      // session is still open, so the person sees the approval screen once.
      if (codeOf(e) !== ERROR_AUTHORIZATION_FAILED) throw e;
    }
  }
  return wallet.authorize({ chain, identity });
}

/**
 * What to tell the person when a wallet request fails. The page shows this
 * text, so it says what happened and what to do, not a protocol code.
 */
export function walletErrorMessage(e: unknown): string {
  const code = codeOf(e);
  if (code === ERROR_AUTHORIZATION_FAILED) {
    return "Your wallet did not approve Floorfight. Open it, make sure it is on devnet, and try again.";
  }
  if (code === ERROR_NOT_SIGNED) return "Cancelled in your wallet.";
  if (code === ERROR_NOT_SUBMITTED) {
    return "Your wallet could not send the transaction. Check you have devnet SOL and try again.";
  }
  if (code === "ERROR_WALLET_NOT_FOUND") {
    return "No Solana wallet app found. Install one that supports Mobile Wallet Adapter, such as Phantom or Solflare.";
  }
  if (code === "ERROR_ASSOCIATION_CANCELLED") return "Cancelled in your wallet.";
  if (code === "ERROR_SESSION_CLOSED" || code === "ERROR_SESSION_TIMEOUT") {
    return "The wallet closed before finishing. Try again.";
  }
  return e instanceof Error ? e.message : "Something went wrong with the wallet.";
}
