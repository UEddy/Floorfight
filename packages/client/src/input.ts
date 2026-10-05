import { PITCH_LIMIT } from "../../shared/sim";

/**
 * Raw player intent. This is all the client ever tells the server: which way
 * it wants to move, where it is looking, and whether the trigger is down.
 */
export interface Intent {
  moveX: number; // -1..1, strafe right positive
  moveY: number; // -1..1, forward positive
  yaw: number;   // radians, continuous
  pitch: number; // radians, clamped
  fire: boolean;
  jump: boolean;
}

const MOUSE_SENS = 0.0022;
const TOUCH_LOOK_SENS = 0.006;
const STICK_RADIUS = 60;

export class Controls {
  readonly intent: Intent = { moveX: 0, moveY: 0, yaw: 0, pitch: 0, fire: false, jump: false };

  private keys = new Set<string>();
  private mouseFire = false;
  private touchFire = false;
  private touchJump = false;
  private stick: { id: number; ox: number; oy: number; x: number; y: number } | null = null;
  private look: { id: number; x: number; y: number } | null = null;

  /** Test hook overrides. Only set through the dev-only window.arena handle. */
  botMove: { x: number; y: number } | null = null;
  botFire = false;
  botJump = false;

  constructor(private canvas: HTMLCanvasElement, fireButton: HTMLElement, jumpButton: HTMLElement) {
    addEventListener("keydown", (e) => { this.keys.add(e.code); });
    addEventListener("keyup", (e) => { this.keys.delete(e.code); });
    addEventListener("blur", () => { this.keys.clear(); this.mouseFire = false; });
    // Space scrolls the page by default, which on a phone browser in landscape
    // is enough to hide the canvas.
    addEventListener("keydown", (e) => { if (e.code === "Space") e.preventDefault(); });

    canvas.addEventListener("click", () => {
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

    // Touch: left half is a floating stick, right half drags the view, and a
    // dedicated button fires.
    canvas.addEventListener("touchstart", (e) => {
      e.preventDefault();
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
          this.turn(-(t.clientX - this.look.x) * TOUCH_LOOK_SENS, -(t.clientY - this.look.y) * TOUCH_LOOK_SENS);
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

    fireButton.addEventListener("touchstart", (e) => { e.preventDefault(); this.touchFire = true; }, { passive: false });
    fireButton.addEventListener("touchend", () => { this.touchFire = false; });
    fireButton.addEventListener("touchcancel", () => { this.touchFire = false; });

    jumpButton.addEventListener("touchstart", (e) => { e.preventDefault(); this.touchJump = true; }, { passive: false });
    jumpButton.addEventListener("touchend", () => { this.touchJump = false; });
    jumpButton.addEventListener("touchcancel", () => { this.touchJump = false; });
  }

  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
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
    // Space is jump, not fire: the mouse fires on a keyboard, and the hall is
    // three levels tall, so jump has to be a key that is easy to hold.
    i.fire = this.mouseFire || this.touchFire || this.botFire;
    i.jump = this.touchJump || this.botJump ||
      this.keys.has("Space") || this.keys.has("KeyJ");
    return i;
  }

  get stickVisual(): { ox: number; oy: number; x: number; y: number } | null {
    return this.stick;
  }
}

function isTouch(): boolean {
  return matchMedia("(pointer: coarse)").matches;
}
