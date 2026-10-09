// SKR badges: the balance read, its cache and rate limit, failing closed, and
// against a real server, the lounge gate, the roster and the match log. The
// mainnet RPC is a local stand in that answers getTokenAccountsByOwner the
// way a real one does, so no test talks to mainnet.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { WebSocket } from "ws";
import { SKR_MINT, SKR_TIERS, LOUNGE_MIN_TIER, cleanTier, formatSkr, skrTier } from "../../shared/skr";
import {
  PROTOCOL_VERSION, canonicalise, decanonicalise, joinMessage, type MatchLog, type ServerMsg,
} from "../../shared/protocol";
import { SKR_JOIN_TIMEOUT_MS, SkrService, parseSkrAccounts } from "../src/skr";
import { startServer, type Server } from "./spawn";

const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const WALLET = bs58.encode(nacl.sign.keyPair().publicKey);

/** One parsed token account, as a jsonParsed RPC returns it. */
function account(owner: string, amount: string, decimals: number, over: Record<string, unknown> = {}) {
  return {
    pubkey: bs58.encode(nacl.sign.keyPair().publicKey),
    account: {
      owner: TOKEN,
      data: {
        program: "spl-token",
        parsed: {
          type: "account",
          info: {
            mint: SKR_MINT, owner, state: "initialized",
            tokenAmount: { amount, decimals, uiAmount: Number(amount) / 10 ** decimals },
            ...over,
          },
        },
      },
    },
  };
}

/* ------------------------------------------------------------ parsing --- */

test("a balance is summed over accounts, with the mint's own decimals", () => {
  const b = parseSkrAccounts({ value: [account(WALLET, "1500000", 6), account(WALLET, "500000", 6)] }, WALLET);
  assert.equal(b.raw, 2_000_000n);
  assert.equal(b.decimals, 6);
  assert.equal(b.tier, 1, "2 SKR is the first tier");
  assert.equal(formatSkr(b.raw, 6), "2");
});

test("tiers come from the decimals the RPC reports, never an assumed value", () => {
  // The same raw amount is 1000 SKR at 6 decimals and 1 SKR at 9.
  assert.equal(skrTier(1_000_000_000n, 6), 2);
  assert.equal(skrTier(1_000_000_000n, 9), 1);
  assert.equal(skrTier(999_999n, 6), 0, "just under one SKR is no badge");
  assert.equal(skrTier(BigInt(SKR_TIERS[SKR_TIERS.length - 1].min) * 10n ** 9n, 9), SKR_TIERS.length);
  assert.equal(skrTier(10n, -1), 0);
  assert.equal(skrTier(10n, 1.5), 0);
});

test("no SKR account is no badge", () => {
  const b = parseSkrAccounts({ value: [] }, WALLET);
  assert.equal(b.raw, 0n);
  assert.equal(b.tier, 0);
});

test("anything that is not SKR held by this wallet is refused", () => {
  const other = bs58.encode(nacl.sign.keyPair().publicKey);
  const bad = [
    { value: [account(other, "5", 6)] },                                   // someone else's
    { value: [account(WALLET, "5", 6, { mint: other })] },                  // another mint
    { value: [{ ...account(WALLET, "5", 6), account: { ...account(WALLET, "5", 6).account, owner: other } }] }, // not a token program
    { value: [account(WALLET, "5.5", 6)] },                                 // not an integer amount
    { value: [account(WALLET, "-5", 6)] },
    { value: [account(WALLET, "5", 6), account(WALLET, "5", 9)] },          // decimals disagree
    { value: [account(WALLET, "5", 99)] },
    { value: "nope" },
    null,
  ];
  for (const r of bad) assert.throws(() => parseSkrAccounts(r, WALLET), `should refuse ${JSON.stringify(r)}`);
});

test("a tier from anywhere but the server is cleaned to a number in range or none", () => {
  assert.equal(cleanTier(2), 2);
  for (const v of [-1, 99, 1.5, "2", null, undefined, {}]) assert.equal(cleanTier(v), 0);
});

/* ------------------------------------------------ cache, limits, fail --- */

function rpcFetch(answer: () => unknown, count: { n: number }): typeof fetch {
  return (async () => {
    count.n++;
    return new Response(JSON.stringify(answer()), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

test("a wallet's balance is read once a minute at most", async () => {
  let now = 1_000_000;
  const count = { n: 0 };
  const svc = new SkrService("https://rpc.invalid/?api-key=secret", rpcFetch(
    () => ({ jsonrpc: "2.0", id: 1, result: { value: [account(WALLET, "5000000", 6)] } }), count,
  ), () => now);
  await svc.balance(WALLET);
  await svc.balance(WALLET);
  assert.equal(count.n, 1, "second read within the minute should be cached");
  now += 61_000;
  await svc.balance(WALLET);
  assert.equal(count.n, 2, "after a minute it is read again");
});

test("badge reads at join are rate limited per address, and over the limit is no badge", async () => {
  const count = { n: 0 };
  const svc = new SkrService("https://rpc.invalid/", rpcFetch(
    () => ({ jsonrpc: "2.0", id: 1, result: { value: [account(WALLET, "5000000", 6)] } }), count,
  ));
  const tiers: number[] = [];
  for (let i = 0; i < 25; i++) tiers.push(await svc.tierAtJoin(WALLET, "198.51.100.7"));
  assert.equal(tiers[0], 1);
  assert.ok(tiers.slice(10).every((t) => t === 0), "past the burst, the address gets no badge");
  // Another address is not affected by the first one's use.
  assert.equal(await svc.tierAtJoin(WALLET, "198.51.100.8"), 1);
});

test("every RPC failure is no badge, never an error and never a hang", async () => {
  const failures: (() => Promise<Response>)[] = [
    async () => { throw new Error("connect ECONNREFUSED https://rpc.invalid/?api-key=secret"); },
    async () => new Response("down", { status: 503 }),
    async () => new Response(JSON.stringify({ error: { code: -32000 } }), { status: 200 }),
    async () => new Response("not json", { status: 200 }),
    async () => new Response(JSON.stringify({ result: { value: [account("x", "1", 6)] } }), { status: 200 }),
  ];
  for (const f of failures) {
    const svc = new SkrService("https://rpc.invalid/?api-key=secret", f as unknown as typeof fetch);
    assert.equal(await svc.tierAtJoin(WALLET, "203.0.113.1"), 0);
    await assert.rejects(svc.balance(WALLET), (e: Error) => {
      assert.ok(!e.message.includes("secret"), `error leaks the key: ${e.message}`);
      return true;
    });
  }
});

test("a slow RPC costs a join at most the badge timeout", async () => {
  const svc = new SkrService("https://rpc.invalid/", (() => new Promise(() => {})) as unknown as typeof fetch);
  const t0 = Date.now();
  assert.equal(await svc.tierAtJoin(WALLET, "203.0.113.2"), 0);
  const took = Date.now() - t0;
  assert.ok(took < SKR_JOIN_TIMEOUT_MS + 500, `took ${took} ms`);
});

/* -------------------------------------------------------------- the log --- */

test("the badge tier is in the canonical log from version 9, and older logs keep their bytes", () => {
  const base = {
    matchId: "m", map: "x", spreadSalt: "00", startedAt: 1, ticks: [], standings: [],
    roster: [
      { slot: 0, wallet: "a", collection: null, mint: null, skr: 2 },
      { slot: 1, wallet: "b", collection: null, mint: null, skr: 0 },
    ],
  };
  const v9: MatchLog = { v: 9, ...base };
  const text = canonicalise(v9);
  assert.ok(text.includes('[0,"a",null,null,2]'), text);
  const back = decanonicalise(text)!;
  assert.equal(back.roster[0].skr, 2);
  assert.equal(canonicalise(back), text);
  // A version 8 log has four columns and must hash exactly as it did.
  const v8text = canonicalise({ ...v9, v: 8 });
  assert.ok(v8text.includes('[0,"a",null,null]'), v8text);
  assert.equal(canonicalise(decanonicalise(v8text)!), v8text);
});

/* ------------------------------------------------------- a real server --- */

const holder = nacl.sign.keyPair();
const pauper = nacl.sign.keyPair();
let rpc: HttpServer;
let server: Server;
const rpcCalls: string[] = [];

before(async () => {
  // A stand in for mainnet: the holder has 2000 SKR at 6 decimals, anyone
  // else has none.
  rpc = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const msg = JSON.parse(body) as { method: string; params: [string, { mint: string }] };
      rpcCalls.push(msg.params[0]);
      const owner = msg.params[0];
      const value = owner === bs58.encode(holder.publicKey) && msg.params[1].mint === SKR_MINT
        ? [account(owner, "2000000000", 6)]
        : [];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value } }));
    });
  });
  await new Promise<void>((r) => rpc.listen(0, "127.0.0.1", r));
  const port = (rpc.address() as AddressInfo).port;
  server = await startServer({ RPC_URL_MAINNET: `http://127.0.0.1:${port}/`, FREE_FILL_MS: "60000" });
});

after(() => {
  server?.proc.kill();
  rpc?.close();
});

interface Joined { msg: ServerMsg; roster?: { slot: number; wallet: string; skr?: number }[]; slot?: number }

/**
 * Connect, take the challenge, sign a join for the lounge or the free room
 * and send it, with `extra` fields added to the join message as a hostile
 * client would. Resolves with the server's answer: accepted or kick.
 */
function join(keys: nacl.SignKeyPair, which: "lounge" | "free", extra: Record<string, unknown> = {}): Promise<Joined> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const timer = setTimeout(() => reject(new Error(`no answer:\n${server.output()}`)), 15_000);
    ws.on("error", reject);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMsg;
      if (msg.t === "challenge") {
        const matchId = which === "lounge" ? msg.loungeMatchId : msg.freeMatchId;
        if (!matchId) { reject(new Error(`no ${which} room offered`)); return; }
        const sig = nacl.sign.detached(new TextEncoder().encode(joinMessage(matchId, msg.nonce)), keys.secretKey);
        ws.send(JSON.stringify({
          t: "join", v: PROTOCOL_VERSION, matchId,
          wallet: bs58.encode(keys.publicKey), sig: bs58.encode(sig), ...extra,
        }));
        return;
      }
      if (msg.t === "accepted" || msg.t === "kick") {
        clearTimeout(timer);
        ws.close();
        resolve({ msg, roster: msg.t === "accepted" ? msg.roster : undefined, slot: msg.t === "accepted" ? msg.slot : undefined });
      }
    });
  });
}

test("a holder above the threshold is seated in the lounge with their tier on the roster", async () => {
  const r = await join(holder, "lounge");
  assert.equal(r.msg.t, "accepted", JSON.stringify(r.msg));
  const me = r.roster!.find((e) => e.slot === r.slot)!;
  assert.equal(me.wallet, bs58.encode(holder.publicKey));
  assert.equal(me.skr, 2, "2000 SKR is the second tier");
  assert.ok(rpcCalls.includes(bs58.encode(holder.publicKey)), "the balance was read from the RPC");
});

test("a wallet without enough SKR is refused the lounge, and told why", async () => {
  const r = await join(pauper, "lounge");
  assert.equal(r.msg.t, "kick");
  assert.match((r.msg as { reason: string }).reason, /SKR lounge/);
  assert.ok(LOUNGE_MIN_TIER >= 1);
});

test("a client cannot assert its own badge", async () => {
  // A join stuffed with every way of claiming a tier. None of them is part
  // of the protocol, and the roster says what the server read: nothing.
  const r = await join(pauper, "free", { skr: 3, tier: 3, badge: "Patron", roster: [{ skr: 3 }] });
  assert.equal(r.msg.t, "accepted", JSON.stringify(r.msg));
  const me = r.roster!.find((e) => e.slot === r.slot)!;
  assert.equal(me.skr, 0);
  // And in the lounge, claiming a tier does not get a pauper in.
  const l = await join(pauper, "lounge", { skr: 3 });
  assert.equal(l.msg.t, "kick");
});

test("the balance API answers from the server's own read, read only", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/skr/${bs58.encode(holder.publicKey)}`);
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.balance, "2000");
  assert.equal(body.decimals, 6);
  assert.equal(body.tier, 2);
  assert.equal(body.network, "mainnet");
  assert.equal(JSON.stringify(body).includes("127.0.0.1"), false, "no RPC URL in the answer");
  const post = await fetch(`http://127.0.0.1:${server.port}/api/skr/${bs58.encode(holder.publicKey)}`, { method: "POST" });
  assert.equal(post.status, 405);
  const bad = await fetch(`http://127.0.0.1:${server.port}/api/skr/not-a-wallet`);
  assert.equal(bad.status, 400);
});
