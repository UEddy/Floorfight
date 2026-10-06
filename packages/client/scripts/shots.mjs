/**
 * Screenshots of the real client, so the look of the game can be checked by
 * eye without a phone.
 *
 * Starts a free play server and the Vite dev server, opens the client in
 * headless Chromium, plays five seconds (walking and firing, bots filling the
 * room), then parks the camera at fixed places in the Hall and saves a PNG
 * from each. Run from packages/client:
 *
 *   npm run shots                 writes to ./shots
 *   npm run shots -- out/dir      writes somewhere else
 *
 * Chromium comes from `npx playwright install chromium`, or from
 * PLAYWRIGHT_CHROMIUM if that names an existing binary. WebGL runs on
 * SwiftShader here, so the frame rate it reports means nothing: use ?debug=1
 * on a phone for that.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const OUT = resolve(process.argv[2] ?? "shots");
const SERVER_PORT = 8790;
const WEB_PORT = 5190;
const W = 1170;
const H = 540;

/**
 * Fixed views, in world units. Feet height is the walk surface the camera
 * stands on; the renderer adds eye height. Yaw 0 looks towards -z (the stage
 * end), and a positive yaw turns left.
 */
const HALF = 24;
const cell = (i) => i - HALF + 0.5;
const VIEWS = [
  // Picked by casting a fan of rays from every standable cell on each level
  // and keeping the ones that see furthest: the Hall is a maze, and a view
  // chosen by hand mostly photographs the nearest pier.
  { name: "1-floor", x: cell(12), y: 1, z: cell(46), yaw: 1.18, pitch: 0.12 },
  { name: "2-stage", x: cell(38), y: 3, z: cell(1), yaw: 3.14, pitch: 0.05 },
  { name: "3-gallery", x: cell(43), y: 7, z: cell(1), yaw: 2.75, pitch: 0.05 },
  { name: "4-high", x: cell(46), y: 11, z: cell(12), yaw: 1.18, pitch: 0.2 },
];

const children = [];
function run(cmd, args, env, cwd) {
  // Own process group, so stopping it also stops what npx started under it.
  const p = spawn(cmd, args, {
    cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  p.stdout.on("data", (d) => process.env.SHOTS_VERBOSE && process.stdout.write(d));
  p.stderr.on("data", (d) => process.env.SHOTS_VERBOSE && process.stderr.write(d));
  children.push(p);
  return p;
}
function stopAll() {
  for (const p of children) {
    try {
      process.kill(-p.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}
process.on("exit", stopAll);

async function waitFor(url) {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 426) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error(`nothing answered at ${url}`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const logs = mkdtempSync(join(tmpdir(), "floorfight-shots-"));

  run("npx", ["tsx", "src/index.ts"], {
    PORT: String(SERVER_PORT), FREE_FILL_MS: "300", LOG_DIR: logs,
  }, resolve("../server"));
  run("npx", ["vite", "--port", String(WEB_PORT), "--strictPort"], {}, resolve("."));
  await waitFor(`http://127.0.0.1:${WEB_PORT}/`);
  console.log("servers up");
  await sleep(1500);

  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  // A phone in landscape: touch controls on screen, no mouse, no pointer lock.
  const page = await browser.newPage({
    viewport: { width: W, height: H }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
  });
  page.on("pageerror", (e) => console.error("[page]", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.error("[console]", m.text()); });
  await page.goto(`http://127.0.0.1:${WEB_PORT}/?server=ws://127.0.0.1:${SERVER_PORT}`);

  console.log("page loaded, waiting for the round");
  await page.waitForFunction(() => window.arena?.state().phase === "playing", null, { timeout: 30000 });

  // Five seconds of play: walk, strafe, sweep the aim and hold the trigger,
  // so the view model, bob and spread are all in motion when the first shot
  // is taken. Walking into a booth turns the player round rather than
  // leaving them pressed against it for the rest of the run.
  await page.evaluate(() => { window.arena.move(0, 1); window.arena.fire(true); });
  const start = await page.evaluate(() => window.arena.state().me);
  let heading = start ? Math.atan2(start.x, start.z) : 0;
  let last = start;
  const t0 = Date.now();
  // Five seconds, and then for as long as it takes to be alive and on the
  // move for a second: the bots are quick, and a photograph of the death
  // screen says nothing about the view model or the crosshair.
  let aliveSince = 0;
  while (Date.now() - t0 < 5000 || Date.now() - aliveSince < 1200) {
    if (Date.now() - t0 > 20000) break;
    const t = (Date.now() - t0) / 1000;
    const me = await page.evaluate(() => window.arena.state().me);
    if (!me?.alive) aliveSince = Date.now();
    if (me && last && Math.hypot(me.x - last.x, me.z - last.z) < 0.15) heading += 1.3;
    last = me;
    await page.evaluate(([h, t]) => {
      window.arena.aim(h + Math.sin(t * 1.7) * 0.35, -0.04);
      window.arena.move(Math.sin(t * 2.1) * 0.5, 1);
    }, [heading, t]);
    await sleep(150);
  }
  await page.screenshot({ path: join(OUT, "0-playing.png") });
  await page.evaluate(() => { window.arena.fire(false); window.arena.move(0, 0); });

  // The fixed views are for looking at the hall, so the death overlay, if the
  // bots got us during the walk, is taken off them.
  await page.addStyleTag({ content: "#tint, #killedby, #respawn { display: none !important; }" });
  for (const v of VIEWS) {
    await page.evaluate((v) => window.arena.camera(v), v);
    await sleep(700);
    await page.screenshot({ path: join(OUT, `${v.name}.png`) });
  }

  // Closest live opponent, from a few blocks away, for the character model.
  const near = await page.evaluate(() => window.arena.nearestRemote?.() ?? null);
  if (near) {
    await page.evaluate((v) => window.arena.camera(v), near);
    await sleep(500);
    await page.screenshot({ path: join(OUT, "5-opponent.png") });
  }

  // The view model, from the player's own eye: each weapon at rest, and the
  // rifle half way through a reload.
  await page.evaluate(() => { window.arena.camera(null); window.arena.fire(false); window.arena.move(0, 0); });
  await page.waitForFunction(() => window.arena.state().me?.alive, null, { timeout: 10000 }).catch(() => {});
  for (const [w, name] of [[2, "pistol"], [3, "shotgun"], [1, "rifle"]]) {
    await page.evaluate((w) => window.arena.weapon(w), w);
    await sleep(900);
    await page.screenshot({ path: join(OUT, `6-${name}.png`) });
  }
  await page.evaluate(() => window.arena.fire(true));
  await sleep(250);
  await page.evaluate(() => { window.arena.fire(false); window.arena.reload(true); });
  await sleep(550);
  await page.evaluate(() => window.arena.reload(false));
  await page.screenshot({ path: join(OUT, "7-reload.png") });

  const s = await page.evaluate(() => window.arena.peek());
  console.log(`draw calls ${s.drawCalls}, triangles ${s.triangles}`);
  await browser.close();
  stopAll();
  console.log(`screenshots in ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  stopAll();
  process.exit(1);
});
