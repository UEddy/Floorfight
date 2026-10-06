// A phone on mobile data drops and comes back. Against a real server: the
// same guest key signing the same match id gets the same seat in the running
// match, and a backlog of inputs arriving at once after a stall is let
// through rather than kicked.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION, joinMessage, type ServerMsg } from "../../shared/protocol";
import { startServer, type Server } from "./spawn";

let server: Server;

before(async () => {
  server = await startServer({ FREE_FILL_MS: "200" });
});

after(() => {
  server?.proc.kill();
});

interface Session {
  ws: WebSocket;
  slot: number;
  matchId: string;
  /** Every message after accepted, in order. */
  seen: ServerMsg[];
  kicked: () => string | null;
}

/**
 * Connect and join. With `matchId` the guest signs that match rather than
 * the one the server offers, which is what a reconnecting client does.
 */
function join(keys: nacl.SignKeyPair, matchId?: string): Promise<Session> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const timer = setTimeout(() => reject(new Error("never seated")), 15_000);
    const seen: ServerMsg[] = [];
    let kick: string | null = null;
    let target = matchId ?? "";
    ws.on("error", reject);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMsg;
      if (msg.t === "kick") kick = msg.reason;
      if (msg.t === "challenge") {
        target = matchId ?? msg.freeMatchId ?? "";
        const sig = nacl.sign.detached(
          new TextEncoder().encode(joinMessage(target, msg.nonce)), keys.secretKey,
        );
        ws.send(JSON.stringify({
          t: "join", v: PROTOCOL_VERSION, matchId: target,
          wallet: bs58.encode(keys.publicKey), sig: bs58.encode(sig),
        }));
        return;
      }
      if (msg.t === "accepted") {
        clearTimeout(timer);
        resolve({ ws, slot: msg.slot, matchId: target, seen, kicked: () => kick });
        return;
      }
      seen.push(msg);
    });
  });
}

const until = async (pred: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return pred();
};

test("a dropped guest rejoins the running match in the same seat", async () => {
  const keys = nacl.sign.keyPair();
  const first = await join(keys);
  assert.ok(await until(() => first.seen.some((m) => m.t === "snap"), 5000), "the match never started");
  first.ws.terminate(); // no close frame, the way a phone losing signal looks
  await new Promise((r) => setTimeout(r, 300));

  const again = await join(keys, first.matchId);
  assert.equal(again.slot, first.slot, "came back in a different seat");
  assert.ok(await until(() => again.seen.some((m) => m.t === "snap"), 3000), "no snapshots after rejoining");
  again.ws.close();
});

test("a stall's backlog of inputs is let through, not kicked", async () => {
  const keys = nacl.sign.keyPair();
  const s = await join(keys);
  // Two seconds of a phone's inputs, arriving at once.
  for (let t = 0; t < 120; t++) {
    s.ws.send(JSON.stringify({ t: "input", batch: [{
      tick: t, view: 0, moveX: 0, moveY: 127, yaw: 0, pitch: 0, fire: 0, jump: 0, reload: 0, weapon: 0,
    }] }));
  }
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(s.kicked(), null, `kicked: ${s.kicked()}`);
  assert.equal(s.ws.readyState, WebSocket.OPEN);
  s.ws.close();
});
