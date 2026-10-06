/**
 * Server memory and snapshot size, measured on a real server process.
 *
 *   npm run measure                  four full rooms of guests for 40 seconds
 *   npm run measure -- 1 20          one room, twenty seconds
 *
 * Starts the server the way the droplet runs it (production mode, a 256 MB
 * heap), connects guests that sign in the ordinary way and send input
 * batches at the rate a phone does, and reports:
 *
 *   - resident memory and V8 heap of the server process, idle and loaded
 *   - the largest message the server sent, against MAX_MSG_BYTES
 *
 * The guests strafe and fire so the match logs fill the way a real round
 * fills them, because logs are most of a room's memory.
 */
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import bs58 from "bs58";
import nacl from "tweetnacl";
import WebSocket from "ws";
import { MAX_MSG_BYTES, PROTOCOL_VERSION, joinMessage } from "../../shared/protocol";
import { startServer } from "../test/spawn";

const rooms = Number(process.argv[2] ?? 4);
const seconds = Number(process.argv[3] ?? 40);

function rss(pid: number): { rssMb: number } {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const kb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
  return { rssMb: Math.round(kb / 102.4) / 10 };
}

async function main(): Promise<void> {
  const server = await startServer({
    NODE_ENV: "production",
    NODE_OPTIONS: "--max-old-space-size=256",
    FREE_FILL_MS: "500",
    MAX_PER_IP: "200",
  });
  const pid = server.proc.pid!;
  await sleep(3000);
  const idle = rss(pid);
  console.log(`idle: ${idle.rssMb} MB resident`);

  let maxMsg = 0;
  let maxSnap = 0;
  const sockets: WebSocket[] = [];
  let seq = 0;
  for (let i = 0; i < rooms * 6; i++) {
    const keys = nacl.sign.keyPair();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    sockets.push(ws);
    ws.on("message", (raw) => {
      const text = raw.toString();
      if (text.length > maxMsg) maxMsg = text.length;
      const msg = JSON.parse(text);
      if (msg.t === "snap" && text.length > maxSnap) maxSnap = text.length;
      if (msg.t === "challenge" && msg.freeMatchId) {
        const sig = nacl.sign.detached(
          new TextEncoder().encode(joinMessage(msg.freeMatchId, msg.nonce)), keys.secretKey,
        );
        ws.send(JSON.stringify({
          t: "join", v: PROTOCOL_VERSION, matchId: msg.freeMatchId,
          wallet: bs58.encode(keys.publicKey), sig: bs58.encode(sig),
        }));
      }
      if (msg.t === "ping") ws.send(JSON.stringify({ t: "pong", id: msg.id }));
    });
    // Staggered, so each fills the room the server is offering.
    await sleep(60);
  }

  // Inputs at 20 batches a second of three ticks each, which is what the
  // client sends, with movement and fire so the logs carry real content.
  const timer = setInterval(() => {
    for (const ws of sockets) {
      if (ws.readyState !== ws.OPEN) continue;
      const batch = [];
      for (let k = 0; k < 3; k++) {
        const t = seq++;
        batch.push({
          tick: t, view: 0, moveX: (t % 255) - 127, moveY: 100, yaw: (t * 37) % 8192, pitch: 0,
          fire: t % 3 === 0 ? 1 : 0, jump: t % 90 === 0 ? 1 : 0, reload: 0, weapon: 0,
        });
      }
      ws.send(JSON.stringify({ t: "input", batch }));
    }
  }, 50);

  let peak = 0;
  for (let s = 0; s < seconds; s++) {
    await sleep(1000);
    peak = Math.max(peak, rss(pid).rssMb);
  }
  clearInterval(timer);
  const loaded = rss(pid);
  for (const ws of sockets) ws.close();
  server.proc.kill();

  console.log(`loaded (${rooms} rooms, ${rooms * 6} guests, ${seconds}s): ${loaded.rssMb} MB resident, peak ${peak} MB`);
  console.log(`largest snapshot ${maxSnap} bytes, largest message ${maxMsg} bytes, cap ${MAX_MSG_BYTES}`);
  console.log(`(the cap is on what clients send; snapshots go the other way and are reported for scale)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
