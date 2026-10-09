/**
 * The HTTP side of the server: a handful of read only GET endpoints under
 * /api, served from the same port as the WebSocket and proxied by Caddy.
 *
 *   GET /api/matches?tier=N    Open holders matches at stake tier N
 *   GET /api/match/:id         one match account, for the results screen
 *   GET /api/nfts/:owner       a wallet's NFTs, for the head picker
 *   GET /api/nft-img/:assetId  one NFT image, same origin so WebGL can use it
 *   GET /api/skr/:owner        a wallet's SKR balance on mainnet and its badge tier
 *
 * Every one of them is a way for an anonymous caller to make this server
 * spend RPC calls, so every one is rate limited per address and cached for a
 * few seconds. The address comes from clientIp, with the same rule as the
 * socket caps: X-Forwarded-For only from the loopback, rightmost entry.
 *
 * Nothing here writes, signs or takes a body. A POST, a PUT or anything else
 * is refused before routing.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { SKR_POT_LABEL, SKR_STAKE_TIERS, STAKE_TIERS, isCurrency, wholeToRaw, type Currency } from "../../shared/tiers";
import { NO_PLACE, matchKey, parseMatchRef, payoutsFor, type MatchAccount, type MatchRef } from "./chain";
import { clientIp } from "./limits";
import { SKR_MINT, formatSkr, tierName } from "../../shared/skr";

/* ------------------------------------------------------------- limits --- */

/**
 * Token bucket per address. `burst` requests at once, refilling at `perMinute`.
 * Bounded: when it holds too many addresses it forgets the oldest, which at
 * worst gives a forgotten address a fresh bucket.
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private perMinute: number,
    private burst: number,
    private now: () => number = Date.now,
    private maxKeys = 10_000,
  ) {}

  take(key: string): boolean {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      b = { tokens: this.burst, at: t };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.burst, b.tokens + ((t - b.at) / 60_000) * this.perMinute);
    b.at = t;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}

/**
 * A small TTL cache that also collapses concurrent misses: ten requests for
 * the same key while the first is still on the RPC wait for that one rather
 * than making ten calls.
 */
export class TtlCache<V> {
  private entries = new Map<string, { at: number; value: Promise<V> }>();

  constructor(
    private ttlMs: number,
    private maxKeys = 2000,
    private now: () => number = Date.now,
  ) {}

  get(key: string, load: () => Promise<V>): Promise<V> {
    const t = this.now();
    const hit = this.entries.get(key);
    if (hit && t - hit.at < this.ttlMs) return hit.value;
    if (this.entries.size >= this.maxKeys) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    const value = load();
    this.entries.set(key, { at: t, value });
    // A failure is not cached: the next caller tries again.
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    return value;
  }
}

/* ----------------------------------------------------------- responses --- */

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function json(res: ServerResponse, status: number, body: unknown, maxAge = 0): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": maxAge > 0 ? `public, max-age=${maxAge}` : "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

/* --------------------------------------------------------------- shapes --- */

/** A match as the page sees it. Strings for u64s, which JSON cannot hold. */
export interface MatchSummary {
  /** A bare number for a SOL match, "skr-" and a number for a token match. */
  matchId: string;
  currency: Currency;
  /** The pot's mint for a token match; null for SOL. */
  mint: string | null;
  stake: string;
  count: number;
  maxPlayers: number;
  joinDeadline: number;
}

export interface MatchDetail extends MatchSummary {
  state: MatchAccount["state"];
  players: string[];
  settleDeadline: number;
  /** Slot numbers, first place first. Only meaningful once Settled. */
  placements: number[];
  /** What the match pays each place, from the chain once Settled, else computed. */
  payouts: string[];
  claimed: number;
  /** Hex sha256 of the match log, once Settled. */
  logHash: string | null;
}

export function summary(a: MatchAccount): MatchSummary {
  return {
    matchId: matchKey({ currency: a.currency, id: a.matchId }),
    currency: a.currency,
    mint: a.mint,
    stake: a.stake.toString(),
    count: a.count,
    maxPlayers: a.maxPlayers,
    joinDeadline: a.joinDeadline,
  };
}

export function detail(a: MatchAccount): MatchDetail {
  const settled = a.state === "Settled";
  return {
    ...summary(a),
    state: a.state,
    players: a.players.slice(0, a.count),
    settleDeadline: a.settleDeadline,
    placements: settled ? a.placements.filter((p) => p !== NO_PLACE) : [],
    payouts: (settled ? a.payouts : payoutsFor(a.stake, a.count)).map(String),
    claimed: a.claimed,
    logHash: settled ? Buffer.from(a.logHash).toString("hex") : null,
  };
}

/* --------------------------------------------------------------- router --- */

export interface ApiDeps {
  /** Absent on a free only server: the match endpoints answer 503. */
  chain?: {
    listOpen: (currency: Currency, stake: bigint) => Promise<MatchAccount[]>;
    fetchMatch: (ref: MatchRef) => Promise<MatchAccount | null>;
    /**
     * Decimals of the token pot mint, read from the chain. Absent when the
     * server has no SKR_POT_MINT, and then token listings answer 503.
     */
    potDecimals?: () => Promise<number>;
  };
  /** Absent without HELIUS_API_KEY: the NFT endpoints answer 503. */
  nfts?: {
    list: (owner: string) => Promise<unknown>;
    image: (assetId: string) => Promise<{ type: string; body: Buffer }>;
  };
  /** Absent without a mainnet RPC: the SKR endpoint answers 503. */
  skr?: {
    balance: (owner: string) => Promise<{ raw: bigint; decimals: number | null; tier: number }>;
  };
  nowSeconds?: () => number;
}

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Build the /api handler. Returns a function that answers the request and
 * returns true if the path was under /api, or false so the caller can 404.
 */
export function createApi(deps: ApiDeps) {
  const now = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  // Listing is the expensive call (getProgramAccounts). Cached per tier for
  // five seconds, so the RPC sees at most one call per tier per five seconds
  // whatever the traffic.
  const listCache = new TtlCache<MatchAccount[]>(5000, 16);
  const matchCache = new TtlCache<MatchAccount | null>(3000);
  const nftCache = new TtlCache<unknown>(60_000, 2000);
  const imageCache = new TtlCache<{ type: string; body: Buffer }>(10 * 60_000, 300);

  const general = new RateLimiter(120, 30);
  const images = new RateLimiter(60, 20);

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) return false;
    try {
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "GET only");
      const ip = clientIp(req.socket.remoteAddress, req.headers["x-forwarded-for"]);
      const path = url.pathname;

      if (path.startsWith("/api/nft-img/")) {
        if (!images.take(ip)) throw new HttpError(429, "slow down");
        if (!deps.nfts) throw new HttpError(503, "NFT heads are not configured on this server");
        const id = path.slice("/api/nft-img/".length);
        if (!BASE58_RE.test(id)) throw new HttpError(400, "not an asset id");
        const img = await imageCache.get(id, () => deps.nfts!.image(id));
        res.writeHead(200, {
          "Content-Type": img.type,
          "Content-Length": img.body.length,
          "Cache-Control": "public, max-age=3600",
          "X-Content-Type-Options": "nosniff",
          // Served as an image to be drawn, never as a document to be run.
          "Content-Security-Policy": "default-src 'none'; sandbox",
        });
        res.end(req.method === "HEAD" ? undefined : img.body);
        return true;
      }

      if (!general.take(ip)) throw new HttpError(429, "slow down");

      if (path === "/api/matches") {
        if (!deps.chain) throw new HttpError(503, "holders matches are not configured on this server");
        const raw = url.searchParams.get("tier") ?? "";
        if (!/^[0-9]{1,2}$/.test(raw) || Number(raw) >= STAKE_TIERS.length) {
          throw new HttpError(400, "unknown tier");
        }
        const tier = Number(raw);
        // A currency from the fixed list, SOL when absent so older pages
        // keep working. The stake is the tier's, never a number from the URL.
        const cur = url.searchParams.get("currency") ?? "sol";
        if (!isCurrency(cur)) throw new HttpError(400, "unknown currency");
        let stake: bigint;
        let decimals: number | null = null;
        if (cur === "sol") {
          stake = BigInt(STAKE_TIERS[tier].lamports);
        } else {
          if (!deps.chain.potDecimals) throw new HttpError(503, "token pots are not configured on this server");
          if (tier >= SKR_STAKE_TIERS.length) throw new HttpError(400, "unknown tier");
          decimals = await deps.chain.potDecimals();
          stake = wholeToRaw(SKR_STAKE_TIERS[tier].whole, decimals);
        }
        const all = await listCache.get(`${cur}:${tier}`, () => deps.chain!.listOpen(cur, stake));
        const t = now();
        const open = all
          // Joinable: still Open (the filter says so), seats left, and with
          // enough window left that joining is not a race against the lock.
          .filter((a) => a.count < a.maxPlayers && a.joinDeadline - t > 15)
          .sort((a, b) => b.count - a.count || a.joinDeadline - b.joinDeadline)
          .slice(0, 50)
          .map(summary);
        json(res, 200, {
          tier,
          currency: cur,
          label: cur === "sol" ? "SOL" : SKR_POT_LABEL,
          decimals: cur === "sol" ? 9 : decimals,
          stake: stake.toString(),
          matches: open,
        }, 3);
        return true;
      }

      if (path.startsWith("/api/match/")) {
        if (!deps.chain) throw new HttpError(503, "holders matches are not configured on this server");
        const id = path.slice("/api/match/".length);
        const ref = parseMatchRef(id);
        if (!ref) throw new HttpError(400, "not a match id");
        if (ref.currency !== "sol" && !deps.chain.potDecimals) {
          throw new HttpError(503, "token pots are not configured on this server");
        }
        const a = await matchCache.get(id, () => deps.chain!.fetchMatch(ref));
        if (!a) throw new HttpError(404, "no such match");
        const decimals = a.currency === "sol" ? 9 : await deps.chain.potDecimals!();
        json(res, 200, {
          ...detail(a),
          label: a.currency === "sol" ? "SOL" : SKR_POT_LABEL,
          decimals,
        }, 2);
        return true;
      }

      if (path.startsWith("/api/nfts/")) {
        if (!deps.nfts) throw new HttpError(503, "NFT heads are not configured on this server");
        const owner = path.slice("/api/nfts/".length);
        if (!BASE58_RE.test(owner)) throw new HttpError(400, "not a wallet address");
        const list = await nftCache.get(owner, () => deps.nfts!.list(owner));
        json(res, 200, list, 30);
        return true;
      }

      if (path.startsWith("/api/skr/")) {
        if (!deps.skr) throw new HttpError(503, "SKR badges are not configured on this server");
        const owner = path.slice("/api/skr/".length);
        if (!BASE58_RE.test(owner)) throw new HttpError(400, "not a wallet address");
        // The service caches each wallet for a minute, so this is one RPC
        // call per wallet per minute whatever the traffic.
        const b = await deps.skr.balance(owner);
        json(res, 200, {
          owner,
          mint: SKR_MINT,
          network: "mainnet",
          raw: b.raw.toString(),
          decimals: b.decimals,
          balance: b.decimals === null ? "0" : formatSkr(b.raw, b.decimals),
          tier: b.tier,
          tierName: tierName(b.tier),
        }, 30);
        return true;
      }

      throw new HttpError(404, "not found");
    } catch (e) {
      if (e instanceof HttpError) {
        json(res, e.status, { error: e.message });
      } else {
        // Upstream failures (RPC, DAS, an image host) are not the caller's
        // fault and their messages are not the caller's business.
        console.error(`[api] ${req.url}: ${(e as Error).message}`);
        json(res, 502, { error: "upstream failed" });
      }
      return true;
    }
  };
}
