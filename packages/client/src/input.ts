import { PITCH_LIMIT } from "../../shared/sim";
import { WEAPON_COUNT } from "../../shared/weapons";

/**
 * Raw player intent. This is all the client ever tells the server: which way
 * it wants to move, where it is looking, and which of the four buttons are
 * down. Firing, reloading and swapping are requests. The server decides
 * whether a shot happened, what it hit and how much it hurt.
 */
export interface Intent {
  moveX: number; // -1..1, strafe right positive
  moveY: number; // -1..1, forward positive
  yaw: number;   // radians, continuous
  pitch: number; // radians, clamped
  fire: boolean;
  jump: boolean;
  reload: boolean;
  /** 0 for no change, or 1..WEAPON_COUNT to ask for that weapon. */
  weapon: number;
}

const MOUSE_SENS = 0.0022;
const TOUCH_LOOK_SENS = 0.006;
/**
 * Dragging off the fire button aims. Slightly slower than a bare look drag:
 * the thumb is already committed to holding the trigger, so the same
 * sensitivity makes it twitchy.
 */
const FIRE_DRAG_SENS = 0.0045;
const STICK_RADIUS = 56;

interface Touch2 { id: number; x: number; y: number }

export class Controls {
  readonly intent: Intent = {
    moveX: 0, moveY: 0, yaw: 0, pitch: 0,
    fire: false, jump: false, reload: false, weapon: 0,
  };

  private keys = new Set<string>();
  private mouseFire = false;
  private touchFire = false;
  private touchJump = false;
  private touchReload = false;
  /** Weapon request, consumed by the next sample so one press is one swap. */
  private pendingWeapon = 0;
  private stick: { id: number; ox: number; oy: number; x: number; y: number } | null = null;
  private look: Touch2 | null = null;
  /** The finger holding the fire button, which can also aim. */
  private fireTouch: Touch2 | null = null;
  private currentWeapon = 0;

  /** Test hook overrides. Only set through the dev-only window.arena handle. */
  botMove: { x: number; y: number } | null = null;
  botFire = false;
  botJump = false;

  constructor(
    private canvas: HTMLCanvasElement,
    fireButton: HTMLElement,
    jumpButton: HTMLElement,
    reloadButton: HTMLElement,
    swapButton: HTMLElement,
    /** Called on the first real gesture, to start audio. */
    private onGesture: () => void = () => {},
  ) {
    addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      // Space scrolls the page by default, which on a phone browser in
      // landscape is enough to hide the canvas.
      if (e.code === "Space") e.preventDefault();
      if (e.code === "Digit1") this.pendingWeapon = 1;
      if (e.code === "Digit2") this.pendingWeapon = 2;
      if (e.code === "Digit3") this.pendingWeapon = 3;
      if (e.code === "KeyQ") this.cycle();
      this.onGesture();
    });
    addEventListener("keyup", (e) => { this.keys.delete(e.code); });
    addEventListener("blur", () => {
      this.keys.clear();
      this.mouseFire = false;
    });

    canvas.addEventListener("click", () => {
      this.onGesture();
      if (document.pointerLockElement !== canvas && !isTouch()) void canvas.requestPointerLock();
    });
    addEventListener("mousemove", (e) => {
      if (document.pointerLockElement !== canvas) return;
      this.turn(-e.movementX * MOUSE_SENS, -e.movementY * MOUSE_SENS);
    });
    addEventListener("mousedown", (e) => {
      if (e.button === 0 && document.pointerLockElement === canvas) this.mouseFire = true;
    });
    addEventListener("mouseup", (e) => { if (e.button === 0) this.mouseFire = false; });
    addEventListener("wheel", (e) => {
      if (document.pointerLockElement !== canvas) return;
      e.preventDefault();
      this.cycle(e.deltaY > 0 ? 1 : -1);
    }, { passive: false });

    // Touch: a floating stick wherever the left thumb lands, and a drag
    // anywhere on the right half to look.
    canvas.addEventListener("touchstart", (e) => {
      e.preventDefault();
      this.onGesture();
      for (const t of Array.from(e.changedTouches)) {
        if (t.clientX < innerWidth / 2 && !this.stick) {
          this.stick = { id: t.identifier, ox: t.clientX, oy: t.clientY, x: t.clientX, y: t.clientY };
        } else if (!this.look) {
          this.look = { id: t.identifier, x: t.clientX, y: t.clientY };
        }
      }
    }, { passive: false });
    canvas.addEventListener("touchmove", (e) => {
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) {
        if (this.stick && t.identifier === this.stick.id) {
          this.stick.x = t.clientX;
          this.stick.y = t.clientY;
        } else if (this.look && t.identifier === this.look.id) {
          this.turn(
            -(t.clientX - this.look.x) * TOUCH_LOOK_SENS,
            -(t.clientY - this.look.y) * TOUCH_LOOK_SENS,
          );
          this.look.x = t.clientX;
          this.look.y = t.clientY;
        }
      }
    }, { passive: false });
    const end = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (this.stick && t.identifier === this.stick.id) this.stick = null;
        if (this.look && t.identifier === this.look.id) this.look = null;
      }
    };
    canvas.addEventListener("touchend", end);
    canvas.addEventListener("touchcancel", end);

    /*
     * The fire button also aims.
     *
     * Once a thumb lands on it the touch keeps being delivered here even
     * after the finger slides off, which is what makes holding the trigger
     * and tracking a target at the same time possible with two thumbs. The
     * alternative, lifting off to aim, means losing the shot every time.
     */
    fireButton.addEventListener("touchstart", (e) => {
      e.preventDefault();
      this.onGesture();
      const t = e.changedTouches[0];
      this.touchFire = true;
      this.fireTouch = { id: t.identifier, x: t.clientX, y: t.clientY };
    }, { passive: false });
    fireButton.addEventListener("touchmove", (e) => {
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) {
        if (!this.fireTouch || t.identifier !== this.fireTouch.id) continue;
        this.turn(
          -(t.clientX - this.fireTouch.x) * FIRE_DRAG_SENS,
          -(t.clientY - this.fireTouch.y) * FIRE_DRAG_SENS,
        );
        this.fireTouch.x = t.clientX;
        this.fireTouch.y = t.clientY;
      }
    }, { passive: false });
    const fireOff = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (this.fireTouch && t.identifier !== this.fireTouch.id) continue;
        this.touchFire = false;
        this.fireTouch = null;
      }
    };
    fireButton.addEventListener("touchend", fireOff);
    fireButton.addEventListener("touchcancel", fireOff);

    const hold = (el: HTMLElement, set: (on: boolean) => void) => {
      el.addEventListener("touchstart", (e) => {
        e.preventDefault();
        this.onGesture();
        set(true);
      }, { passive: false });
      el.addEventListener("touchend", () => set(false));
      el.addEventListener("touchcancel", () => set(false));
    };
    hold(jumpButton, (on) => { this.touchJump = on; });
    hold(reloadButton, (on) => { this.touchReload = on; });
    swapButton.addEventListener("touchstart", (e) => {
      e.preventDefault();
      this.onGesture();
      this.cycle();
    }, { passive: false });
  }

  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  /** Tell the controls which weapon the server says we are holding. */
  syncWeapon(index: number): void {
    this.currentWeapon = index;
  }

  /** Ask for the next weapon along. */
  cycle(step = 1): void {
    const next = ((this.currentWeapon + step) % WEAPON_COUNT + WEAPON_COUNT) % WEAPON_COUNT;
    this.pendingWeapon = next + 1;
  }

  turn(dYaw: number, dPitch: number): void {
    const i = this.intent;
    i.yaw += dYaw;
    i.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, i.pitch + dPitch));
  }

  /** Refresh the intent from whatever devices are active. */
  sample(): Intent {
    const i = this.intent;
    let x = 0;
    let y = 0;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) y += 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) y -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) x += 1;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) x -= 1;
    if (this.stick) {
      x += Math.max(-1, Math.min(1, (this.stick.x - this.stick.ox) / STICK_RADIUS));
      y -= Math.max(-1, Math.min(1, (this.stick.y - this.stick.oy) / STICK_RADIUS));
    }
    if (this.botMove) {
      x = this.botMove.x;
      y = this.botMove.y;
    }
    i.moveX = Math.max(-1, Math.min(1, x));
    i.moveY = Math.max(-1, Math.min(1, y));
    i.fire = this.mouseFire || this.touchFire || this.botFire;
    // Space is jump, not fire: the mouse fires on a keyboard, and the hall is
    // three levels tall, so jump has to be a key that is easy to hold.
    i.jump = this.touchJump || this.botJump ||
      this.keys.has("Space") || this.keys.has("KeyJ");
    i.reload = this.touchReload || this.keys.has("KeyR");
    // One press, one request: the bit is consumed here so holding the button
    // does not cycle through every weapon in the game.
    i.weapon = this.pendingWeapon;
    this.pendingWeapon = 0;
    return i;
  }

  get stickVisual(): { ox: number; oy: number; x: number; y: number } | null {
    return this.stick;
  }
}

function isTouch(): boolean {
  return matchMedia("(pointer: coarse)").matches;
}
