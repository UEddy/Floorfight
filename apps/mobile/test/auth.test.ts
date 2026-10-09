// Wallet session authorisation, against a fake wallet. The bug this guards:
// a second session reused its token through the deprecated reauthorize and
// every wallet answered -1, "authorization request failed".

import { test } from "node:test";
import assert from "node:assert/strict";
import { ERROR_AUTHORIZATION_FAILED, authorizeSession, walletErrorMessage, type AuthorizingWallet } from "../src/auth";

const ID = { name: "Floorfight", uri: "https://example.org", icon: "favicon.ico" };

function fakeWallet(rejectToken: string | null) {
  const calls: { chain: string; auth_token?: string }[] = [];
  const wallet: AuthorizingWallet = {
    async authorize(p) {
      calls.push({ chain: p.chain, auth_token: p.auth_token });
      if (p.auth_token && p.auth_token === rejectToken) {
        throw Object.assign(new Error("authorization request failed"), { code: ERROR_AUTHORIZATION_FAILED });
      }
      return { auth_token: `token-${calls.length}`, accounts: [{ address: "AAAA" }] };
    },
  };
  return { wallet, calls };
}

test("a first session authorises on the chain, with no token", async () => {
  const { wallet, calls } = fakeWallet(null);
  const r = await authorizeSession(wallet, undefined, "solana:devnet", ID);
  assert.equal(r.auth_token, "token-1");
  assert.deepEqual(calls, [{ chain: "solana:devnet", auth_token: undefined }]);
});

test("a later session reconnects with authorize, the chain and the cached token", async () => {
  const { wallet, calls } = fakeWallet(null);
  await authorizeSession(wallet, "cached", "solana:devnet", ID);
  assert.deepEqual(calls, [{ chain: "solana:devnet", auth_token: "cached" }]);
});

test("a token the wallet refuses is dropped and the session asks afresh", async () => {
  const { wallet, calls } = fakeWallet("stale");
  const r = await authorizeSession(wallet, "stale", "solana:devnet", ID);
  assert.equal(r.accounts[0].address, "AAAA");
  assert.deepEqual(calls.map((c) => c.auth_token), ["stale", undefined]);
});

test("any other failure is passed through, not retried", async () => {
  let n = 0;
  const wallet: AuthorizingWallet = {
    async authorize() {
      n++;
      throw Object.assign(new Error("closed"), { code: "ERROR_SESSION_CLOSED" });
    },
  };
  await assert.rejects(authorizeSession(wallet, "cached", "solana:devnet", ID));
  assert.equal(n, 1);
});

test("the person sees words, not a protocol code", () => {
  const msg = walletErrorMessage(Object.assign(new Error("authorization request failed"), { code: -1 }));
  assert.ok(!msg.includes("-1"), msg);
  assert.match(msg, /did not approve/);
  assert.equal(walletErrorMessage(Object.assign(new Error("x"), { code: -3 })), "Cancelled in your wallet.");
  assert.equal(walletErrorMessage(new Error("plain")), "plain");
});
