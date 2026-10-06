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
  onGround,
  shotSpread,
  rayGrid,
  sinU,
  yawToRadians,
  type HitEvent,
  type Input,
} from "../../shared/sim";
import { BLOOM_GAP, WEAPONS } from "../../shared/weapons";
import { fromHex, sha256Hex } from "../../shared/sha256";
import {
  quantAxis, quantPitch, quantYaw, type RosterEntry, type SnapshotPlayer,
} from "../../shared/protocol";
import { DEV_MATCH_ID } from "../../shared/dev";
import { devKeypair, guestKeypair } from "./keys";
import { Net, signLocally, type NetHandlers } from "./net";
import { Menu } from "./menu";
import * as native from "./native";
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
hud.onWeaponTap((i) => controls.select(i));

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
/**
 * Our shots in the current string, counted the way the sim counts them, so
 * the crosshair can show the bloom the server will apply to the next shot.
 * Display only: the server keeps its own count and that is the one used.
 */
let myStreak = 0;
let lastDrySeq = -999;
let lastSnap: { tick: number; players: SnapshotPlayer[] } | null = null;
let firstSnap: SnapshotPlayer[] | null = null;
const active = new Set<number>();

/** Weapon state as the server last reported it. The HUD shows only this. */
let myWeapon = 0;
let myMag = WEAPONS[0].mag;
let myReload = 0;
/**
 * When the current reload started, back-dated from the server's countdown.
 * Snapshots come at 20 Hz, so animating straight off the countdown would
 * move the hands in visible steps. This only smooths the drawing: the
 * countdown itself is still the server's.
 */
let reloadStartedAt = 0;
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
let lowAt = 0;

function recordFrame(now: number, dtMs: number): void {
  frameTimes.push(dtMs);
  if (frameTimes.length > 1000) frameTimes.shift();
  fpsWindow.push(now);
  while (fpsWindow.length > 0 && now - fpsWindow[0] > 1000) fpsWindow.shift();
  fpsNow = fpsWindow.length;
  // Twice a second, not every frame: sorting a thousand numbers sixty times
  // a second is garbage for the collector to stop the game for.
  if (frameTimes.length >= 50 && now - lowAt > 500) {
    lowAt = now;
    const slowest = [...frameTimes].sort((a, b) => b - a);
    const n = Math.max(1, Math.round(slowest.length * 0.01));
    let sum = 0;
    for (let i = 0; i < n; i++) sum += slowest[i];
    onePercentLow = 1000 / (sum / n);
  }
}

/**
 * The holders match being played, if this is one: its on-chain id and the
 * wallet that staked into it. Null in free play.
 */
let holders: { matchId: string; wallet: string } | null = null;

const menu = new Menu({
  free: () => startFree(),
  holders: (matchId, wallet, mint) => startHolders(matchId, wallet, mint),
});

let net: Net | null = null;

/** Free play: a guest key made up now, or a dev seat in a dev build. */
function startFree(): void {
  let keys: ReturnType<typeof guestKeypair>;
  try {
    keys = devSeat ? devKeypair(seat) : guestKeypair();
  } catch (e) {
    hud.message((e as Error).message);
    throw e;
  }
  hud.message("Connecting...");
  net = new Net(serverUrl, async (challenge) => {
    // A dev seat asks for the dev room by name. A guest takes the room the
    // server offered with the challenge, so the signature covers the id of
    // the match it actually gets rather than a matchmaking alias.
    const matchId = devSeat ? DEV_MATCH_ID : challenge.freeMatchId;
    return matchId ? signLocally(matchId, challenge.nonce, keys) : null;
  }, handlers);
}

/**
 * A holders match. The join is signed by the wallet, through the app: the
 * page passes the match id and the nonce and gets back a signature over a
 * message the app built itself. Until the match locks the server keeps the
 * socket in the lobby; then it moves it into the room and the game starts.
 */
function startHolders(matchId: string, wallet: string, mint: string | null): void {
  holders = { matchId, wallet };
  hud.message("Signing in to the lobby...");
  net = new Net(serverUrl, async (challenge) => {
    const signed = await native.signJoin(matchId, challenge.nonce);
    if (signed.wallet !== wallet) {
      throw new Error("the wallet that signed is not the one that staked");
    }
    return {
      matchId, wallet: signed.wallet, sig: signed.signature,
      ...(mint ? { mint } : {}),
    };
  }, handlers);
}

const handlers: NetHandlers = {
  onLobby(view) {
    hud.message("");
    menu.showLobby(view);
  },

  onAccepted(msg) {
    menu.hide();
    slot = msg.slot;
    spreadCommit = msg.spreadCommit;
    hud.setRoster(msg.roster);
    predictor = new Predictor(msg.roster.length, slot);
    renderer = new Renderer(canvas, msg.roster.length);
    renderer.setLocalSlot(slot);
    renderer.setRoster(msg.roster);
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
      if (myReload === 0 && me.r > 0) {
        sfx.reload((me.r / TICK_HZ) * 1000, me.g);
        const full = (WEAPONS[me.g] ?? WEAPONS[0]).reloadTicks;
        reloadStartedAt = now - ((full - me.r) / TICK_HZ) * 1000;
      }
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
    if (holders) menu.showResults(holders.matchId, holders.wallet);
    net?.close();
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
};

/**
 * Landscape on a phone browser.
 *
 * The page cannot rotate a phone by itself, but Android browsers allow a page
 * that has gone fullscreen to lock its orientation, and fullscreen needs a
 * tap. So the first tap anywhere asks for both. Where either is refused (an
 * iPhone, a browser that says no, the app's WebView, which is already locked
 * to landscape natively) nothing happens, and the overlay in index.html asks
 * the person to turn the phone instead.
 */
function landscapeOnFirstTap(): void {
  if (native.hasNative() || !matchMedia("(pointer: coarse)").matches) return;
  const go = () => {
    removeEventListener("pointerdown", go, true);
    const el = document.documentElement;
    const lock = () => {
      const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      return o?.lock ? o.lock("landscape") : Promise.resolve();
    };
    if (!document.fullscreenElement && el.requestFullscreen) {
      el.requestFullscreen({ navigationUI: "hide" }).then(lock).catch(() => {});
    } else {
      lock().catch(() => {});
    }
  };
  addEventListener("pointerdown", go, true);
}
landscapeOnFirstTap();

/*
 * Free straight away for a dev seat or ?mode=free, which is how the
 * screenshot script and two-tab testing skip the menu. Otherwise the menu.
 */
if (devSeat || params.get("mode") === "free") startFree();
else menu.showModes();

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
  // Which side of us it came from: the shooter's direction against the
  // camera's right hand, (cos yaw, -sin yaw) in the sim's convention.
  let pan = 0;
  if (predictor && dist > 0.01) {
    const yaw = controls.intent.yaw;
    pan = ((p.x - predictor.me.x) * Math.cos(yaw) - (p.z - predictor.me.z) * Math.sin(yaw)) / dist;
  }
  sfx.shot(p.g, Math.max(0.5, dist), pan * 0.8);
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
      myStreak = seq - lastFireSeq <= BLOOM_GAP ? myStreak + 1 : 0;
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
  net?.send({ t: "input", batch: sent.slice() });
  seq++;
}

/** Our own flash, tracer and report, drawn from where the camera is aiming. */
function ownShot(now: number, range: number): void {
  if (!renderer || !predictor) return;
  renderer.muzzleFlash(myWeapon);
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
let crossGap = 0;

/**
 * Dev builds only: a camera pose that replaces the predicted eye when drawing.
 * The screenshot script uses it to look at the hall from fixed places. It is
 * drawing only: input, prediction and everything sent to the server carry on
 * from where the player really is.
 */
let devCamera: {
  x: number; y: number; z: number; yaw: number; pitch: number; hideGun?: boolean;
  /** Follow this seat, from in front of it, every frame. */
  follow?: number;
} | null = null;

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
  const spec = WEAPONS[myWeapon] ?? WEAPONS[0];
  if (devCamera?.follow !== undefined) {
    const r = remotes.get(devCamera.follow);
    if (r) {
      const ry = yawToRadians(r.yaw);
      const fx = -Math.sin(ry);
      const fz = -Math.cos(ry);
      devCamera.x = r.x + fx * 2.4;
      devCamera.z = r.z + fz * 2.4;
      devCamera.y = r.y;
      devCamera.yaw = Math.atan2(fx, fz);
    }
  }
  renderer.draw(now, devCamera ?? { x, y, z, yaw, pitch }, slot, remotes, {
    weapon: myWeapon,
    // The server's countdown, as a fraction of the whole reload, so the
    // animation finishes when the magazine is actually full.
    reload: myReload > 0
      ? Math.min(0.999, (now - reloadStartedAt) / ((spec.reloadTicks / TICK_HZ) * 1000))
      : null,
    alive: me.alive && !devCamera?.hideGun,
    grounded: me.vy === 0,
  });

  // The crosshair opens to the spread the sim would give the next shot:
  // the same function, our predicted velocity, and our count of the string
  // of shots so far, which lapses the way the sim's does.
  const streak = seq - lastFireSeq <= BLOOM_GAP ? myStreak + 1 : 0;
  const units = shotSpread(spec, me.vx, me.vz, onGround(me.x, me.y, me.z), streak);
  crossGap += (renderer.spreadPixels(units) - crossGap) * Math.min(1, dt * 20);
  hud.crosshair(Math.max(3, crossGap));

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

    if (DEBUG) hud.netStats(
      `seat ${slot}  view ${interp.viewTick(now)}  server ${Math.floor(serverTick)}  ` +
      `unacked ${predictor.pendingCount}`,
    );
    hud.debug(DEBUG ? [
      `fps      ${fpsNow}`,
      `1% low   ${onePercentLow.toFixed(0)}`,
      `draws    ${renderer.drawCalls}`,
      `tris     ${renderer.triangles}`,
      `res      ${renderer.pixelRatio.toFixed(2)}x`,
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
    reload(on: boolean) { controls.botReload = on; },
    weapon(n: number) { controls.cycle(n - 1 - myWeapon); },
    camera(pose: typeof devCamera) { devCamera = pose; },
    /** The menu, so the screenshot script can photograph its screens. */
    menu,
    /** The sound engine, so a script can render it offline and listen. */
    sfx,
    /** Put a mint on seats' faces, as a verified roster would. Drawing only. */
    faces(roster: RosterEntry[]) { renderer?.setRoster(roster); },
    /**
     * A camera pose a few blocks from the closest live opponent, looking at
     * them, from whichever side has a clear line. For the screenshot script.
     */
    nearestRemote() {
      if (!predictor) return null;
      const me = predictor.me;
      const others = [...remotes]
        .filter(([s, r]) => s !== slot && r.alive)
        .map(([, r]) => r)
        .sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z));
      // Prefer a view of somebody's face: try in front of each of them before
      // settling for any clear side of the nearest.
      for (const front of [true, false]) {
        for (const best of front ? others : others.slice(0, 1)) {
          const eyeY = best.y + EYE_HEIGHT;
          const yaw = yawToRadians(best.yaw);
          const facing = Math.atan2(-Math.sin(yaw), -Math.cos(yaw));
          const steps = front ? 5 : 16;
          for (let k = 0; k < steps; k++) {
            const off = (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2);
            const a = facing + off * (front ? 0.25 : Math.PI / 8);
            const dx = Math.sin(a);
            const dz = Math.cos(a);
            const dist = 2.6;
            if (rayGrid(best.x, eyeY, best.z, dx, 0, dz, dist + 0.6) < dist + 0.6) continue;
            return {
              x: best.x + dx * dist, y: best.y, z: best.z + dz * dist,
              yaw: Math.atan2(dx, dz), pitch: -0.1, hideGun: true,
              // From in front, track them: a running bot crosses this
              // distance in a third of a second.
              ...(front ? { follow: [...remotes].find(([, r]) => r === best)?.[0] } : {}),
            };
          }
        }
      }
      return null;
    },
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
        triangles: renderer?.triangles ?? 0,
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
