/**
 * SKR balances, read on mainnet, for holder badges and the SKR lounge.
 *
 * Same shape as the NFT check in nft.ts: the server asks, after the wallet
 * has signed a join and so proved it is the wallet it claims to be. The page
 * never says what its balance or tier is, and there is no message in the
 * protocol through which it could: the tier on the roster is what this file
 * returned, and nothing else.
 *
 * One RPC call, getTokenAccountsByOwner filtered by the SKR mint, parsed by
 * the RPC (jsonParsed), so the decimals come from the mint and are never
 * written down here. Every field of the answer is checked: the account's
 * program is a token program, its mint is SKR, its owner is the wallet asked
 * about, the amount is an integer string and the decimals agree across
 * accounts. Anything off is an error, and an error is no badge.
 *
 * The RPC URL can carry an API key (HELIUS_API_KEY, or a key inside
 * RPC_URL_MAINNET). It lives in the server's environment and nowhere else,
 * and errors are rewritten before they leave this file so a failed request
 * cannot echo the URL into a log line or a reply.
 *
 * Fail closed, never fatal: a join waits at most SKR_JOIN_TIMEOUT_MS for this,
 * and a timeout, an RPC error, a malformed answer or a rate limited address
 * all come back as tier 0. A badge is never worth a refused seat.
 */

import { SKR_CACHE_MS, SKR_MINT, skrTier } from "../../shared/skr";
import { RateLimiter, TtlCache } from "./api";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VJS2ZkE9UQ53q7Jy6R7SGd5dKu2e";
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** How long one RPC call may take. */
const RPC_TIMEOUT_MS = 4000;
/** How long a join waits for a badge before going ahead without one. */
export const SKR_JOIN_TIMEOUT_MS = 2500;

export interface SkrBalance {
  /** Raw units, summed over the wallet's SKR token accounts. */
  raw: bigint;
  /** From the mint, via the RPC. Null when the wallet has no SKR account. */
  decimals: number | null;
  tier: number;
}

type Fetch = typeof fetch;

/**
 * Parse a getTokenAccountsByOwner (jsonParsed) result into a balance. Throws
 * on anything that does not look exactly like SKR held by this wallet.
 * Exported for the tests: this is where a hostile or broken RPC answer has
 * to be caught.
 */
export function parseSkrAccounts(result: unknown, wallet: string, mint = SKR_MINT): SkrBalance {
  const value = (result as { value?: unknown })?.value;
  if (!Array.isArray(value)) throw new Error("not a token accounts result");
  let raw = 0n;
  let decimals: number | null = null;
  for (const item of value) {
    const acc = (item as { account?: { owner?: unknown; data?: { parsed?: { type?: unknown; info?: unknown } } } })?.account;
    if (acc?.owner !== TOKEN_PROGRAM && acc?.owner !== TOKEN_2022_PROGRAM) {
      throw new Error("account is not owned by a token program");
    }
    const parsed = acc.data?.parsed;
    if (parsed?.type !== "account") throw new Error("not a token account");
    const info = parsed.info as {
      mint?: unknown; owner?: unknown; state?: unknown;
      tokenAmount?: { amount?: unknown; decimals?: unknown };
    } | undefined;
    if (info?.mint !== mint) throw new Error("token account for another mint");
    if (info.owner !== wallet) throw new Error("token account owned by someone else");
    const amount = info.tokenAmount?.amount;
    const dec = info.tokenAmount?.decimals;
    if (typeof amount !== "string" || !/^[0-9]{1,20}$/.test(amount)) throw new Error("bad amount");
    if (typeof dec !== "number" || !Number.isInteger(dec) || dec < 0 || dec > 18) throw new Error("bad decimals");
    if (decimals !== null && dec !== decimals) throw new Error("decimals disagree");
    decimals = dec;
    // A frozen account still holds its tokens, but it cannot move them;
    // it counts like any other balance. Uninitialized accounts hold nothing.
    if (info.state === "uninitialized") continue;
    raw += BigInt(amount);
  }
  return { raw, decimals, tier: decimals === null ? 0 : skrTier(raw, decimals) };
}

export class SkrService {
  private cache: TtlCache<SkrBalance>;
  /** Badge reads at join, per address: a cheap thing to ask for, so bounded. */
  private joins: RateLimiter;

  constructor(
    private rpcUrl: string,
    private fetchFn: Fetch = fetch,
    now: () => number = Date.now,
  ) {
    this.cache = new TtlCache<SkrBalance>(SKR_CACHE_MS, 5000, now);
    this.joins = new RateLimiter(20, 10, now);
  }

  /** A wallet's balance, cached for a minute. Throws on any failure. */
  balance(wallet: string): Promise<SkrBalance> {
    if (!BASE58_RE.test(wallet)) return Promise.reject(new Error("not a wallet address"));
    return this.cache.get(wallet, () => this.read(wallet));
  }

  /**
   * The tier to put on the roster for a wallet that has just signed a join.
   * Never throws and never takes longer than SKR_JOIN_TIMEOUT_MS: tier 0 on
   * any failure, a timeout, or an address over its rate.
   */
  async tierAtJoin(wallet: string, ip: string): Promise<number> {
    if (!this.joins.take(ip)) return 0;
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), SKR_JOIN_TIMEOUT_MS); });
      const b = await Promise.race([this.balance(wallet), timeout]);
      return b ? b.tier : 0;
    } catch {
      return 0;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async read(wallet: string): Promise<SkrBalance> {
    let res: Response;
    try {
      res = await this.fetchFn(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: "floorfight-skr", method: "getTokenAccountsByOwner",
          params: [wallet, { mint: SKR_MINT }, { encoding: "jsonParsed", commitment: "confirmed" }],
        }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        redirect: "error",
      });
    } catch {
      // Not the original error: it can carry the URL, and the URL can carry a key.
      throw new Error("SKR balance request failed");
    }
    if (!res.ok) throw new Error(`SKR balance request answered ${res.status}`);
    const body = await res.json().catch(() => null) as { result?: unknown; error?: unknown } | null;
    if (!body || body.error || body.result === undefined) throw new Error("SKR balance request returned an error");
    return parseSkrAccounts(body.result, wallet);
  }
}

/**
 * From the environment: RPC_URL_MAINNET if set, else Helius mainnet with
 * HELIUS_API_KEY, else null (no badges, no lounge). Deliberately not RPC_URL,
 * which is the cluster the escrow lives on and is devnet for now: SKR is a
 * mainnet token and reading it off devnet would always say zero.
 */
export function skrFromEnv(env: NodeJS.ProcessEnv): SkrService | null {
  const url = env.RPC_URL_MAINNET;
  if (url) {
    // https only, except a loopback address, which is what the tests use.
    if (!/^https:\/\//.test(url) && !/^http:\/\/127\.0\.0\.1[:/]/.test(url)) {
      throw new Error("RPC_URL_MAINNET must be an https URL");
    }
    return new SkrService(url);
  }
  const key = env.HELIUS_API_KEY;
  if (key && /^[A-Za-z0-9-]{8,128}$/.test(key)) {
    return new SkrService(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`);
  }
  return null;
}
