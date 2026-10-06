// What one address, and the box as a whole, are allowed to ask for.
//
// The first half is the address rule and the counters, tested directly. The
// second half opens real sockets at a real server with small caps, because the
// thing worth being sure of is that the limits are actually wired to the
// connection handler, not that the arithmetic works.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { WebSocket } from "ws";
import {
  MAX_MSGS_PER_SECOND, MAX_MSG_BURST, PROTOCOL_VERSION, joinMessage, type ServerMsg,
} from "../../shared/protocol";
import {
  ConnectionLimits,
  MessageBudget,
  JOIN_DEADLINE_MS,
  MAX_CONNECTIONS,
  MAX_FREE_ROOMS,
  MAX_PER_IP,
  MAX_ROOMS,
  clientIp,
  limitFromEnv,
} from "../src/limits";
import { startServer, type Server } from "./spawn";

/* ------------------------------------------------------------- policy --- */

/**
 * A phone's message stream on mobile data: an input every 60 Hz tick and a
 * pong a second, delivered on time except for one stall of `stallMs`, after
 * which everything sent during it arrives at once. True if the budget lets
 * every message through.
 */
function survivesStall(stallMs: number): boolean {
  const arrivals: number[] = [];
  const stallAt = 3000;
  const late = (t: number) => (t >= stallAt && t < stallAt + stallMs ? stallAt + stallMs : t);
  for (let i = 0; i < 10 * 60; i++) arrivals.push(late(i * (1000 / 60)));
  for (let s = 0; s < 10; s++) arrivals.push(late(s * 1000 + 500));
  arrivals.sort((a, b) => a - b);
  const b = new MessageBudget(MAX_MSGS_PER_SECOND, MAX_MSG_BURST, 0);
  return arrivals.every((t) => b.take(t));
}

test("a phone's stream survives a mobile data stall of up to four seconds", () => {
  for (const ms of [500, 1000, 1500, 2000, 3000, 4000]) {
    assert.ok(survivesStall(ms), `a ${ms} ms stall was kicked`);
  }
});

test("the message budget still caps a flood", () => {
  // 120 a second, steadily: past the burst allowance, refused.
  const b = new MessageBudget(MAX_MSGS_PER_SECOND, MAX_MSG_BURST, 0);
  let refusedAt = -1;
  for (let i = 0; i < 120 * 30; i++) {
    if (!b.take(i * (1000 / 120))) { refusedAt = i; break; }
  }
  assert.ok(refusedAt > 0, "a flood of 120 a second was never refused");
  // The burst is spent at the 30 a second surplus over about ten seconds.
  assert.ok(refusedAt < 120 * 12, `took ${refusedAt} messages to refuse`);
});

test("the caps are the ones the deployment asked for", () => {
  assert.equal(MAX_PER_IP, 8);
  assert.equal(MAX_CONNECTIONS, 200);
  assert.equal(MAX_ROOMS, 20);
  assert.equal(JOIN_DEADLINE_MS, 10_000);
  // Free play never gets the whole room budget: a staked match has money in
  // escrow and must always be able to open.
  assert.ok(MAX_FREE_ROOMS < MAX_ROOMS);
});

/* ------------------------------------------------- the forwarded header --- */

test("the forwarded header is read only from the loopback", () => {
  // Behind Caddy: peer is the loopback, so the header is the client.
  assert.equal(clientIp("127.0.0.1", "203.0.113.7"), "203.0.113.7");
  // Node reports the IPv4 loopback this way on a dual stack listener.
  assert.equal(clientIp("::ffff:127.0.0.1", "203.0.113.7"), "203.0.113.7");

  // Straight at the port: the header is whatever the client felt like
  // sending, so it is ignored completely.
  assert.equal(clientIp("203.0.113.9", "1.2.3.4"), "203.0.113.9");
  assert.equal(clientIp("2001:db8::5", "1.2.3.4"), "2001:db8::5");
  // The IPv6 loopback is a different address and is not trusted either. See
  // the comment in limits.ts: this failing loudly is the point.
  assert.equal(clientIp("::1", "1.2.3.4"), "::1");
});

test("a forged entry in the header cannot pick its own bucket", () => {
  // Caddy appends what it saw, so the rightmost entry is the real client and
  // everything to its left is whatever arrived. Reading the leftmost, which
  // is the usual way this gets written, would let anyone choose an address.
  assert.equal(clientIp("127.0.0.1", "1.2.3.4, 203.0.113.7"), "203.0.113.7");
  assert.equal(
    clientIp("127.0.0.1", "10.0.0.1, 10.0.0.2, 203.0.113.7"),
    "203.0.113.7",
  );
  // A spoofed value on its own is still only one hop, so it is used: there is
  // no way to tell it from a real client's address, which is why the trust
  // boundary is the peer being the loopback and nothing else.
  assert.equal(clientIp("127.0.0.1", "203.0.113.7"), "203.0.113.7");
});

test("a header that is not an address falls back to the peer", () => {
  for (const header of [
    "", "   ", "not-an-ip", "localhost", "999.1.1.1", ",,,", "null",
    "<script>", "1.2.3.4.5",
  ]) {
    assert.equal(clientIp("127.0.0.1", header), "127.0.0.1", `header ${header}`);
  }
  // Absurdly long: ignored rather than parsed.
  assert.equal(clientIp("127.0.0.1", "1.2.3.4,".repeat(300)), "127.0.0.1");
  // Missing peer, which should not happen but must not crash.
  assert.equal(clientIp(undefined, undefined), "unknown");
});

test("ports and brackets come off addresses", () => {
  assert.equal(clientIp("1.2.3.4:5678", undefined), "1.2.3.4");
  assert.equal(clientIp("127.0.0.1", "203.0.113.7:443"), "203.0.113.7");
  assert.equal(clientIp("127.0.0.1", "[2001:db8::1]:443"), "2001:db8::1");
  assert.equal(clientIp("[::ffff:127.0.0.1]:8080", "203.0.113.7"), "203.0.113.7");
  // An IPv6 address without brackets keeps its colons.
  assert.equal(clientIp("127.0.0.1", "2001:db8::1"), "2001:db8::1");
});

test("a header given as a list is treated as one", () => {
  // node hands over an array when the header appears more than once.
  assert.equal(clientIp("127.0.0.1", ["1.2.3.4", "203.0.113.7"]), "203.0.113.7");
});

/* ----------------------------------------------------------- counters --- */

test("a cap per address, and a cap in total", () => {
  const limits = new ConnectionLimits(3, 5);
  assert.equal(limits.admit("a"), "ok");
  assert.equal(limits.admit("a"), "ok");
  assert.equal(limits.admit("a"), "ok");
  assert.equal(limits.admit("a"), "too many from this address");
  assert.equal(limits.countFor("a"), 3, "a refusal must not consume a slot");
  assert.equal(limits.total, 3);

  // Another address has its own allowance, up to the total.
  assert.equal(limits.admit("b"), "ok");
  assert.equal(limits.admit("b"), "ok");
  assert.equal(limits.admit("b"), "server is full");
  assert.equal(limits.total, 5);
  assert.equal(limits.countFor("b"), 2);

  // And the total refusal wins over the per address one, since it is checked
  // first: the box being full is the more useful thing to say.
  assert.equal(limits.admit("c"), "server is full");
});

test("closing a connection gives the slot back", () => {
  const limits = new ConnectionLimits(2, 4);
  limits.admit("a");
  limits.admit("a");
  assert.equal(limits.admit("a"), "too many from this address");
  limits.release("a");
  assert.equal(limits.admit("a"), "ok");

  limits.release("a");
  limits.release("a");
  assert.equal(limits.countFor("a"), 0);
  assert.equal(limits.total, 0);
  // Addresses are forgotten when they let go, so the map cannot grow for
  // every address that has ever connected.
  assert.equal(limits.addresses, 0);
});

test("releasing something that was never admitted changes nothing", () => {
  const limits = new ConnectionLimits(2, 4);
  limits.release("nobody");
  assert.equal(limits.total, 0);
  limits.admit("a");
  limits.release("nobody");
  assert.equal(limits.total, 1, "a stray release must not free somebody else's slot");
});

test("limit overrides are read, and nonsense is ignored", () => {
  assert.equal(limitFromEnv({}, "X", 8), 8);
  assert.equal(limitFromEnv({ X: "" }, "X", 8), 8);
  assert.equal(limitFromEnv({ X: "3" }, "X", 8), 3);
  // Nothing here may be read as "no limit", and nothing may be read as a
  // number other than the one it looks like: "1e3" and "0x10" are typos.
  for (const bad of ["0", "-1", "abc", "2.5", "1e3", "0x10", " ", "8 ", "+8", "Infinity"]) {
    assert.equal(limitFromEnv({ X: bad }, "X", 8), 8, `X=${bad}`);
  }
  assert.equal(limitFromEnv({ X: "200" }, "X", 8), 200);
});

/* ------------------------------------------------- against a real server --- */

let server: Server;

before(async () => {
  // Small caps and a short deadline, so the test does not have to open two
  // hundred sockets or wait ten seconds.
  server = await startServer({
    MAX_PER_IP: "3",
    MAX_CONNECTIONS: "5",
    JOIN_DEADLINE_MS: "700",
  });
});

after(() => {
  server?.proc.kill();
});

interface Opened {
  ws: WebSocket;
  first: Promise<ServerMsg>;
}

/** Open a socket and resolve with whatever the server says first. */
function open(forwardedFor?: string): Opened {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, {
    headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
  });
  const first = new Promise<ServerMsg>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server said nothing")), 10_000);
    ws.on("message", (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()) as ServerMsg);
    });
    ws.on("error", reject);
    ws.on("close", () => {
      clearTimeout(timer);
      reject(new Error("closed without a message"));
    });
  });
  return { ws, first };
}

/** Close these sockets and give the server a moment to notice. */
async function closeAll(opened: Opened[]): Promise<void> {
  for (const o of opened) o.ws.close();
  await new Promise((r) => setTimeout(r, 250));
}

test("a fourth socket from one address is refused", async () => {
  const held: Opened[] = [];
  for (let i = 0; i < 3; i++) {
    const o = open();
    const msg = await o.first;
    assert.equal(msg.t, "challenge", `socket ${i} should have been let in`);
    held.push(o);
  }

  const extra = open();
  const verdict = await extra.first;
  assert.equal(verdict.t, "kick");
  assert.equal((verdict as { reason: string }).reason, "too many from this address");

  // And letting one go makes room again.
  held[0].ws.close();
  await new Promise((r) => setTimeout(r, 250));
  const retry = open();
  assert.equal((await retry.first).t, "challenge");
  held.push(retry);

  await closeAll(held);
});

test("the total cap holds even when every socket is a different address", async () => {
  // Five addresses, five sockets, which is the total cap. Each is inside its
  // own per address allowance, so only the total can stop the sixth.
  const held: Opened[] = [];
  for (let i = 0; i < 5; i++) {
    const o = open(`203.0.113.${10 + i}`);
    assert.equal((await o.first).t, "challenge", `address ${i} should have been let in`);
    held.push(o);
  }

  const extra = open("203.0.113.99");
  const verdict = await extra.first;
  assert.equal(verdict.t, "kick");
  assert.equal((verdict as { reason: string }).reason, "server is full");

  await closeAll(held);
});

test("the forwarded header buckets by address, not by socket", async () => {
  // Four sockets claiming one address: the fourth is over that address's
  // allowance even though the box has room.
  const held: Opened[] = [];
  for (let i = 0; i < 3; i++) {
    const o = open("198.51.100.4");
    assert.equal((await o.first).t, "challenge");
    held.push(o);
  }
  const same = open("198.51.100.4");
  assert.equal((await same.first as { reason: string }).reason, "too many from this address");

  // A different address is still welcome, with the box below its total.
  const other = open("198.51.100.5");
  assert.equal((await other.first).t, "challenge");
  held.push(other);

  await closeAll(held);
});

test("a socket that never joins is closed", async () => {
  const o = open();
  assert.equal((await o.first).t, "challenge");

  const verdict = await new Promise<ServerMsg>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("never kicked")), 10_000);
    o.ws.on("message", (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()) as ServerMsg);
    });
  });
  assert.equal(verdict.t, "kick");
  assert.equal((verdict as { reason: string }).reason, "join timed out");

  // And the slot comes back, so a stream of idle connections cannot lock the
  // server up for longer than the deadline.
  await new Promise((r) => setTimeout(r, 250));
  const after = open();
  assert.equal((await after.first).t, "challenge");
  await closeAll([after]);
});

/**
 * Do the whole handshake as a guest and stay on the socket.
 *
 * Resolves once seated, with a way to wait for whatever the server says next.
 */
function joinAsGuest(port: number): Promise<{
  ws: WebSocket;
  slot: number;
  next: (ms: number) => Promise<ServerMsg | "nothing">;
}> {
  return new Promise((resolve, reject) => {
    const keys = nacl.sign.keyPair();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => reject(new Error("never seated")), 15_000);
    let closedReason: string | null = null;

    ws.on("error", reject);
    ws.on("close", () => {
      if (closedReason === null) closedReason = "closed";
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMsg;
      if (msg.t === "challenge") {
        if (!msg.freeMatchId) {
          clearTimeout(timer);
          reject(new Error("no free room offered"));
          return;
        }
        const sig = nacl.sign.detached(
          new TextEncoder().encode(joinMessage(msg.freeMatchId, msg.nonce)),
          keys.secretKey,
        );
        ws.send(JSON.stringify({
          t: "join", v: PROTOCOL_VERSION, matchId: msg.freeMatchId,
          wallet: bs58.encode(keys.publicKey), sig: bs58.encode(sig),
        }));
        return;
      }
      if (msg.t === "accepted") {
        clearTimeout(timer);
        resolve({
          ws,
          slot: msg.slot,
          // Whatever arrives next, or "nothing" if the socket stays quiet.
          next: (ms: number) => new Promise((res) => {
            const t = setTimeout(() => res("nothing"), ms);
            ws.once("message", (more) => {
              clearTimeout(t);
              res(JSON.parse(more.toString()) as ServerMsg);
            });
            ws.once("close", () => {
              clearTimeout(t);
              res({ t: "kick", reason: closedReason ?? "closed" } as ServerMsg);
            });
          }),
        });
        return;
      }
      if (msg.t === "kick") {
        clearTimeout(timer);
        closedReason = msg.reason;
        reject(new Error(`kicked: ${msg.reason}`));
      }
    });
  });
}

test("a socket that did join is left alone when the deadline passes", async () => {
  // The bug this is here for: a join deadline that is not cleared on a
  // successful join would throw every player out mid match, ten seconds in,
  // and nothing else in the suite stays connected long enough to notice.
  const joined = await joinAsGuest(server.port);
  assert.equal(typeof joined.slot, "number");

  // The deadline on this server is 700 ms, so this is comfortably past it.
  const after = await joined.next(2000);
  if (after !== "nothing") {
    assert.notEqual(after.t, "kick", `was kicked: ${JSON.stringify(after)}`);
  }
  assert.equal(joined.ws.readyState, WebSocket.OPEN, "the socket should still be open");

  joined.ws.close();
  await new Promise((r) => setTimeout(r, 250));
});

test("the room cap stops new rooms being opened", async () => {
  // One room allowed, and no reserve for staked rooms to hide behind. Fill it
  // with real players and the next connection is offered nothing.
  const capped = await startServer({
    MAX_ROOMS: "1",
    MAX_FREE_ROOMS: "1",
    FREE_FILL_MS: "600000",
  });
  try {
    const seated = [];
    for (let i = 0; i < 6; i++) seated.push(await joinAsGuest(capped.port));
    assert.deepEqual(
      [...new Set(seated.map((s) => s.slot))].sort((a, b) => a - b),
      [0, 1, 2, 3, 4, 5],
      "six guests should fill the one room",
    );

    // The room has no seats left, and the cap will not let another open.
    const probe = new WebSocket(`ws://127.0.0.1:${capped.port}`);
    const challenge = await new Promise<ServerMsg>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no challenge")), 10_000);
      probe.on("error", reject);
      probe.on("message", (raw) => {
        clearTimeout(t);
        resolve(JSON.parse(raw.toString()) as ServerMsg);
      });
    });
    assert.equal(challenge.t, "challenge");
    assert.equal(
      (challenge as { freeMatchId: string | null }).freeMatchId,
      null,
      "with every room full and the cap reached there is nothing to offer",
    );
    assert.match(capped.output(), /at capacity/);

    probe.close();
    for (const s of seated) s.ws.close();
    await new Promise((r) => setTimeout(r, 250));
  } finally {
    capped.proc.kill();
  }
});
