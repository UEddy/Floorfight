// The dev seat keys are public, so a server with dev mode off must refuse
// them at join. These tests run the real server as a child process and go
// through the real handshake: challenge, signed join, response.

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
      if (out.includes(`listening on ${port}`)) {
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

/** Run the handshake with a correctly signed join and return the verdict. */
function join(port: number, keys: nacl.SignKeyPair, matchId = DEV_MATCH_ID): Promise<ServerMsg> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => reject(new Error("no verdict from server")), 10_000);
    ws.on("error", reject);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMsg;
      if (msg.t === "challenge") {
        const sig = nacl.sign.detached(
          new TextEncoder().encode(joinMessage(matchId, msg.nonce)),
          keys.secretKey,
        );
        ws.send(JSON.stringify({
          t: "join",
          v: PROTOCOL_VERSION,
          matchId,
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
    assert.deepEqual(verdict, { t: "kick", reason: "dev key" }, `seat ${seat}`);
  }
});

test("with dev mode off, the refusal does not depend on the match id", async () => {
  const verdict = await join(prod.port, devKeypair(0), "some-real-match");
  assert.deepEqual(verdict, { t: "kick", reason: "dev key" });
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
