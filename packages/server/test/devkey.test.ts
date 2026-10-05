// Who gets a seat, against the real server.
//
// Two things are being tested. The dev seat keys are public, so a server with
// dev mode off must refuse them however it is asked. And a free room must
// seat any key that signs the nonce, because that is what free play is: a
// guest key made up in a browser tab, with no roster to be on.
//
// These run the real server as a child process and go through the real
// handshake: challenge, signed join, response.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION, joinMessage, type ServerMsg } from "../../shared/protocol";
import { DEV_MATCH_ID, DEV_SEATS, devSeedLabel } from "../../shared/dev";

const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function devKeypair(seat: number): nacl.SignKeyPair {
  const seed = nacl.hash(new TextEncoder().encode(devSeedLabel(seat))).slice(0, 32);
  return nacl.sign.keyPair.fromSeed(seed);
}

interface Server {
  port: number;
  proc: ChildProcess;
}

async function startServer(dev: boolean): Promise<Server> {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) };
  delete env.HOST;
  delete env.ARENA_DEV;
  delete env.NODE_ENV;
  if (dev) env.ARENA_DEV = "1";

  const proc = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: SERVER_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 30_000);
    const onData = (d: Buffer) => {
      out += d.toString();
      if (out.includes(`listening on 127.0.0.1:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    proc.on("exit", (code) => reject(new Error(`server exited with ${code}:\n${out}`)));
  });
  return { port, proc };
}

/**
 * Run the handshake with a correctly signed join and return the verdict.
 *
 * `matchId` of "free" means take whatever free room the challenge offered,
 * which is what a guest tab does: the server names the room, the client signs
 * that name, so the signature covers the match actually being joined.
 */
function join(
  port: number, keys: nacl.SignKeyPair, matchId: string | "free" = DEV_MATCH_ID,
): Promise<ServerMsg & { offered?: string | null }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => reject(new Error("no verdict from server")), 10_000);
    let offered: string | null = null;
    ws.on("error", reject);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMsg;
      if (msg.t === "challenge") {
        offered = msg.freeMatchId;
        const target = matchId === "free" ? (offered ?? "none-offered") : matchId;
        const sig = nacl.sign.detached(
          new TextEncoder().encode(joinMessage(target, msg.nonce)),
          keys.secretKey,
        );
        ws.send(JSON.stringify({
          t: "join",
          v: PROTOCOL_VERSION,
          matchId: target,
          wallet: bs58.encode(keys.publicKey),
          sig: bs58.encode(sig),
        }));
        return;
      }
      if (msg.t === "kick" || msg.t === "accepted") {
        clearTimeout(timer);
        ws.close();
        resolve({ ...msg, offered });
      }
    });
  });
}

let prod: Server;
let dev: Server;

before(async () => {
  [prod, dev] = await Promise.all([startServer(false), startServer(true)]);
});

after(() => {
  prod?.proc.kill();
  dev?.proc.kill();
});

test("with dev mode off, every dev key is refused with reason 'dev key'", async () => {
  for (let seat = 0; seat < DEV_SEATS; seat++) {
    const verdict = await join(prod.port, devKeypair(seat));
    assert.deepEqual(
      { t: verdict.t, reason: (verdict as { reason?: string }).reason },
      { t: "kick", reason: "dev key" },
      `seat ${seat}`,
    );
  }
});

test("with dev mode off, the refusal does not depend on the match id", async () => {
  const verdict = await join(prod.port, devKeypair(0), "some-real-match");
  assert.deepEqual(
    { t: verdict.t, reason: (verdict as { reason?: string }).reason },
    { t: "kick", reason: "dev key" },
  );
});

test("with dev mode off, a non-dev key is not refused as a dev key", async () => {
  const verdict = await join(prod.port, nacl.sign.keyPair());
  assert.equal(verdict.t, "kick");
  assert.notEqual((verdict as { reason: string }).reason, "dev key");
});

test("with dev mode on, a dev key is seated", async () => {
  const verdict = await join(dev.port, devKeypair(0));
  assert.equal(verdict.t, "accepted");
  assert.equal((verdict as { slot: number }).slot, 0);
});

test("the challenge offers a free room to anyone who connects", async () => {
  const verdict = await join(prod.port, nacl.sign.keyPair(), "free");
  assert.equal(verdict.t, "accepted", JSON.stringify(verdict));
  assert.ok(verdict.offered, "the challenge should name a free room");
  assert.match(verdict.offered!, /^free-/);
});

test("a free room seats any key that signs the nonce", async () => {
  // Three strangers, three seats, in the order they arrived. No roster, no
  // allow list, nothing to be on.
  const seats: number[] = [];
  for (let i = 0; i < 3; i++) {
    const verdict = await join(prod.port, nacl.sign.keyPair(), "free");
    assert.equal(verdict.t, "accepted", JSON.stringify(verdict));
    seats.push((verdict as { slot: number }).slot);
  }
  assert.deepEqual([...new Set(seats)].length, seats.length, "two guests shared a slot");
});

test("a dev key is refused from a free room too, with dev mode off", async () => {
  // The ban is checked before anything about which room is being joined, so
  // free play does not become a way around it.
  const verdict = await join(prod.port, devKeypair(0), "free");
  assert.deepEqual(
    { t: verdict.t, reason: (verdict as { reason?: string }).reason },
    { t: "kick", reason: "dev key" },
  );
});

test("a signature for one match does not get you into another", async () => {
  // Sign the name of the free room, then try to use it on the dev room.
  const keys = nacl.sign.keyPair();
  const ws = new WebSocket(`ws://127.0.0.1:${dev.port}`);
  const verdict = await new Promise<ServerMsg>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no verdict")), 10_000);
    ws.on("error", reject);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMsg;
      if (msg.t === "challenge") {
        const signedFor = msg.freeMatchId ?? "free";
        const sig = nacl.sign.detached(
          new TextEncoder().encode(joinMessage(signedFor, msg.nonce)),
          keys.secretKey,
        );
        // Claim to be joining the dev room with a signature over the free one.
        ws.send(JSON.stringify({
          t: "join",
          v: PROTOCOL_VERSION,
          matchId: DEV_MATCH_ID,
          wallet: bs58.encode(keys.publicKey),
          sig: bs58.encode(sig),
        }));
        return;
      }
      if (msg.t === "kick" || msg.t === "accepted") {
        clearTimeout(timer);
        ws.close();
        resolve(msg);
      }
    });
  });
  assert.equal(verdict.t, "kick");
  assert.equal((verdict as { reason: string }).reason, "bad signature");
});
