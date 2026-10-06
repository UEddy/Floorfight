// The bridge is the security boundary of this app, so it gets tested rather
// than reviewed. Everything here is pure: no wallet, no WebView, no network.
//
//   cd apps/mobile && npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Refused,
  buildJoinMessage,
  fromGameOrigin,
  parseRequest,
  replyScript,
  type SignJoinRequest,
} from "../src/bridge";
import { GAME_ORIGIN } from "../src/config";

const NONCE = "3Qm9VXqk7sQ2bYtRfLpN8cWd4ZjH6aEuT5";

function refusal(raw: string): string {
  try {
    parseRequest(raw);
  } catch (e) {
    assert.ok(e instanceof Refused, `expected Refused, got ${String(e)}`);
    return (e as Refused).message;
  }
  throw new Error(`should have been refused: ${raw}`);
}

/* ------------------------------------------------------------ accepted --- */

test("a well formed signJoin request is accepted", () => {
  const req = parseRequest(JSON.stringify({
    id: "j1", t: "signJoin", v: 5, matchId: "12345", nonce: NONCE,
  }));
  assert.equal(req.t, "signJoin");
  assert.equal((req as SignJoinRequest).matchId, "12345");
  assert.equal((req as SignJoinRequest).nonce, NONCE);
});

test("a well formed escrow request is accepted for all three actions", () => {
  for (const action of ["join", "claim", "refund"] as const) {
    const req = parseRequest(JSON.stringify({ id: "e1", t: "escrow", action, matchId: "7" }));
    assert.equal(req.t, "escrow");
    assert.equal(req.t === "escrow" ? req.action : "", action);
  }
});

test("connect is accepted with nothing but an id", () => {
  const req = parseRequest(JSON.stringify({ id: "c1", t: "connect" }));
  assert.equal(req.t, "connect");
});

test("create is accepted with a tier index into this build's own list", () => {
  for (const tier of [0, 1, 2]) {
    const req = parseRequest(JSON.stringify({ id: "k", t: "escrow", action: "create", tier }));
    assert.equal(req.t === "escrow" && req.action === "create" ? req.tier : -1, tier);
  }
});

/* ------------------------------------------------------------- refused --- */

test("create takes a tier and only a tier: no amount, no id, no count", () => {
  const attempts: unknown[] = [
    { id: "k", t: "escrow", action: "create", tier: 0, lamports: 1 },
    { id: "k", t: "escrow", action: "create", tier: 0, stake: "10000000" },
    { id: "k", t: "escrow", action: "create", tier: 0, matchId: "7" },
    { id: "k", t: "escrow", action: "create", tier: 0, maxPlayers: 2 },
    { id: "k", t: "escrow", action: "create", tier: 0, joinWindow: 3600 },
    { id: "k", t: "escrow", action: "create" },
    { id: "k", t: "escrow", action: "create", tier: 3 },
    { id: "k", t: "escrow", action: "create", tier: -1 },
    { id: "k", t: "escrow", action: "create", tier: 0.5 },
    { id: "k", t: "escrow", action: "create", tier: "0" },
    { id: "k", t: "escrow", action: "create", tier: 1e9 },
    { id: "k", t: "escrow", action: "create", matchId: "7" },
    { id: "c", t: "connect", wallet: "11111111111111111111111111111111" },
    { id: "c", t: "connect", chain: "solana:mainnet" },
  ];
  for (const a of attempts) refusal(JSON.stringify(a));
});


test("there are exactly two requests, and nothing else is one of them", () => {
  // Every one of these is a request shape somebody might reach for, and the
  // whole design rests on none of them existing.
  const attempts: unknown[] = [
    { id: "x", t: "signMessage", message: "anything at all" },
    { id: "x", t: "signTransaction", transaction: "AQABAzfDRg+8zSGK" },
    { id: "x", t: "signAndSendTransaction", tx: [1, 2, 3] },
    { id: "x", t: "signBytes", bytes: [1, 2, 3, 4] },
    { id: "x", t: "transfer", to: "11111111111111111111111111111111", lamports: 1 },
    { id: "x", t: "escrow", action: "join", matchId: "7", lamports: 1 },
    { id: "x", t: "escrow", action: "drain", matchId: "7" },
    { id: "x", t: "signJoin", v: 5, matchId: "12345", nonce: NONCE, message: "override" },
    { id: "x", t: "authorize" },
    { id: "x", t: "" },
    { id: "x" },
  ];
  for (const a of attempts) {
    refusal(JSON.stringify(a));
  }
});

test("a signJoin request with a bad field is refused", () => {
  const base = { id: "j1", t: "signJoin", v: 5, matchId: "12345", nonce: NONCE };
  const bad: Record<string, unknown>[] = [
    { ...base, v: "5" },
    { ...base, v: 5.5 },
    { ...base, v: 0 },
    { ...base, v: 1000 },
    { ...base, matchId: "" },
    { ...base, matchId: "has space" },
    { ...base, matchId: "semi;colon" },
    { ...base, matchId: "a".repeat(65) },
    { ...base, matchId: 12345 },
    { ...base, nonce: "" },
    { ...base, nonce: "tooshort" },
    // Base58 has no 0, O, I or l, so these are not nonces the server issued.
    { ...base, nonce: `0OIl${NONCE}` },
    { ...base, nonce: NONCE + "\n" },
    { ...base, id: "" },
    { ...base, id: "id with space" },
  ];
  for (const b of bad) refusal(JSON.stringify(b));
});

test("an escrow match id must be a plain u64", () => {
  const ok = ["0", "1", "18446744073709551615"];
  for (const matchId of ok) {
    parseRequest(JSON.stringify({ id: "e", t: "escrow", action: "join", matchId }));
  }
  const bad = ["", "-1", "01", "1.0", "1e9", "0x10", " 7", "7 ", "dev", "999999999999999999999"];
  for (const matchId of bad) {
    refusal(JSON.stringify({ id: "e", t: "escrow", action: "join", matchId }));
  }
});

test("malformed messages are refused rather than parsed loosely", () => {
  refusal("");
  refusal("not json");
  refusal("[]");
  refusal("null");
  refusal('"a string"');
  refusal("42");
  // Anything huge: a page should never be sending kilobytes here, and a size
  // limit is cheaper than finding out what a megabyte of JSON does.
  refusal(JSON.stringify({ id: "x", t: "escrow", action: "join", matchId: "1".repeat(4000) }));
});

/* -------------------------------------------------------- join message --- */

test("the join message is built here and matches the template", () => {
  const req: SignJoinRequest = {
    id: "j", t: "signJoin", v: 5, matchId: "12345", nonce: NONCE,
  };
  assert.equal(buildJoinMessage(req), `floorfight:join:v5:12345:${NONCE}`);
  // Must agree with joinMessage() in packages/shared/protocol.ts. If that
  // format changes, both this and the pattern beside it change by hand.
  assert.match(buildJoinMessage(req), /^floorfight:join:v\d+:[A-Za-z0-9_-]+:[1-9A-HJ-NP-Za-km-z]+$/);
});

test("a request that got past parsing could still not widen the message", () => {
  // parseRequest would never produce these, so this is belt and braces on the
  // second check inside buildJoinMessage.
  const forged = [
    { id: "j", t: "signJoin", v: 5, matchId: "a:b", nonce: NONCE },
    { id: "j", t: "signJoin", v: 5, matchId: "x", nonce: `${NONCE}:extra` },
    { id: "j", t: "signJoin", v: 5, matchId: "x\n", nonce: NONCE },
  ] as SignJoinRequest[];
  for (const f of forged) {
    assert.throws(() => buildJoinMessage(f), Refused);
  }
});

/* -------------------------------------------------------------- origin --- */

test("only messages from the game origin are accepted", () => {
  assert.equal(fromGameOrigin(`${GAME_ORIGIN}/`, GAME_ORIGIN), true);
  assert.equal(fromGameOrigin(GAME_ORIGIN, GAME_ORIGIN), true);
  assert.equal(fromGameOrigin(`${GAME_ORIGIN}/?seat=1`, GAME_ORIGIN), true);
  assert.equal(fromGameOrigin(`${GAME_ORIGIN}#x`, GAME_ORIGIN), true);

  for (const url of [
    undefined,
    "",
    "about:blank",
    "file:///android_asset/x.html",
    "http://floorfight.duckdns.org/",
    "https://floorfight.duckdns.org.evil.com/",
    "https://floorfight.duckdns.orgevil.com/",
    "https://evil.com/https://floorfight.duckdns.org",
    "https://user:pass@floorfight.duckdns.org/",
    "javascript:alert(1)",
  ]) {
    assert.equal(fromGameOrigin(url, GAME_ORIGIN), false, `should refuse ${String(url)}`);
  }
});

/* --------------------------------------------------------------- reply --- */

test("a reply is escaped so it cannot inject into the page", () => {
  // Everything that has ever been used to break out of a string literal.
  // The closing script tag is in there for completeness, though it is inert
  // here: this is injected as JavaScript, not written into HTML.
  const nasty = `"';\\\n\r  </script><script>alert(1)</script>`;
  const script = replyScript({ id: "x", ok: false, error: nasty });

  assert.ok(script.includes("MessageEvent"), "should still be a dispatch");
  // Nothing that ends a statement or a string literal survives as itself.
  for (const raw of ["\n", "\r", " ", " "]) {
    assert.ok(!script.includes(raw), `${JSON.stringify(raw)} reached the injected source raw`);
  }
  // The line separators are escaped rather than dropped.
  assert.ok(script.includes("\\u2028"), "U+2028 should be escaped, not removed");
  assert.ok(script.includes("\\u2029"), "U+2029 should be escaped, not removed");

  // And the payload is recoverable: pull the literal back out and parse it
  // twice, which is what the page does.
  const start = script.indexOf("data:") + 5;
  const end = script.indexOf("}));");
  const recovered = JSON.parse(JSON.parse(script.slice(start, end)));
  assert.equal(recovered.error, nasty);
  assert.equal(recovered.id, "x");
  assert.equal(recovered.ok, false);
});
