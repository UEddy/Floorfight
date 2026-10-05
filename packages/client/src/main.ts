import {
  EYE_HEIGHT,
  HEAD_TOP,
  PITCH_LIMIT,
  RESPAWN_TICKS,
  ROUND_TICKS,
  TICK_HZ,
  TICK_MS,
  createWorld,
  cosU,
  rayGrid,
  sinU,
  yawToRadians,
  type HitEvent,
  type Input,
} from "../../shared/sim";
import { WEAPONS } from "../../shared/weapons";
import { fromHex, sha256Hex } from "../../shared/sha256";
import { quantAxis, quantPitch, quantYaw, type SnapshotPlayer } from "../../shared/protocol";
import { DEV_MATCH_ID } from "../../shared/dev";
import { devKeypair, guestKeypair } from "./keys";
import { Net } from "./net";
import { BATCH_TICKS, Interpolator, Predictor, type RemoteView } from "./netcode";
import { Controls } from "./input";
import { Renderer } from "./render";
import { Hud, type Plate } from "./hud";
import { Sfx } from "./audio";

/*
 * URL parameters:
 *   seat    dev seat 0..5, picks which dev keypair signs the join
 *   debug   1 shows the performance overlay: fps, 1% low, draw calls, ping
 *   server  dev builds only: WebSocket URL, defaults to port 8080 on the
 *           page's host. Production always uses wss://<page host>/ws
 */
const params = new URLSearchParams(location.search);
const seat = Number(params.get("seat") ?? "0");
/**
 * Dev builds with ?seat=N take a dev seat in the dev room, which is what
 * makes two tabs with known keys useful. Everything else is a guest: a key
 * made up on page load, joining whichever free room the server offers.
 */
const devSeat = import.meta.env.DEV && params.has("seat");
const DEBUG = params.get("debug") === "1";
const serverUrl = import.meta.env.DEV
  ? params.get("server") ?? `ws://${location.hostname || "localhost"}:8080`
  : // Production is always the page's own origin, behind Caddy's TLS. There is
    // deliberately no override: a link that could point the socket elsewhere
    // would let another server relay our challenge and collect a signature.
    `wss://${location.host}/ws`;

const canvas = document.getElementById("view") as HTMLCanvasElement;
const sfx = new Sfx();
const controls = new Controls(
  canvas,
  document.getElementById("fire")!,
  document.getElementById("jump")!,
  document.getElementById("reload")!,
  document.getElementById("swap")!,
  () => sfx.start(),
);
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
let lastFireSeq = -999;
let lastDrySeq = -999;
let lastSnap: { tick: number; players: SnapshotPlayer[] } | null = null;
let firstSnap: SnapshotPlayer[] | null = null;
const active = new Set<number>();

/** Weapon state as the server last reported it. The HUD shows only this. */
let myWeapon = 0;
let myMag = WEAPONS[0].mag;
let myReload = 0;
let rtt = 0;

/** Tick we were killed on, for the respawn countdown, or null if alive. */
let deathTick: number | null = null;

/**
 * The spread salt commitment from the accepted message, kept until the end of
 * the round so the reveal can be checked against it. The server only sends it
 * once, which is the point: a commitment recorded after the fact proves
 * nothing.
 */
let spreadCommit: string | null = null;

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

/* ------------------------------------------------------- frame timing --- */

/**
 * Frame times, for the debug overlay.
 *
 * `fps` is frames in the last second. The one per cent low is the mean of the
 * slowest one per cent of the last thousand frames, expressed as a frame
 * rate: it is the number that says whether the game stutters, which an
 * average frame rate hides completely.
 */
const frameTimes: number[] = [];
const fpsWindow: number[] = [];
let fpsNow = 0;
let onePercentLow = 0;

function recordFrame(now: number, dtMs: number): void {
  frameTimes.push(dtMs);
  if (frameTimes.length > 1000) frameTimes.shift();
  fpsWindow.push(now);
  while (fpsWindow.length > 0 && now - fpsWindow[0] > 1000) fpsWindow.shift();
  fpsNow = fpsWindow.length;
  if (frameTimes.length >= 50) {
    const slowest = [...frameTimes].sort((a, b) => b - a);
    const n = Math.max(1, Math.round(slowest.length * 0.01));
    let sum = 0;
    for (let i = 0; i < n; i++) sum += slowest[i];
    onePercentLow = 1000 / (sum / n);
  }
}

let keys;
try {
  keys = devSeat ? devKeypair(seat) : guestKeypair();
} catch (e) {
  hud.message((e as Error).message);
  throw e;
}

hud.message("Connecting...");

const net = new Net(serverUrl, (challenge) => {
  // A dev seat asks for the dev room by name. A guest takes the room the
  // server offered with the challenge, so the signature covers the id of the
  // match it actually gets rather than a matchmaking alias.
  const matchId = devSeat ? DEV_MATCH_ID : challenge.freeMatchId;
  return matchId ? { matchId, keys } : null;
}, {
  onAccepted(msg) {
    slot = msg.slot;
    spreadCommit = msg.spreadCommit;
    hud.setRoster(msg.roster);
    predictor = new Predictor(msg.roster.length, slot);
    renderer = new Renderer(canvas, msg.roster.length);
    // Face the middle of the hall from the spawn, which is where the clock
    // tower is and where the action tends to be.
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
    rtt = msg.rtt;

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

      // Weapon state belongs to the server. The sounds hang off its changes.
      if (me.g !== myWeapon) {
        sfx.swap();
        controls.syncWeapon(me.g);
      }
      if (myReload === 0 && me.r > 0) sfx.reload((me.r / TICK_HZ) * 1000);
      myWeapon = me.g;
      myMag = me.m;
      myReload = me.r;
      if (me.a === 1 && deathTick !== null) {
        deathTick = null;
        hud.death(null);
        sfx.respawn();
      }
    }

    if (!firstSnap) firstSnap = msg.players;
    for (const p of msg.players) {
      const f = firstSnap.find((q) => q.s === p.s);
      if (f && (f.x !== p.x || f.z !== p.z || f.e !== p.e || f.y !== p.y)) active.add(p.s);
      // Somebody else fired: flash and a tracer along the way they are
      // looking. The server set this flag, so misses are covered too.
      if (p.f === 1 && p.s !== slot) shotByOther(p, now);
    }
    active.add(slot);
    hud.scoreboard(msg.players, active);

    for (const h of msg.hits) onHit(h, now);
  },

  onOver(msg) {
    phase = "over";
    document.exitPointerLock();
    hud.message("");
    hud.clock(0);
    hud.death(null);

    // Check the reveal against the commitment from join. The client can do
    // this on its own, with no help from the server and nothing to trust: it
    // kept the hash, and now it has the bytes.
    const revealed = fromHex(msg.spreadSalt);
    const spread = spreadCommit === null
      ? "unknown"
      : revealed !== null && sha256Hex(revealed) === spreadCommit
        ? "ok"
        : "bad";
    if (spread === "bad") {
      console.error(
        `[arena] spread salt does not match the commitment: committed ` +
        `${spreadCommit}, revealed ${msg.spreadSalt}`,
      );
    } else if (spread === "ok") {
      console.log(`[arena] spread salt verified against ${spreadCommit}`);
    }

    hud.showOver(msg.standings, msg.logHash, spread, () => location.reload());
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

/* ------------------------------------------------------------ feedback --- */

/**
 * One hit event from the server.
 *
 * Every number used here came off the wire: the damage, whether it was a head
 * shot, which weapon it was, who died. The client draws what it was told,
 * which is the only way a damage number can be honest.
 */
function onHit(h: HitEvent, now: number): void {
  if (h.shooter === slot) {
    hud.hitMarker(h);
    sfx.hit(h.head);
    stats.hits++;
    stats.rewinds.push(h.rewind);
    stats.hitsOn[h.victim] = (stats.hitsOn[h.victim] ?? 0) + 1;
    stats.lastHitAt = now;
    if (h.lethal) {
      stats.kills++;
      sfx.kill();
      hud.eliminated(h.victim);
    }
    // Damage number over the victim, where they are being drawn right now.
    const r = remotes.get(h.victim);
    if (r && renderer) {
      const p = renderer.project(r.x, r.y + HEAD_TOP + 0.1, r.z);
      if (p.onScreen) hud.damageNumber(h.damage, h.head, p.sx, p.sy);
    }
  }

  if (h.victim === slot) {
    if (h.lethal) {
      deathTick = h.tick;
      hud.killedBy(h.shooter, h.weapon);
      sfx.death();
    } else {
      sfx.hurt();
    }
  }

  if (h.lethal) {
    hud.kill(h);
    if (h.victim !== slot) killedAt.set(h.victim, h.tick);
    // The body comes apart into blocks. For our own death that happens around
    // the camera, which is as disorienting as it ought to be.
    if (renderer) {
      const r = h.victim === slot ? null : remotes.get(h.victim);
      if (r) renderer.burst(r.x, r.y, r.z, h.victim);
      else if (predictor) {
        renderer.burst(predictor.me.x, predictor.me.y, predictor.me.z, h.victim);
      }
    }
  }
}

/** Muzzle flash, tracer and report for somebody else's shot. */
function shotByOther(p: SnapshotPlayer, now: number): void {
  if (!renderer) return;
  const spec = WEAPONS[p.g] ?? WEAPONS[0];
  const pitch = (p.p / 32767) * PITCH_LIMIT;
  const cp = Math.cos(pitch);
  const dx = -sinU(p.y) * cp;
  const dy = Math.sin(pitch);
  const dz = -cosU(p.y) * cp;
  const oy = p.e + EYE_HEIGHT;
  const d = rayGrid(p.x, oy, p.z, dx, dy, dz, spec.range);
  renderer.remoteFlash(p.s, now);
  renderer.tracer(p.x, oy - 0.25, p.z, p.x + dx * d, oy + dy * d - 0.25, p.z + dz * d);

  const dist = predictor
    ? Math.hypot(p.x - predictor.me.x, p.e - predictor.me.y, p.z - predictor.me.z)
    : 0;
  sfx.shot(p.g, dist);
}

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
  const spec = WEAPONS[myWeapon] ?? WEAPONS[0];

  const inp: Input = {
    tick: seq,
    view: interp.viewTick(now),
    moveX: quantAxis(intent.moveX),
    moveY: quantAxis(intent.moveY),
    yaw: quantYaw(intent.yaw),
    pitch: quantPitch(intent.pitch),
    fire: wantsFire ? 1 : 0,
    jump: intent.jump && alive ? 1 : 0,
    reload: intent.reload && alive ? 1 : 0,
    weapon: intent.weapon,
  };
  predictor!.apply(inp);

  // Cosmetic only. The server decides whether the shot happened and what it
  // hit; this draws a flash, a tracer and a report at the cadence the server
  // will use, from the ammo count the server last sent.
  if (wantsFire && myReload === 0 && seq - lastFireSeq >= spec.fireInterval) {
    if (myMag > 0) {
      lastFireSeq = seq;
      stats.shots++;
      ownShot(now, spec.range);
    } else if (seq - lastDrySeq > 20) {
      lastDrySeq = seq;
      sfx.dryFire();
    }
  }

  sent.push(inp);
  if (sent.length > BATCH_TICKS) sent.shift();
  net.send({ t: "input", batch: sent.slice() });
  seq++;
}

/** Our own flash, tracer and report, drawn from where the camera is aiming. */
function ownShot(now: number, range: number): void {
  if (!renderer || !predictor) return;
  renderer.muzzleFlash(now);
  sfx.shot(myWeapon, 0);

  const yaw = quantYaw(controls.intent.yaw);
  const pitch = (quantPitch(controls.intent.pitch) / 32767) * PITCH_LIMIT;
  const cp = Math.cos(pitch);
  const dx = -sinU(yaw) * cp;
  const dy = Math.sin(pitch);
  const dz = -cosU(yaw) * cp;
  const me = predictor.me;
  const oy = me.y + EYE_HEIGHT;
  const d = rayGrid(me.x, oy, me.z, dx, dy, dz, range);
  // Started a little ahead of the eye so the near end is not inside the
  // camera, and dropped to roughly the gun's height.
  renderer.tracer(
    me.x + dx * 0.6, oy + dy * 0.6 - 0.18, me.z + dz * 0.6,
    me.x + dx * d, oy + dy * d, me.z + dz * d,
  );
}

setInterval(pump, 4);

/* ---------------------------------------------------------- rendering --- */

const plates: Plate[] = [];

function frame(): void {
  requestAnimationFrame(frame);
  const now = performance.now();
  const dtMs = now - lastFrame;
  const dt = Math.min(0.1, dtMs / 1000);
  lastFrame = now;
  recordFrame(now, dtMs);
  pump();

  if (!renderer || !predictor) return;

  predictor.decayError(dt);
  const me = predictor.me;
  const alpha = phase === "playing" ? Math.min(1, (now - lastTickAt) / TICK_MS) : 1;
  const x = predictor.prevX + (me.x - predictor.prevX) * alpha + predictor.errX;
  const y = predictor.prevY + (me.y - predictor.prevY) * alpha + predictor.errY;
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
  renderer.draw(now, { x, y, z, yaw, pitch }, slot, remotes);

  // Nameplates, after the draw so the camera matrices are current.
  plates.length = 0;
  if (lastSnap) {
    for (const [s, r] of remotes) {
      if (s === slot || !r.alive) continue;
      const p = renderer.project(r.x, r.y + HEAD_TOP + 0.35, r.z);
      if (!p.onScreen || !p.clear || p.dist > 45) continue;
      const snap = lastSnap.players.find((q) => q.s === s);
      plates.push({ slot: s, hp: snap?.h ?? 100, sx: p.sx, sy: p.sy });
    }
  }
  hud.showPlates(plates);

  if (phase === "playing" && interp.ready) {
    const serverTick = interp.serverTick(now);
    hud.clock((ROUND_TICKS - serverTick) / TICK_HZ);
    const self = lastSnap?.players.find((p) => p.s === slot);
    hud.health(self?.h ?? 100, me.alive);
    hud.weapons(myWeapon, myMag, myReload);
    hud.ammo(myWeapon, myMag, myReload);

    if (deathTick !== null) {
      hud.death((deathTick + RESPAWN_TICKS - serverTick) / TICK_HZ);
      hud.message("");
    } else if (!controls.locked && !matchMedia("(pointer: coarse)").matches) {
      hud.message("Click to aim");
    } else {
      hud.message("");
    }

    hud.netStats(
      `seat ${slot}  view ${interp.viewTick(now)}  server ${Math.floor(serverTick)}  ` +
      `unacked ${predictor.pendingCount}`,
    );
    hud.debug(DEBUG ? [
      `fps      ${fpsNow}`,
      `1% low   ${onePercentLow.toFixed(0)}`,
      `draws    ${renderer.drawCalls}`,
      `tris     ${renderer.triangles}`,
      `ping     ${rtt} ms`,
      `unacked  ${predictor.pendingCount}`,
    ] : null);
  } else if (phase === "waiting") {
    hud.clock(null);
  }
  hud.stickAt(controls.stickVisual);
}
requestAnimationFrame(frame);

/* ----------------------------------------------------------- test hook --- */

// Dev builds only. Lets a headless browser drive a tab the way a player would:
// aim, move, pull the trigger, reload and swap. It goes through the same
// Controls and the same input path as a real player, so it cannot do anything
// a player cannot.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).arena = {
    aim(yawRad: number, pitchRad: number) {
      controls.intent.yaw = yawRad;
      controls.intent.pitch = pitchRad;
    },
    move(mx: number, my: number) { controls.botMove = { x: mx, y: my }; },
    fire(on: boolean) { controls.botFire = on; },
    jump(on: boolean) { controls.botJump = on; },
    weapon(n: number) { controls.cycle(n - 1 - myWeapon); },
    peek() {
      return {
        phase,
        me: predictor
          ? {
            x: predictor.me.x, y: predictor.me.y, z: predictor.me.z,
            vy: predictor.me.vy, alive: predictor.me.alive,
          }
          : null,
        weapon: myWeapon,
        mag: myMag,
        reload: myReload,
        remotes: Object.fromEntries(remotes),
        drawCalls: renderer?.drawCalls ?? 0,
        fps: fpsNow,
        onePercentLow,
        ping: rtt,
        stats,
      };
    },
    state() {
      return {
        phase,
        slot,
        me: predictor
          ? {
            x: predictor.me.x, y: predictor.me.y, z: predictor.me.z,
            vy: predictor.me.vy, alive: predictor.me.alive,
          }
          : null,
        remotes: Object.fromEntries(remotes),
        drawCalls: renderer?.drawCalls ?? 0,
        serverTick: interp.ready ? interp.serverTick(performance.now()) : null,
        board: document.getElementById("board")?.innerText,
        feed: document.getElementById("feed")?.innerText,
        timer: document.getElementById("timer")?.innerText,
        ammo: document.getElementById("ammo")?.innerText,
        over: document.getElementById("over")?.classList.contains("show")
          ? document.querySelector("#over .card")?.textContent
          : null,
      };
    },
  };
}
