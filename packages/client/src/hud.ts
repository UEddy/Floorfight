import { MAX_HP, TICK_HZ, type HitEvent } from "../../shared/sim";
import { WEAPONS, weaponName } from "../../shared/weapons";
import type { RosterEntry, SnapshotPlayer, Standing } from "../../shared/protocol";
import { SLOT_COLORS } from "./render";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function hex(c: number): string {
  return `#${c.toString(16).padStart(6, "0")}`;
}

export function shortWallet(w: string): string {
  return w.length > 10 ? `${w.slice(0, 4)}...${w.slice(-4)}` : w;
}

/** Where a nameplate should be drawn, worked out by the renderer. */
/** Weapon silhouettes for the touch weapon bar, original, in order of WEAPONS. */
const WEAPON_ICONS: readonly string[] = [
  // Rifle: stock, receiver, magazine, barrel.
  `<svg class="ico" viewBox="0 0 40 22"><path d="M2 9h6l2-2h18v2h10v2H28l-1 2h-4l-1 5h-4l1-5h-3l-2 2h-3l-1-2H8L4 14H2z"/></svg>`,
  // Pistol.
  `<svg class="ico" viewBox="0 0 40 22"><path d="M10 6h22v5H22l-1 2h-3l-2 6h-6l2-8h-2z"/></svg>`,
  // Shotgun: long barrel, pump, stock.
  `<svg class="ico" viewBox="0 0 40 22"><path d="M1 10l7-2h31v2H27v3h-8v-2h-4l-2 2H9L4 15H1z"/></svg>`,
];

export interface Plate {
  slot: number;
  hp: number;
  sx: number;
  sy: number;
}

/**
 * Everything drawn here comes from server messages: scores and deaths from
 * snapshots, hits, kills, damage numbers and the weapon that did it from the
 * server's hit events. The client never scores anything itself and never
 * invents a damage number: if the server did not say it, it is not on screen.
 */
export class Hud {
  private hit = $("hitmarker");
  private hitTimer = 0;
  private feed = $("feed");
  private board = $("board");
  private timer = $("timer");
  private top3El = $("top3");
  private hp = $("hp");
  private net = $("net");
  private center = $("center");
  private elim = $("elim");
  private killedByEl = $("killedby");
  private tint = $("tint");
  private respawnEl = $("respawn");
  private ammoEl = $("ammo");
  private weaponsEl = $("weapons");
  private dmg = $("dmg");
  private dmgDir = $("dmgdir");
  private reconnectEl = $("reconnect");
  private plates = $("plates");
  private debugEl = $("debug");
  private over = $("over");
  private stick = $("stick");
  private boardKey = "";
  private top3Key = "";
  private weaponKey = "";
  private ammoKey = "";
  private plateEls: HTMLElement[] = [];
  names: string[] = [];

  constructor(private localSlot: number) {
    this.buildWeaponBar();
  }

  private crossEl = document.getElementById("crosshair") as HTMLElement;
  private crossGap = -1;

  /** Open the crosshair to a gap, in CSS pixels from the centre. */
  crosshair(gap: number): void {
    const g = Math.round(gap * 2) / 2;
    if (g === this.crossGap) return;
    this.crossGap = g;
    this.crossEl.style.setProperty("--gap", `${g}px`);
  }

  setRoster(roster: RosterEntry[]): void {
    this.names = roster.map((r) => `P${r.slot + 1} ${shortWallet(r.wallet)}`);
  }

  /** Short name for a slot, as used in the feed and the banners. */
  who(slot: number): string {
    return slot === this.localSlot ? "You" : `P${slot + 1}`;
  }

  message(text: string): void {
    this.center.textContent = text;
  }

  /* ------------------------------------------------------------ combat --- */

  hitMarker(e: HitEvent): void {
    this.hit.className = `hud show${e.head ? " head" : ""}${e.lethal ? " kill" : ""}`;
    clearTimeout(this.hitTimer);
    this.hitTimer = window.setTimeout(() => {
      this.hit.className = "hud";
    }, e.lethal ? 420 : 140);
  }

  /** A damage number over the victim, at the screen position given. */
  damageNumber(amount: number, head: boolean, sx: number, sy: number): void {
    const el = document.createElement("div");
    el.textContent = String(Math.round(amount));
    if (head) el.className = "head";
    el.style.left = `${Math.round(sx)}px`;
    el.style.top = `${Math.round(sy)}px`;
    this.dmg.append(el);
    // The rise animation is 900 ms; give it a little slack then drop the node.
    window.setTimeout(() => el.remove(), 1000);
    while (this.dmg.children.length > 24) this.dmg.firstElementChild?.remove();
  }

  /**
   * We were hit. `relative` is the bearing of the shooter from where we are
   * looking, in radians, positive to the left, the way yaw turns.
   */
  damageFrom(relative: number): void {
    const el = document.createElement("div");
    el.style.transform = `rotate(${-relative}rad)`;
    this.dmgDir.append(el);
    window.setTimeout(() => el.remove(), 950);
    while (this.dmgDir.children.length > 4) this.dmgDir.firstElementChild?.remove();
  }

  /** The reconnecting pill: the attempt number, or null to take it down. */
  reconnecting(attempt: number | null): void {
    if (attempt === null) {
      this.reconnectEl.classList.remove("show");
      return;
    }
    this.reconnectEl.textContent = `Reconnecting... ${attempt > 1 ? `(try ${attempt})` : ""}`;
    this.reconnectEl.classList.add("show");
  }

  /** We killed someone. */
  eliminated(slot: number): void {
    this.elim.textContent = `Eliminated ${this.who(slot)}`;
    this.elim.classList.remove("show");
    // Restart the animation: without the reflow the class goes back on in the
    // same frame and nothing replays.
    void this.elim.offsetWidth;
    this.elim.classList.add("show");
  }

  /**
   * We died. Shows who did it, what with, and how much health they had
   * left, which is the number that says whether it was close, until the
   * respawn clears it.
   */
  killedBy(slot: number, weapon: number, hpLeft: number | null = null): void {
    const hp = hpLeft !== null && hpLeft > 0
      ? `<span class="left">${Math.round(hpLeft)} hp left</span>` : "";
    this.killedByEl.innerHTML =
      `Killed by <b>${this.who(slot)}</b> &middot; ${weaponName(weapon)}${hp}`;
  }

  /**
   * Death tint and countdown. `secondsLeft` null means alive: everything
   * comes off.
   */
  death(secondsLeft: number | null): void {
    document.body.classList.toggle("dead", secondsLeft !== null);
    if (secondsLeft === null) {
      this.tint.classList.remove("show");
      this.respawnEl.textContent = "";
      this.killedByEl.innerHTML = "";
      return;
    }
    this.tint.classList.add("show");
    const s = Math.max(0, Math.ceil(secondsLeft));
    this.respawnEl.textContent = s > 0 ? String(s) : "";
  }

  kill(e: HitEvent): void {
    const row = document.createElement("div");
    const tag = (s: number) =>
      `<span style="color:${hex(SLOT_COLORS[s % SLOT_COLORS.length])}">${this.who(s)}</span>`;
    row.innerHTML = `${tag(e.shooter)} ${e.head ? "headshot" : "killed"} ${tag(e.victim)}` +
      ` <span class="w">${weaponName(e.weapon)}</span>`;
    if (e.shooter === this.localSlot || e.victim === this.localSlot) row.className = "me";
    this.feed.prepend(row);
    while (this.feed.children.length > 6) this.feed.lastElementChild?.remove();
  }

  /* --------------------------------------------------------- scoreboard --- */

  scoreboard(players: SnapshotPlayer[], seated: Set<number>): void {
    const rows = [...players].sort((a, b) => b.k - a.k || a.d - b.d || a.s - b.s);
    const key = rows.map((p) => `${p.s}:${p.k}:${p.d}:${seated.has(p.s) ? 1 : 0}`).join(",");
    if (key !== this.boardKey) {
      this.boardKey = key;
      this.board.innerHTML =
        `<div class="row head"><span class="name">player</span><span>K</span><span>D</span></div>` +
        rows
          .map((p) => {
            const cls = p.s === this.localSlot ? "me" : seated.has(p.s) ? "" : "empty";
            const sw = `<span class="sw" style="background:${hex(SLOT_COLORS[p.s % SLOT_COLORS.length])}"></span>`;
            const name = p.s === this.localSlot ? `P${p.s + 1} (you)` : `P${p.s + 1}`;
            return `<div class="row ${cls}"><span class="name">${sw}${name}</span><span>${p.k}</span><span>${p.d}</span></div>`;
          })
          .join("");
    }

    // Top three, which is also who gets paid: the pot splits 50/30/20.
    const top = rows.slice(0, 3);
    const tkey = top.map((p) => `${p.s}:${p.k}`).join(",");
    if (tkey !== this.top3Key) {
      this.top3Key = tkey;
      this.top3El.innerHTML = top
        .map((p, i) => {
          const c = hex(SLOT_COLORS[p.s % SLOT_COLORS.length]);
          return `<div><span class="n">${i + 1}</span>` +
            `<span style="color:${c}">${this.who(p.s)}</span>` +
            `<span class="k">${p.k}</span></div>`;
        })
        .join("");
    }
  }

  clock(secondsLeft: number | null): void {
    if (secondsLeft === null) {
      this.timer.textContent = "3:00";
      this.timer.classList.remove("low");
      return;
    }
    const s = Math.max(0, Math.ceil(secondsLeft));
    // Once a second, not once a frame: a DOM write is a style recalculation,
    // and sixty of them a second for a number that has not changed is the
    // sort of thing that makes a phone's frame time stutter.
    if (s === this.clockKey) return;
    this.clockKey = s;
    this.timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    this.timer.classList.toggle("low", s <= 10);
  }
  private clockKey = -1;

  health(hp: number, alive: boolean): void {
    const key = alive ? hp : -1;
    if (key === this.hpKey) return;
    this.hpKey = key;
    this.hp.textContent = alive ? String(hp) : "dead";
    this.hp.classList.toggle("hurt", alive && hp <= MAX_HP * 0.34);
  }
  private hpKey = -2;

  /* ------------------------------------------------------------ weapons --- */

  private buildWeaponBar(): void {
    this.weaponsEl.innerHTML = WEAPONS
      .map((w, i) => `<div data-w="${i}">${WEAPON_ICONS[i] ?? ""}<span class="key">${i + 1}</span>` +
        `<span class="nm">${w.name.toUpperCase()}</span><span class="a">-</span></div>`)
      .join("");
  }

  /** Tapping a weapon slot asks for that weapon. Touch only. */
  onWeaponTap(pick: (index: number) => void): void {
    for (const el of Array.from(this.weaponsEl.children) as HTMLElement[]) {
      el.addEventListener("touchstart", (e) => {
        e.preventDefault();
        e.stopPropagation();
        pick(Number(el.dataset.w));
      }, { passive: false });
    }
  }

  /**
   * The weapon bar and the ammo counter.
   *
   * `mags` is this player's magazines as the server last reported them, so
   * the number on screen is the number the server will fire from.
   */
  weapons(current: number, mag: number, reloadTicks: number): void {
    const key = `${current}:${mag}:${reloadTicks > 0 ? 1 : 0}`;
    if (key === this.weaponKey) return;
    this.weaponKey = key;
    const slots = this.weaponsEl.children;
    for (let i = 0; i < slots.length; i++) {
      const el = slots[i] as HTMLElement;
      el.classList.toggle("on", i === current);
      const a = el.querySelector(".a");
      if (a) a.textContent = i === current ? `${mag}/${WEAPONS[i].mag}` : `${WEAPONS[i].mag}`;
    }
  }

  ammo(current: number, mag: number, reloadTicks: number): void {
    const spec = WEAPONS[current];
    const key = `${current}:${mag}:${reloadTicks > 0 ? Math.ceil(reloadTicks / 6) : 0}`;
    if (key === this.ammoKey) return;
    this.ammoKey = key;
    const reloading = reloadTicks > 0;
    this.ammoEl.className = `hud${reloading ? " reloading" : mag === 0 ? " empty" : ""}`;
    this.ammoEl.innerHTML = reloading
      ? `<span class="wname">${spec.name.toUpperCase()}</span>` +
        `<span class="now">RELOADING</span>`
      : `<span class="wname">${spec.name.toUpperCase()}</span>` +
        `<span class="now">${mag}</span><span class="mag"> / ${spec.mag}</span>`;
  }

  /* ------------------------------------------------------------- plates --- */

  /** Names and health bars floating over the heads the renderer could see. */
  showPlates(list: Plate[]): void {
    while (this.plateEls.length < list.length) {
      const el = document.createElement("div");
      el.innerHTML = `<span class="nm"></span><div class="bar"><i></i></div>`;
      this.plates.append(el);
      this.plateEls.push(el);
    }
    for (let i = 0; i < this.plateEls.length; i++) {
      const el = this.plateEls[i];
      const p = list[i];
      if (!p) {
        el.style.display = "none";
        continue;
      }
      if (el.style.display !== "block") el.style.display = "block";
      // Moved with a transform, which the compositor does on its own, rather
      // than left and top, which lay the page out again every frame.
      el.style.transform = `translate3d(${p.sx.toFixed(1)}px, ${p.sy.toFixed(1)}px, 0) translate(-50%, -100%)`;
      const frac = Math.max(0, Math.min(1, p.hp / MAX_HP));
      const key = `${p.slot}:${Math.round(frac * 100)}`;
      if (el.dataset.k !== key) {
        el.dataset.k = key;
        const nm = el.querySelector(".nm") as HTMLElement;
        nm.textContent = this.who(p.slot);
        nm.style.color = hex(SLOT_COLORS[p.slot % SLOT_COLORS.length]);
        const bar = el.querySelector(".bar i") as HTMLElement;
        bar.style.width = `${(frac * 100).toFixed(0)}%`;
        bar.className = frac <= 0.34 ? "low" : "";
      }
    }
  }

  /* -------------------------------------------------------------- debug --- */

  /**
   * The ?debug=1 overlay. Frame rate, the one per cent low, draw calls and
   * the ping the server measured, which is the set of numbers needed to say
   * anything honest about performance on a given phone.
   */
  debug(lines: string[] | null): void {
    if (!lines) {
      this.debugEl.classList.remove("show");
      return;
    }
    this.debugEl.classList.add("show");
    this.debugEl.textContent = lines.join("\n");
  }

  netStats(text: string): void {
    if (text === this.netKey) return;
    this.netKey = text;
    this.net.textContent = text;
  }
  private netKey = "";

  /**
   * The movement stick. While a thumb is on it, it sits where the thumb
   * landed; otherwise a faint one rests at the bottom left so a new player
   * can see where to put a thumb. Touch devices only.
   */
  stickAt(s: { ox: number; oy: number; x: number; y: number } | null): void {
    if (!matchMedia("(pointer: coarse)").matches) {
      if (this.stickKey !== "off") { this.stickKey = "off"; this.stick.style.display = "none"; }
      return;
    }
    const rest = { ox: 96 + 0, oy: innerHeight - 118, x: 0, y: 0 };
    const at = s ?? rest;
    const dx = s ? s.x - s.ox : 0;
    const dy = s ? s.y - s.oy : 0;
    const len = Math.hypot(dx, dy);
    // Clamp the knob to the ring so a long drag does not pull it outside.
    const k = len > 40 ? 40 / len : 1;
    const key = `${s ? 1 : 0}:${at.ox}:${at.oy}:${Math.round(dx * k)}:${Math.round(dy * k)}`;
    if (key === this.stickKey) return;
    this.stickKey = key;
    this.stick.style.display = "block";
    this.stick.classList.toggle("idle", !s);
    this.stick.style.left = `${at.ox}px`;
    this.stick.style.top = `${at.oy}px`;
    const knob = this.stick.firstElementChild as HTMLElement | null;
    if (knob) knob.style.transform = `translate3d(${(dx * k).toFixed(0)}px, ${(dy * k).toFixed(0)}px, 0)`;
  }
  private stickKey = "";

  /**
   * The end of round card.
   *
   * `spread` is the result of checking the revealed salt against the
   * commitment this client was given when it joined. It is shown because a
   * verification nobody can see is not worth doing: if it ever says no, the
   * player should know before the payout does.
   */
  showOver(
    standings: Standing[], logHash: string, spread: "ok" | "bad" | "unknown",
    onAgain: () => void,
  ): void {
    const body = this.over.querySelector("tbody")!;
    body.innerHTML = standings
      .map((s) => {
        const me = s.slot === this.localSlot ? ` class="me"` : "";
        const name = `P${s.slot + 1} ${shortWallet(s.wallet)}${s.slot === this.localSlot ? " (you)" : ""}`;
        return `<tr${me}><td>${s.place}</td><td>${name}</td><td>${s.kills}</td><td>${s.deaths}</td></tr>`;
      })
      .join("");
    this.over.querySelector(".hash b")!.textContent = logHash;
    const note = this.over.querySelector(".spread")!;
    note.textContent = spread === "ok"
      ? "Spread salt matches the commitment from join"
      : spread === "bad"
        ? "WARNING: revealed spread salt does not match the commitment"
        : "Spread salt not checked: no commitment was recorded";
    note.className = `spread${spread === "bad" ? " bad" : ""}`;
    this.over.querySelector("button")!.onclick = onAgain;
    this.over.classList.add("show");
  }
}

/** Seconds a tick count represents, for the respawn countdown. */
export function ticksToSeconds(ticks: number): number {
  return ticks / TICK_HZ;
}
