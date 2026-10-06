// Holders matches without a chain: the lock rule, the lobby that applies it,
// and the read only API. The same rule is exercised against the real program
// in tests/arena.ts at the repo root, under LiteSVM.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Lobbies, lockDecision, type Member } from "../src/lobby";
import { RateLimiter, TtlCache, createApi, detail } from "../src/api";
import type { MatchAccount } from "../src/chain";
import { payoutsFor } from "../src/chain";
import { LOCK_BEFORE_DEADLINE, STAKE_TIERS } from "../../shared/tiers";
import type { LobbyView } from "../../shared/protocol";

const A = "A".repeat(43) + "1";
const B = "B".repeat(43) + "2";
const C = "C".repeat(43) + "3";
const NOW = 1_800_000_000;

function account(over: Partial<MatchAccount> = {}): MatchAccount {
  const players = [A, B, C, "1".repeat(32), "1".repeat(32), "1".repeat(32)];
  return {
    matchId: 42n,
    stake: BigInt(STAKE_TIERS[0].lamports),
    maxPlayers: 6,
    count: 2,
    players,
    state: "Open",
    joinDeadline: NOW + 300,
    settleDeadline: 0,
    placements: [255, 255, 255],
    payouts: [0n, 0n, 0n],
    claimed: 0,
    logHash: new Uint8Array(32),
    ...over,
  };
}

/* --------------------------------------------------------------- rule --- */

test("two joined and both in the lobby locks at once", () => {
  assert.equal(lockDecision(account(), new Set([A, B]), NOW), "lock");
});

test("two joined, one in the lobby, plenty of time: wait", () => {
  assert.equal(lockDecision(account(), new Set([A]), NOW), "wait");
});

test("a minute or less left locks with whoever has joined, present or not", () => {
  const a = account({ joinDeadline: NOW + LOCK_BEFORE_DEADLINE });
  assert.equal(lockDecision(a, new Set([A]), NOW), "lock");
  assert.equal(lockDecision(a, new Set(), NOW), "lock");
});

test("one player never locks, whatever the time", () => {
  const a = account({ count: 1, joinDeadline: NOW + 5 });
  assert.equal(lockDecision(a, new Set([A]), NOW), "wait");
});

test("presence of a wallet that has not joined on chain does not count", () => {
  // C is in the players array beyond count, which the program never reads.
  assert.equal(lockDecision(account(), new Set([A, C]), NOW), "wait");
});

test("past the deadline it is expired, Locked opens the room, the rest are over", () => {
  assert.equal(lockDecision(account({ joinDeadline: NOW - 1 }), new Set([A, B]), NOW), "expired");
  assert.equal(lockDecision(account({ state: "Locked" }), new Set(), NOW), "open-room");
  assert.equal(lockDecision(account({ state: "Settled" }), new Set([A, B]), NOW), "over");
  assert.equal(lockDecision(account({ state: "Refunding" }), new Set([A, B]), NOW), "over");
  assert.equal(lockDecision(null, new Set([A, B]), NOW), "over");
});

/* -------------------------------------------------------------- lobby --- */

interface Probe { member: Member; views: LobbyView[]; entered: string[]; closed: string[] }

function probe(wallet: string): Probe {
  const p: Probe = {
    views: [], entered: [], closed: [],
    member: undefined as unknown as Member,
  };
  p.member = {
    wallet,
    send: (v) => p.views.push(v),
    enter: (id) => p.entered.push(id),
    close: (r) => p.closed.push(r),
  };
  return p;
}

function lobbies(state: { account: MatchAccount; locks: number; opened: number; now: number }) {
  return new Lobbies({
    fetchMatch: async () => state.account,
    lockMatch: async () => {
      state.locks++;
      state.account = { ...state.account, state: "Locked" };
      return "sig";
    },
    openRoom: async () => { state.opened++; return true; },
    nowSeconds: () => state.now,
  });
}

test("the lobby locks once both players are in it and moves them into the room", async () => {
  const state = { account: account(), locks: 0, opened: 0, now: NOW };
  const l = lobbies(state);
  const a = probe(A);
  const b = probe(B);
  l.add("42", state.account, a.member);
  await l.pollAll();
  assert.equal(state.locks, 0, "one of two present must not lock");
  assert.deepEqual(a.views.at(-1)?.present, [true, false]);

  l.add("42", state.account, b.member);
  await l.pollAll();
  assert.equal(state.locks, 1, "lock_match sent exactly once");
  assert.equal(state.opened, 1);
  assert.deepEqual(a.entered, ["42"]);
  assert.deepEqual(b.entered, ["42"]);
  assert.equal(l.size, 0, "the lobby is gone once its room is open");
  l.stop();
});

test("the deadline rule locks with an absent player, and only moves those present", async () => {
  const state = { account: account(), locks: 0, opened: 0, now: NOW };
  const l = lobbies(state);
  const a = probe(A);
  l.add("42", state.account, a.member);
  await l.pollAll();
  assert.equal(state.locks, 0);
  state.now = state.account.joinDeadline - LOCK_BEFORE_DEADLINE;
  await l.pollAll();
  assert.equal(state.locks, 1);
  assert.deepEqual(a.entered, ["42"]);
  l.stop();
});

test("a match that filled and locked itself opens its room without another lock", async () => {
  const state = { account: account({ state: "Locked", count: 6 }), locks: 0, opened: 0, now: NOW };
  const l = lobbies(state);
  const a = probe(A);
  l.add("42", state.account, a.member);
  await l.pollAll();
  assert.equal(state.locks, 0);
  assert.equal(state.opened, 1);
  assert.deepEqual(a.entered, ["42"]);
  l.stop();
});

test("an expired lobby tells its members to claim a refund and closes them", async () => {
  const state = { account: account({ count: 1 }), locks: 0, opened: 0, now: NOW };
  const l = lobbies(state);
  const a = probe(A);
  l.add("42", state.account, a.member);
  state.now = state.account.joinDeadline + 1;
  await l.pollAll();
  assert.equal(state.locks, 0, "a lone player is never locked into a match");
  assert.equal(a.views.at(-1)?.phase, "expired");
  assert.match(a.closed[0] ?? "", /refund/);
  l.stop();
});

test("a failed lock is retried on the next poll, not abandoned", async () => {
  const state = { account: account(), locks: 0, opened: 0, now: NOW };
  let fail = true;
  const l = new Lobbies({
    fetchMatch: async () => state.account,
    lockMatch: async () => {
      if (fail) { fail = false; throw new Error("blockhash not found"); }
      state.locks++;
      state.account = { ...state.account, state: "Locked" };
      return "sig";
    },
    openRoom: async () => { state.opened++; return true; },
    nowSeconds: () => state.now,
  });
  const a = probe(A);
  const b = probe(B);
  l.add("42", state.account, a.member);
  l.add("42", state.account, b.member);
  await l.pollAll();
  await l.pollAll();
  assert.equal(state.locks, 1);
  assert.deepEqual(b.entered, ["42"]);
  l.stop();
});

test("a second socket for the same wallet replaces the first", () => {
  const state = { account: account({ count: 3 }), locks: 0, opened: 0, now: NOW };
  const l = lobbies(state);
  const first = probe(A);
  const second = probe(A);
  l.add("42", state.account, first.member);
  l.add("42", state.account, second.member);
  assert.match(first.closed[0] ?? "", /replaced/);
  l.stop();
});

/* ---------------------------------------------------------------- api --- */

test("the rate limiter allows a burst and then refills over time", () => {
  let t = 0;
  const r = new RateLimiter(60, 3, () => t);
  assert.ok(r.take("x") && r.take("x") && r.take("x"));
  assert.ok(!r.take("x"), "fourth in the same instant is refused");
  assert.ok(r.take("y"), "another address has its own bucket");
  t += 1000;
  assert.ok(r.take("x"), "one token back after a second at 60 a minute");
});

test("the cache serves a value until it expires and collapses concurrent loads", async () => {
  let t = 0;
  let loads = 0;
  const c = new TtlCache<number>(1000, 10, () => t);
  const load = async () => ++loads;
  const [x, y] = await Promise.all([c.get("k", load), c.get("k", load)]);
  assert.equal(x, 1);
  assert.equal(y, 1);
  assert.equal(loads, 1);
  t += 1001;
  assert.equal(await c.get("k", load), 2);
});

async function serve(handler: ReturnType<typeof createApi>): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    void handler(req, res).then((h) => { if (!h) { res.writeHead(404); res.end(); } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

test("GET /api/matches lists open joinable matches at a tier, and nothing else", async () => {
  const listed: bigint[] = [];
  const api = createApi({
    chain: {
      listOpen: async (stake) => {
        listed.push(stake);
        return [
          account({ matchId: 1n, count: 2 }),
          account({ matchId: 2n, count: 6 }),                       // full
          account({ matchId: 3n, count: 1, joinDeadline: NOW + 5 }), // about to close
        ];
      },
      fetchMatch: async () => null,
    },
    nowSeconds: () => NOW,
  });
  const { url, server } = await serve(api);
  try {
    const r = await fetch(`${url}/api/matches?tier=0`);
    assert.equal(r.status, 200);
    const body = await r.json() as { matches: { matchId: string }[] };
    assert.deepEqual(body.matches.map((m) => m.matchId), ["1"]);
    assert.deepEqual(listed, [BigInt(STAKE_TIERS[0].lamports)]);

    assert.equal((await fetch(`${url}/api/matches?tier=9`)).status, 400);
    assert.equal((await fetch(`${url}/api/matches?tier=-1`)).status, 400);
    assert.equal((await fetch(`${url}/api/matches`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${url}/api/match/12x`)).status, 400);
    assert.equal((await fetch(`${url}/api/match/99999999999999999999`)).status, 400, "above u64");
    assert.equal((await fetch(`${url}/api/match/7`)).status, 404);
  } finally {
    server.close();
  }
});

test("a free only server answers the holders endpoints with 503, not an error page", async () => {
  const { url, server } = await serve(createApi({}));
  try {
    assert.equal((await fetch(`${url}/api/matches?tier=0`)).status, 503);
    assert.equal((await fetch(`${url}/api/nfts/${A}`)).status, 503);
    assert.equal((await fetch(`${url}/api/nft-img/${A}`)).status, 503);
  } finally {
    server.close();
  }
});

test("listing is rate limited per address", async () => {
  const api = createApi({ chain: { listOpen: async () => [], fetchMatch: async () => null } });
  const { url, server } = await serve(api);
  try {
    let limited = false;
    for (let i = 0; i < 40 && !limited; i++) {
      limited = (await fetch(`${url}/api/matches?tier=1`)).status === 429;
    }
    assert.ok(limited, "a burst of forty from one address should hit the limit");
  } finally {
    server.close();
  }
});

test("match detail shows computed payouts before settlement and the chain's after", () => {
  const open = detail(account({ count: 3 }));
  assert.deepEqual(open.payouts, payoutsFor(BigInt(STAKE_TIERS[0].lamports), 3).map(String));
  const settled = detail(account({
    state: "Settled", count: 2, placements: [1, 255, 255], payouts: [20_000_000n, 0n, 0n],
  }));
  assert.deepEqual(settled.placements, [1]);
  assert.deepEqual(settled.payouts, ["20000000", "0", "0"]);
});
