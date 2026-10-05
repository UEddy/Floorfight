import {
  EYE_HEIGHT,
  YAW_UNITS,
  rayGrid,
  type Input,
  type WorldState,
} from "../../shared/sim";
import { WEAPONS, WEAPON_COUNT } from "../../shared/weapons";
import { quantAxis, quantPitch, quantYaw } from "../../shared/protocol";

/**
 * Server side practice bot.
 *
 * The only thing a bot is allowed to do is produce Input objects, which go
 * into the same queue a phone's inputs go into and are drained by the same
 * code on the same tick. That is deliberate and it is the whole design:
 *
 *   - a bot cannot assert a position, a hit or a score, because nothing in
 *     Input can express one. It has exactly the authority a player has.
 *   - bot inputs land in the match log like anyone else's, so a replay of a
 *     match with bots in it reproduces that match exactly.
 *
 * The second point is also why this file may use Math.atan2 and a local
 * random generator freely while sim.ts may not. Nothing here has to be
 * reproducible: the bot's reasoning is not replayed, only the inputs it
 * produced, and those are recorded. If this ever moves inside the simulation
 * that stops being true.
 *
 * Bots are never seated in a staked room. Room.addBot refuses, because a bot
 * in a match with money on it is the server playing against the people who
 * paid to be there.
 */

/** Ticks between deciding to shoot and shooting. About 230 to 400 ms. */
const REACTION_MIN = 14;
const REACTION_MAX = 24;

/** Ticks a wander heading is held for. */
const HEADING_MIN = 25;
const HEADING_MAX = 80;

/** How far off a bot's aim sits, in yaw units. About 1.3 degrees of slop. */
const AIM_SLOP = 30;

/** Only shoot when the target is roughly in front. About 6 degrees. */
const AIM_TOLERANCE = 140;

/**
 * Yaw units per tick the bot can turn. A bot that snapped straight onto a
 * bearing would be a flick aimbot with a delay bolted on, which is not the
 * same thing as an opponent at all: the delay would only ever show up as a
 * pause before a guaranteed hit. Turning at a human sort of rate means a bot
 * caught facing the wrong way genuinely loses the exchange.
 */
const TURN_RATE = 240;

/** Ticks of being stuck before picking a new heading and hopping. */
const STUCK_TICKS = 20;

/** Ticks between a bot changing its mind about which weapon to carry. */
const SWAP_EVERY = 20 * 60;

export class Bot {
  private seq = 0;
  private rng: number;
  private yaw = 0;
  private aim = 0;
  private pitch = 0;
  private headingUntil = 0;
  private strafe = 0;
  private target = -1;
  private fireAt = Number.POSITIVE_INFINITY;
  private stuck = 0;
  private lastX = 0;
  private lastZ = 0;
  private weapon: number;
  private swapAt = SWAP_EVERY;
  private lastPull = -999;

  constructor(readonly slot: number, seed: number) {
    this.rng = (seed * 2654435761) >>> 0;
    this.yaw = this.rand(YAW_UNITS);
    this.aim = this.yaw;
    // One of each to start with, so a dev room shows all three weapons and
    // all three firing patterns without anyone having to pick them.
    this.weapon = slot % WEAPON_COUNT;
  }

  private rand(n: number): number {
    this.rng = (Math.imul(this.rng, 1664525) + 1013904223) >>> 0;
    return Math.floor((this.rng / 4294967296) * n);
  }

  /**
   * Decide what this bot is holding down this tick.
   *
   * Reads the authoritative world, which is fine: this runs on the server,
   * which already knows everything. It is kept honest by the visibility test
   * and the reaction delay rather than by hiding state from it, because a bot
   * that cheated would be indistinguishable from a bot that was simply good,
   * and the point of these is to make a dev room playable.
   */
  think(world: WorldState): Input {
    const me = world.players[this.slot];
    const tick = world.tick;

    if (!me.alive) {
      this.target = -1;
      this.fireAt = Number.POSITIVE_INFINITY;
      return this.input(tick, 0, 0, false, false, false, 0);
    }

    // Wander: hold a heading for a while, then pick another.
    if (tick >= this.headingUntil) {
      this.headingUntil = tick + HEADING_MIN + this.rand(HEADING_MAX - HEADING_MIN);
      this.aim = this.rand(YAW_UNITS);
      this.strafe = this.rand(3) - 1;
    }

    // Walking into a wall for long enough counts as stuck. A new heading and
    // a hop clears both a corner and a step the bot failed to climb.
    const moved = (me.x - this.lastX) * (me.x - this.lastX) +
      (me.z - this.lastZ) * (me.z - this.lastZ);
    this.lastX = me.x;
    this.lastZ = me.z;
    let jump = false;
    if (moved < 0.0004) {
      this.stuck++;
      if (this.stuck > STUCK_TICKS) {
        this.stuck = 0;
        this.headingUntil = 0;
        jump = true;
      }
    } else {
      this.stuck = 0;
    }

    // Face the nearest player we can actually see.
    const seen = this.nearestVisible(world);
    if (seen < 0) {
      this.target = -1;
      this.fireAt = Number.POSITIVE_INFINITY;
    } else {
      if (seen !== this.target) {
        this.target = seen;
        this.fireAt = tick + REACTION_MIN + this.rand(REACTION_MAX - REACTION_MIN);
      }
      const t = world.players[seen];
      const dx = t.x - me.x;
      const dz = t.z - me.z;
      const dy = (t.y + EYE_HEIGHT * 0.6) - (me.y + EYE_HEIGHT);
      // Yaw units run the same way sim.ts reads them: x is -sin, z is -cos.
      const want = quantYaw(Math.atan2(-dx, -dz));
      this.aim = (want + this.rand(AIM_SLOP * 2) - AIM_SLOP + YAW_UNITS) % YAW_UNITS;
      this.pitch = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));
      this.strafe = 0;
    }

    // Turn towards where we want to be looking, the short way round.
    let delta = this.aim - this.yaw;
    if (delta > YAW_UNITS / 2) delta -= YAW_UNITS;
    if (delta < -YAW_UNITS / 2) delta += YAW_UNITS;
    const turn = delta > TURN_RATE ? TURN_RATE : delta < -TURN_RATE ? -TURN_RATE : delta;
    this.yaw = ((this.yaw + turn) % YAW_UNITS + YAW_UNITS) % YAW_UNITS;
    const off = delta - turn;

    // Reaction delay served, and actually pointing at them.
    const onTarget = this.target >= 0 && tick >= this.fireAt &&
      off <= AIM_TOLERANCE && off >= -AIM_TOLERANCE;

    // Change weapon now and then, so the swap path gets exercised in a dev
    // room and in the match log rather than only in a test.
    let swapTo = 0;
    if (tick >= this.swapAt) {
      this.swapAt = tick + SWAP_EVERY;
      this.weapon = this.rand(WEAPON_COUNT);
      swapTo = this.weapon + 1;
    }

    const spec = WEAPONS[me.weapon];
    const mag = me.ammo[me.weapon];
    // Reload when dry, or while there is nothing to shoot at and the
    // magazine is low. The sim reloads a dry weapon on its own, but asking
    // first means a bot is not caught mid reload the moment it sees someone.
    const reload = me.reloadUntil === 0 &&
      (mag === 0 || (this.target < 0 && mag < spec.mag / 3));

    // A semi automatic weapon has to have its trigger released between
    // shots, so pull for a single tick and wait out the interval. An
    // automatic one just holds.
    let fire = false;
    if (onTarget && mag > 0) {
      if (spec.auto) {
        fire = true;
      } else if (tick - this.lastPull >= spec.fireInterval + 2) {
        fire = true;
        this.lastPull = tick;
      }
    }

    // Walk forward unless we are shooting at someone close by.
    const forward = this.target >= 0 && this.closeTo(world, this.target) ? 0 : 1;
    return this.input(tick, this.strafe, forward, fire, jump, reload, swapTo);
  }

  private closeTo(world: WorldState, slot: number): boolean {
    const me = world.players[this.slot];
    const t = world.players[slot];
    const dx = t.x - me.x;
    const dz = t.z - me.z;
    return dx * dx + dz * dz < 36;
  }

  /**
   * Nearest living player with an unobstructed line to our eye, or -1.
   *
   * Uses the same grid ray the hit registration uses, so a bot cannot see
   * through a booth wall or a gallery deck that a shot could not pass.
   */
  private nearestVisible(world: WorldState): number {
    const me = world.players[this.slot];
    const ox = me.x;
    const oy = me.y + EYE_HEIGHT;
    const oz = me.z;
    let best = -1;
    // Only as far as the weapon in hand can actually shoot, so a bot holding
    // a shotgun closes the distance instead of standing in the open
    // pretending it can hit something thirty blocks away.
    let bestDist = WEAPONS[me.weapon].range;

    for (let i = 0; i < world.players.length; i++) {
      if (i === this.slot) continue;
      const t = world.players[i];
      if (!t.alive) continue;
      const dx = t.x - ox;
      const dy = (t.y + EYE_HEIGHT * 0.6) - oy;
      const dz = t.z - oz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist >= bestDist || dist === 0) continue;
      const wall = rayGrid(ox, oy, oz, dx / dist, dy / dist, dz / dist, dist);
      if (wall < dist) continue;
      best = i;
      bestDist = dist;
    }
    return best;
  }

  private input(
    tick: number, strafe: number, forward: number, fire: boolean, jump: boolean,
    reload: boolean, weapon: number,
  ): Input {
    return {
      tick: this.seq++,
      // A bot is inside the server, so it is never behind: it aims at the
      // present, which means zero rewind. No lag compensation for the house.
      view: tick,
      moveX: quantAxis(strafe),
      moveY: quantAxis(forward),
      yaw: this.yaw,
      pitch: quantPitch(this.pitch),
      fire: fire ? 1 : 0,
      jump: jump ? 1 : 0,
      reload: reload ? 1 : 0,
      weapon,
    };
  }
}
