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
const HALF = 48;
const cell = (i) => i - HALF + 0.5;
const VIEWS = [
  // Where a player lands: the first spawn, on the floor by the south wall,
  // looking up the hall.
  { name: "1-spawn", x: cell(42), y: 1, z: cell(94), yaw: -0.25, pitch: 0.06 },
  // The nave from the floor south of the fountain, looking north past it to
  // the bandstand and the north gallery.
  { name: "2-nave", x: cell(47), y: 1, z: cell(72), yaw: 0, pitch: 0.08 },
  // The west gallery, looking north along it and across the nave.
  { name: "3-gallery", x: cell(4), y: 7, z: cell(64), yaw: -0.45, pitch: -0.08 },
  // The arcade under the east gallery: the covered corridor the length of
  // the hall.
  { name: "4-corridor", x: cell(92), y: 1, z: cell(88), yaw: 0.12, pitch: 0.04 },
  // The market and the garden, the two aisles' fights.
  { name: "5-market", x: cell(22), y: 1, z: cell(70), yaw: 0.2, pitch: 0.04 },
  { name: "6-garden", x: cell(84), y: 1, z: cell(70), yaw: 0.1, pitch: 0.04 },
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
  run("npx", ["vite", "--port", String(WEB_PORT), "--strictPort"], {
    FLOORFIGHT_API: `http://127.0.0.1:${SERVER_PORT}`,
  }, resolve("."));
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
  await page.goto(`http://127.0.0.1:${WEB_PORT}/?mode=free&server=ws://127.0.0.1:${SERVER_PORT}`);

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
  // Draw calls and triangles as the renderer counted them for the frame on
  // screen, at each view: the hall is chunked, so what is drawn depends on
  // where the camera looks.
  const counts = [];
  for (const v of VIEWS) {
    await page.evaluate((v) => window.arena.camera(v), v);
    await sleep(700);
    await page.screenshot({ path: join(OUT, `${v.name}.png`) });
    const s = await page.evaluate(() => window.arena.peek());
    counts.push([v.name, s.drawCalls, s.triangles]);
  }

  // Closest live opponent, from a few blocks away, for the character model.
  // Every other seat wears a fixture face, served the way /api/nft-img
  // serves a verified NFT, so the head's NFT path is in the picture too.
  await page.route("**/api/nft-img/*", (r) =>
    r.fulfill({ path: resolve("scripts/fixtures", "face1.png"), contentType: "image/png" }));
  // Every other seat also carries an SKR badge tier, so the halo and the
  // nameplate badge are in the picture.
  await page.evaluate(() => window.arena.faces([1, 2, 3, 4, 5].map((slot) => ({
    slot, wallet: "", collection: null, mint: "Face2222222222222222222222222222222222222222", skr: (slot % 3) + 1,
  }))));
  const near = await page.evaluate(() => window.arena.nearestRemote?.() ?? null);
  if (near) {
    // Straight after placing it: bots run at seven blocks a second, and a
    // pause here photographs the spot they were standing in.
    await page.evaluate((v) => window.arena.camera(v), near);
    await sleep(60);
    await page.screenshot({ path: join(OUT, "7-opponent.png") });
  }

  // The view model, from the player's own eye: each weapon at rest, and the
  // rifle half way through a reload.
  await page.evaluate(() => { window.arena.camera(null); window.arena.fire(false); window.arena.move(0, 0); });
  await page.waitForFunction(() => window.arena.state().me?.alive, null, { timeout: 10000 }).catch(() => {});
  for (const [w, name] of [[2, "pistol"], [3, "shotgun"], [1, "rifle"]]) {
    await page.evaluate((w) => window.arena.weapon(w), w);
    await sleep(900);
    await page.screenshot({ path: join(OUT, `8-${name}.png`) });
  }
  await page.evaluate(() => window.arena.fire(true));
  await sleep(250);
  await page.evaluate(() => { window.arena.fire(false); window.arena.reload(true); });
  await sleep(550);
  await page.evaluate(() => window.arena.reload(false));
  await page.screenshot({ path: join(OUT, "9-reload.png") });

  const s = await page.evaluate(() => window.arena.peek());
  await page.close();
  await menus(browser);
  for (const [name, d, t] of counts) console.log(`${name}: draw calls ${d}, triangles ${t}`);
  console.log(`playing: draw calls ${s.drawCalls}, triangles ${s.triangles}`);
  console.log(`hall mesh, all chunks: ${s.hallTriangles} triangles`);
  await browser.close();
  stopAll();
  console.log(`screenshots in ${OUT}`);
}

/**
 * The menus. The mode screen as a plain browser sees it (holders disabled),
 * then the holders screens as the app would show them.
 *
 * There is no wallet and no chain here, so for those this page gets a stub
 * bridge that answers connect with a made up address, and canned replies for
 * /api/matches and /api/nfts. The pictures are of the real page's layout;
 * the matches, the NFTs and the lobby numbers in them are invented.
 */
async function menus(browser) {
  const url = `http://127.0.0.1:${WEB_PORT}/?server=ws://127.0.0.1:${SERVER_PORT}`;
  const opts = { viewport: { width: W, height: H }, deviceScaleFactor: 1, isMobile: true, hasTouch: true };

  const plain = await browser.newPage(opts);
  await plain.goto(url);
  await plain.waitForSelector("#menu.show");
  await plain.screenshot({ path: join(OUT, "10-modes-browser.png") });
  await plain.close();

  const page = await browser.newPage(opts);
  await page.addInitScript(() => {
    window.ReactNativeWebView = {
      postMessage(raw) {
        const req = JSON.parse(raw);
        const reply = req.t === "connect"
          ? { id: req.id, ok: true, t: "connect", wallet: "Ff1ghtDemo1111111111111111111111111111111111" }
          : { id: req.id, ok: false, error: "stub bridge" };
        setTimeout(() => dispatchEvent(new MessageEvent("floorfight-native", { data: JSON.stringify(reply) })), 50);
      },
    };
  });
  const now = Math.floor(Date.now() / 1000);
  await page.route("**/api/matches?*", (r) => r.fulfill({ json: { tier: 0, stake: "10000000", matches: [
    { matchId: "1844674407370955161", stake: "10000000", count: 3, maxPlayers: 6, joinDeadline: now + 420 },
    { matchId: "922337203685477580", stake: "10000000", count: 1, maxPlayers: 6, joinDeadline: now + 540 },
  ] } }));
  await page.route("**/api/nfts/*", (r) => r.fulfill({ json: { items: [
    { id: "Face1111111111111111111111111111111111111111", name: "Blue Visitor", collection: null, image: "x" },
    { id: "Face2222222222222222222222222222222222222222", name: "Ember Clerk", collection: null, image: "x" },
    { id: "Face3333333333333333333333333333333333333333", name: "Fern Usher", collection: null, image: "x" },
  ] } }));
  // A canned SKR read for the made up wallet: the panel's layout is real,
  // the balance is invented.
  await page.route("**/api/skr/*", (r) => r.fulfill({ json: {
    balance: "2150.5", raw: "2150500000", decimals: 6, tier: 2, tierName: "Backer", network: "mainnet",
  } }));
  await page.route("**/api/nft-img/*", (r) => {
    const n = Number(/Face(\d)/.exec(r.request().url())?.[1] ?? 1) - 1;
    return r.fulfill({ path: resolve("scripts/fixtures", `face${n}.png`), contentType: "image/png" });
  });
  await page.goto(url);
  await page.waitForSelector("#menu.show");
  await page.screenshot({ path: join(OUT, "10-modes-app.png") });
  await page.click('[data-m="holders"]');
  await page.click('[data-a="connect"]');
  await page.waitForSelector("#menu .grid img");
  await page.click('[data-mint^="Face2"]');
  await sleep(400);
  await page.screenshot({ path: join(OUT, "11-holders.png") });
  await page.evaluate((now) => window.arena.menu.showLobby({
    t: "lobby", matchId: "1844674407370955161", phase: "waiting", count: 3, maxPlayers: 6,
    stake: "10000000", joinDeadline: now + 263, present: [true, true, false], lockBefore: 60,
  }), now);
  await page.screenshot({ path: join(OUT, "12-lobby.png") });
  await page.close();
}

main().catch((e) => {
  console.error(e);
  stopAll();
  process.exit(1);
});
