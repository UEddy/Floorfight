// Shared harness for the determinism tests.
//
// Not a test file itself: it is imported by sim.test.ts and run again inside a
// separate node process by the same test, so that the two can be compared.
// Loading it twice in one process proves nothing about module initialisation,
// and the map grid is built at module load.

import { createHash } from "node:crypto";
import {
  LEVEL_STAGE,
  MAP_ID,
  TICK_HZ,
  cellCentreX,
  cellCentreZ,
  YAW_UNITS,
  createWorld,
  step,
  type HitEvent,
  type Input,
} from "../../shared/sim";
import { FREE_SALT_BYTES, WEAPON_COUNT, saltSeeds } from "../../shared/weapons";
import { toHex } from "../../shared/sha256";
import { LOG_VERSION, canonicalise, type MatchLog, type RosterEntry } from "../../shared/protocol";

const SLOTS = 6;

/**
 * A scripted match. Inputs come from a seeded generator rather than a
 * recording, because what is being tested is that identical inputs produce
 * identical output, and a generator can cover more of the input space: every
 * player moves, looks around, jumps and fires throughout.
 */
/**
 * `salt` is the match's spread salt: in a staked match it is the 32 bytes the
 * server committed to at join and revealed in the log, and replaying with the
 * revealed bytes is the whole reason for writing them down. Default is the
 * public free room salt.
 */
export function runMatch(seed: number, ticks: number, salt: Uint8Array = FREE_SALT_BYTES): {
  logHash: string;
  stateHash: string;
  kills: number;
  hits: number;
} {
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };

  const roster: RosterEntry[] = [];
  for (let i = 0; i < SLOTS; i++) {
    roster.push({ slot: i, wallet: `w${i}`, collection: null, mint: null });
  }

  const world = createWorld(SLOTS, saltSeeds(salt));
  // Cluster the six of them in the open pocket on the stage, in each other's
  // line of sight. The real spawns are deliberately far apart behind cover,
  // which is right for a match and useless here: a determinism check that
  // never resolves a shot never exercises rewind, hit registration or
  // scoring, and those are the parts most likely to drift.
  for (let i = 0; i < SLOTS; i++) {
    const p = world.players[i];
    p.x = cellCentreX(22 + (i % 3));
    p.z = cellCentreZ(10 + Math.floor(i / 3));
    p.y = LEVEL_STAGE;
    p.vy = 0;
  }
  const log: MatchLog = {
    v: LOG_VERSION,
    matchId: "replay-test",
    map: MAP_ID,
    spreadSalt: toHex(salt),
    roster,
    startedAt: 0,
    ticks: [],
    standings: [],
  };

  // Per player drift, so they do not all walk in lockstep.
  const yaw = new Array(SLOTS).fill(0).map(() => Math.floor(rnd() * YAW_UNITS));
  const turn = new Array(SLOTS).fill(0).map(() => Math.floor(rnd() * 60) - 30);
  const allHits: HitEvent[] = [];
  let kills = 0;

  for (let t = 0; t < ticks; t++) {
    const inputs: (Input | null)[] = new Array(SLOTS).fill(null);
    for (let slot = 0; slot < SLOTS; slot++) {
      // A dropped input now and then, which is the normal case on a phone and
      // has to replay the same way as a delivered one.
      if (rnd() < 0.03) continue;
      yaw[slot] = (yaw[slot] + turn[slot] + YAW_UNITS) % YAW_UNITS;
      if (rnd() < 0.02) turn[slot] = Math.floor(rnd() * 120) - 60;
      inputs[slot] = {
        tick: t,
        view: t - Math.floor(rnd() * 20),
        moveX: Math.floor(rnd() * 255) - 127,
        moveY: Math.floor(rnd() * 255) - 127,
        yaw: yaw[slot],
        pitch: Math.floor(rnd() * 20000) - 10000,
        fire: rnd() < 0.25 ? 1 : 0,
        jump: rnd() < 0.08 ? 1 : 0,
        reload: rnd() < 0.02 ? 1 : 0,
        // Swap now and then, so magazines, reloads, swap delays, the semi
        // automatic trigger edge and all three spread patterns are all inside
        // the hash this test compares.
        weapon: rnd() < 0.01 ? 1 + Math.floor(rnd() * WEAPON_COUNT) : 0,
      };
    }
    const hits: HitEvent[] = [];
    step(world, inputs, hits);
    log.ticks.push({ tick: t, inputs });
    for (const h of hits) {
      allHits.push(h);
      if (h.lethal) kills++;
    }
  }

  log.standings = world.players.map((p, slot) => ({
    slot,
    wallet: roster[slot].wallet,
    kills: p.kills,
    deaths: p.deaths,
    place: 0,
  }));
  log.standings.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.slot - b.slot);
  log.standings.forEach((r, i) => { r.place = i + 1; });

  // Full precision. A replay that agrees to three decimals is a replay that
  // disagrees, and the whole point of the audit story is that it cannot.
  const state = JSON.stringify(world.players.map((p) => [
    p.x, p.y, p.z, p.vy, p.yaw, p.pitch, p.hp, p.kills, p.deaths, p.alive ? 1 : 0,
    p.weapon, p.ammo.slice(), p.reloadUntil, p.switchUntil, p.triggerHeld ? 1 : 0,
  ]));
  const events = JSON.stringify(allHits.map((h) => [
    h.tick, h.shooter, h.victim, h.head ? 1 : 0, h.lethal ? 1 : 0, h.rewind,
    h.weapon, h.damage,
  ]));

  return {
    logHash: createHash("sha256").update(canonicalise(log)).digest("hex"),
    stateHash: createHash("sha256").update(state).update(events).digest("hex"),
    kills,
    hits: allHits.length,
  };
}

export const REPLAY_SEED = 20261005;
export const REPLAY_TICKS = 90 * TICK_HZ;

// Run as a script, print the hashes. The test spawns this to get a second,
// independent module load.
if (process.argv[2] === "--print") {
  const r = runMatch(REPLAY_SEED, REPLAY_TICKS);
  console.log(JSON.stringify(r));
}
