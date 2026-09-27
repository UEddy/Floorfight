import { FIRE_COOLDOWN, PITCH_LIMIT, ROUND_TICKS, TICK_HZ, TICK_MS, createWorld, yawToRadians, type Input } from "../../shared/sim";
import { quantAxis, quantPitch, quantYaw, type SnapshotPlayer } from "../../shared/protocol";
import { DEV_MATCH_ID } from "../../shared/dev";
import { devKeypair } from "./keys";
import { Net } from "./net";
import { BATCH_TICKS, Interpolator, Predictor, type RemoteView } from "./netcode";
import { Controls } from "./input";
import { Renderer } from "./render";
import { Hud } from "./hud";

/*
 * URL parameters:
 *   seat    dev seat 0..5, picks which dev keypair signs the join
 *   server  WebSocket URL, defaults to port 8080 on the page's host
 */
const params = new URLSearchParams(location.search);
const seat = Number(params.get("seat") ?? "0");
const serverUrl = params.get("server") ?? `ws://${location.hostname || "localhost"}:8080`;

const canvas = document.getElementById("view") as HTMLCanvasElement;
const controls = new Controls(canvas, document.getElementById("fire")!);
const hud = new Hud(seat);

type Phase = "connecting" | "waiting" | "playing" | "over" | "gone";
let phase: Phase = "connecting";

let slot = seat;
let renderer: Renderer | null = null;
let predictor: Predictor | null = null;
const interp = new Interpolator();
const remotes = new Map<number, RemoteView>();

let seq = 0;
const sent: Input[] = [];
let lastTickAt = 0;
let lastFireSeq = -FIRE_COOLDOWN;
let lastSnap: { tick: number; players: SnapshotPlayer[] } | null = null;
let firstSnap: SnapshotPlayer[] | null = null;
const active = new Set<number>();

/**
 * Remote players the server has killed but the interpolation buffer, 100 ms
 * behind, still shows alive. Keyed by slot, value is the hit's server tick.
 *
 * Display only. The server has already decided the kill; this just stops the
 * body lingering for the length of the buffer. Nothing here feeds prediction,
 * the view tick, or anything sent to the server.
 */
const killedAt = new Map<number, number>();
/** Counters for the dev test hook. Filled from server hit events only. */
const stats = {
  shots: 0, hits: 0, kills: 0, rewinds: [] as number[], corrections: 0, maxCorrection: 0,
  hitsOn: {} as Record<number, number>, lastHitAt: 0,
};
let lastFrame = performance.now();

let keys;
try {
  keys = devKeypair(seat);
} catch (e) {
  hud.message((e as Error).message);
  throw e;
}

hud.message("Connecting...");

const net = new Net(serverUrl, DEV_MATCH_ID, keys, {
  onAccepted(msg) {
    slot = msg.slot;
    hud.setRoster(msg.roster);
    predictor = new Predictor(msg.roster.length, slot);
    renderer = new Renderer(canvas, msg.roster.length);
    // Face the middle of the map from the spawn, which is where the action is.
    const me = createWorld(msg.roster.length).players[slot];
    controls.intent.yaw = Math.atan2(me.x, me.z);
    phase = "waiting";
    hud.message(`Joined as P${slot + 1}. Waiting for another player...`);
  },

  onSnap(msg) {
    if (!predictor) return;
    const now = performance.now();
    if (phase === "waiting") {
      phase = "playing";
      hud.message("");
      lastTickAt = now;
    }
    interp.push(msg.tick, msg.players, now);
    lastSnap = { tick: msg.tick, players: msg.players };

    const me = msg.players.find((p) => p.s === slot);
    if (me) {
      // Count only divergence this snapshot introduced. errX also carries
      // the still-fading remainder of earlier corrections, which is not new.
      const ex = predictor.errX;
      const ez = predictor.errZ;
      predictor.reconcile(msg.ack, me);
      const c = Math.hypot(predictor.errX - ex, predictor.errZ - ez);
      if (c > 0.01) stats.corrections++;
      if (c > stats.maxCorrection) stats.maxCorrection = c;
    }

    if (!firstSnap) firstSnap = msg.players;
    for (const p of msg.players) {
      const f = firstSnap.find((q) => q.s === p.s);
      if (f && (f.x !== p.x || f.z !== p.z || f.y !== p.y)) active.add(p.s);
    }
    active.add(slot);
    hud.scoreboard(msg.players, active);

    for (const h of msg.hits) {
      if (h.shooter === slot) {
        hud.hitMarker(h);
        stats.hits++;
        if (h.lethal) stats.kills++;
        stats.rewinds.push(h.rewind);
        stats.hitsOn[h.victim] = (stats.hitsOn[h.victim] ?? 0) + 1;
        stats.lastHitAt = performance.now();
      }
      if (h.lethal) {
        hud.kill(h);
        if (h.victim !== slot) killedAt.set(h.victim, h.tick);
      }
    }
  },

  onOver(msg) {
    phase = "over";
    document.exitPointerLock();
    hud.message("");
    hud.clock(0);
    hud.showOver(msg.standings, msg.logHash, () => location.reload());
    net.close();
    console.log(`[arena] round over, log hash ${msg.logHash}`, msg.standings);
  },

  onKick(reason) {
    phase = "gone";
    hud.message(`Disconnected: ${reason}`);
  },

  onClose() {
    if (phase !== "over") {
      phase = "gone";
      hud.message("Connection lost. Reload to rejoin.");
    }
  },
});

/* ------------------------------------------------------------ ticking --- */

/**
 * Fixed 60 Hz input loop, separate from rendering. It runs on a timer rather
 * than requestAnimationFrame so a tab that is not the focused one still sends
 * input (browsers throttle it, but do not stop it). Catch-up is capped, so a
 * throttled tab sends a few ticks late rather than a burst of stale ones.
 */
function pump(): void {
  if (phase !== "playing" || !predictor) return;
  const now = performance.now();
  let n = 0;
  while (now - lastTickAt >= TICK_MS && n < 3) {
    tick(now);
    lastTickAt += TICK_MS;
    n++;
  }
  if (now - lastTickAt > 100) lastTickAt = now;
}

function tick(now: number): void {
  const intent = controls.sample();
  const alive = predictor!.me.alive;
  const wantsFire = intent.fire && alive;

  const inp: Input = {
    tick: seq,
    view: interp.viewTick(now),
    moveX: quantAxis(intent.moveX),
    moveY: quantAxis(intent.moveY),
    yaw: quantYaw(intent.yaw),
    pitch: quantPitch(intent.pitch),
    fire: wantsFire ? 1 : 0,
  };
  predictor!.apply(inp);

  // Cosmetic only. The server decides whether the shot was fired and what it
  // hit; this just shows a flash at the same cadence as the server cooldown.
  if (wantsFire && seq - lastFireSeq >= FIRE_COOLDOWN) {
    lastFireSeq = seq;
    stats.shots++;
    renderer?.muzzleFlash(now);
  }

  sent.push(inp);
  if (sent.length > BATCH_TICKS) sent.shift();
  net.send({ t: "input", batch: sent.slice() });
  seq++;
}

setInterval(pump, 4);

/* ---------------------------------------------------------- rendering --- */

function frame(): void {
  requestAnimationFrame(frame);
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  pump();

  if (!renderer || !predictor) return;

  predictor.decayError(dt);
  const me = predictor.me;
  const alpha = phase === "playing" ? Math.min(1, (now - lastTickAt) / TICK_MS) : 1;
  const x = predictor.prevX + (me.x - predictor.prevX) * alpha + predictor.errX;
  const z = predictor.prevZ + (me.z - predictor.prevZ) * alpha + predictor.errZ;

  // Aim is drawn quantised, exactly as it will be sent, so the crosshair and
  // the server's ray agree to the last unit.
  const intent = controls.intent;
  const yaw = yawToRadians(quantYaw(intent.yaw));
  const pitch = (quantPitch(intent.pitch) / 32767) * PITCH_LIMIT;

  if (interp.ready) {
    interp.sample(now, remotes);
    // A kill at server tick T first shows as dead in the snapshot stamped
    // T + 1. Until the buffer reaches that, hide the body ourselves. After it,
    // the snapshots carry the death and the later respawn on their own.
    const rt = interp.renderTick(now);
    for (const [victim, tick] of killedAt) {
      const r = remotes.get(victim);
      if (rt >= tick + 1) killedAt.delete(victim);
      else if (r) r.alive = false;
    }
  }
  renderer.draw(now, { x, z, yaw, pitch }, slot, remotes);

  if (phase === "playing" && interp.ready) {
    hud.clock((ROUND_TICKS - interp.serverTick(now)) / TICK_HZ);
    const self = lastSnap?.players.find((p) => p.s === slot);
    hud.health(self?.h ?? 100, me.alive);
    if (!me.alive) hud.message("Respawning...");
    else if (!controls.locked && !matchMedia("(pointer: coarse)").matches) hud.message("Click to aim");
    else hud.message("");
    hud.netStats(
      `seat ${slot}  view ${interp.viewTick(now)}  server ${Math.floor(interp.serverTick(now))}  unacked ${predictor.pendingCount}`,
    );
  } else if (phase === "waiting") {
    hud.clock(null);
  }
  hud.stickAt(controls.stickVisual);
}
requestAnimationFrame(frame);

/* ----------------------------------------------------------- test hook --- */

// Dev builds only. Lets a headless browser drive a tab the way a player would:
// aim, move and pull the trigger. It goes through the same Controls and the
// same input path as a real player, so it cannot do anything a player cannot.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).arena = {
    aim(yaw: number, pitch: number) {
      controls.intent.yaw = yaw;
      controls.intent.pitch = pitch;
    },
    move(x: number, y: number) { controls.botMove = { x, y }; },
    fire(on: boolean) { controls.botFire = on; },
    peek() {
      return {
        phase,
        me: predictor ? { x: predictor.me.x, z: predictor.me.z, alive: predictor.me.alive } : null,
        remotes: Object.fromEntries(remotes),
        stats,
      };
    },
    state() {
      return {
        phase,
        slot,
        me: predictor ? { x: predictor.me.x, z: predictor.me.z, alive: predictor.me.alive } : null,
        remotes: Object.fromEntries(remotes),
        serverTick: interp.ready ? interp.serverTick(performance.now()) : null,
        board: document.getElementById("board")?.innerText,
        feed: document.getElementById("feed")?.innerText,
        timer: document.getElementById("timer")?.innerText,
        over: document.getElementById("over")?.classList.contains("show")
          ? document.querySelector("#over .card")?.textContent
          : null,
      };
    },
  };
}
