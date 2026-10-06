import * as THREE from "three";
import { W_PISTOL, W_RIFLE, W_SHOTGUN } from "../../shared/weapons";
import { buildParts, type Part } from "./boxes";
import { T, atlas, tileUV } from "./textures";

/**
 * The first person view model: two blocky arms and the gun in them.
 *
 * Everything here is decoration driven by what the client already knows. The
 * kick plays when the client draws its own shot, the reload plays off the
 * reload countdown the server sent, and the bob follows the predicted
 * position. Nothing in this file is sent anywhere or read by the sim.
 *
 * It is drawn in its own pass, after the hall, with the depth buffer cleared
 * in between and its own narrower field of view. That keeps the gun from
 * sinking into a wall the player is pressed against, and keeps it the same
 * shape whatever the world field of view is set to.
 */

type V3 = [number, number, number];

/** A box running from one point to another, for forearms. */
function limb(from: V3, to: V3, size: number, tile: number, tint?: number): Part {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const len = Math.hypot(dx, dy, dz);
  return {
    x: (from[0] + to[0]) / 2, y: (from[1] + to[1]) / 2, z: (from[2] + to[2]) / 2,
    w: size, h: size, d: len, tile, tint,
    rx: -Math.asin(dy / len), ry: Math.atan2(dx, dz),
  };
}

function box(
  x: number, y: number, z: number, w: number, h: number, d: number,
  tile: number, extra: Partial<Part> = {},
): Part {
  return { x, y, z, w, h, d, tile, ...extra };
}

interface WeaponModel {
  /** Gun and the right hand that holds it. */
  body: Part[];
  /** The magazine, moved separately during a reload. Empty for the shotgun. */
  mag: Part[];
  /** Where the left hand rests when it is not busy. */
  support: V3;
  /** Where the flash goes. */
  muzzle: V3;
  /** Where the whole thing sits in front of the camera. */
  hold: V3;
  /** How hard a shot kicks, as a multiple of the rifle's. */
  kick: number;
}

/**
 * Model space: origin at the trigger hand, barrel towards -z, up is +y. The
 * right forearm runs back and down to the bottom right corner of the screen,
 * where the shoulder would be.
 */
const RIGHT_ELBOW: V3 = [0.16, -0.32, 0.36];
const LEFT_ELBOW: V3 = [-0.3, -0.36, 0.12];

function rightArm(hand: V3): Part[] {
  return [
    box(hand[0], hand[1], hand[2], 0.085, 0.085, 0.095, T.SKIN),
    limb([hand[0] + 0.01, hand[1] - 0.02, hand[2] + 0.04], RIGHT_ELBOW, 0.11, T.CLOTH),
  ];
}

const MODELS: Record<number, WeaponModel> = {
  [W_RIFLE]: {
    body: [
      box(0, 0.01, -0.06, 0.07, 0.09, 0.34, T.GUNMETAL),
      box(0, 0.025, -0.36, 0.034, 0.034, 0.28, T.GUNMETAL),
      box(0, 0.012, -0.27, 0.064, 0.07, 0.17, T.ACCENT),
      box(0, 0.07, -0.08, 0.03, 0.035, 0.12, T.ACCENT),
      box(0, 0.075, -0.4, 0.014, 0.03, 0.014, T.GUNMETAL),
      box(0, -0.065, 0.03, 0.046, 0.1, 0.05, T.GUNMETAL, { rx: 0.35 }),
      box(0, -0.005, 0.2, 0.058, 0.085, 0.18, T.POLYMER),
      box(0, -0.02, 0.3, 0.064, 0.11, 0.04, T.GUNMETAL),
      ...rightArm([0.0, -0.075, 0.045]),
    ],
    mag: [box(0, -0.1, -0.12, 0.044, 0.13, 0.065, T.GUNMETAL, { rx: -0.2 })],
    support: [0.0, -0.035, -0.27],
    muzzle: [0, 0.025, -0.52],
    hold: [0.15, -0.2, -0.42],
    kick: 1,
  },
  [W_PISTOL]: {
    body: [
      box(0, 0.035, -0.08, 0.05, 0.055, 0.21, T.GUNMETAL),
      box(0, 0.035, -0.08, 0.052, 0.02, 0.12, T.POLYMER),
      box(0, 0.002, -0.07, 0.044, 0.03, 0.18, T.GUNMETAL),
      box(0, -0.06, 0.02, 0.046, 0.11, 0.058, T.GUNMETAL, { rx: 0.25 }),
      box(0, 0.068, -0.17, 0.012, 0.018, 0.014, T.ACCENT),
      box(0, 0.068, 0.0, 0.03, 0.016, 0.014, T.GUNMETAL),
      box(0, -0.018, -0.02, 0.012, 0.02, 0.04, T.GUNMETAL),
      ...rightArm([0.005, -0.07, 0.035]),
    ],
    mag: [box(0, -0.12, 0.035, 0.036, 0.04, 0.046, T.GUNMETAL, { rx: 0.25 })],
    support: [-0.04, -0.085, 0.03],
    muzzle: [0, 0.035, -0.2],
    hold: [0.1, -0.16, -0.36],
    kick: 1.7,
  },
  [W_SHOTGUN]: {
    body: [
      box(0, 0.012, -0.02, 0.072, 0.095, 0.2, T.GUNMETAL),
      box(0, 0.035, -0.36, 0.046, 0.046, 0.5, T.GUNMETAL),
      box(0, -0.012, -0.32, 0.038, 0.034, 0.42, T.GUNMETAL),
      box(0, 0.064, -0.6, 0.012, 0.02, 0.012, T.ACCENT),
      box(0, -0.06, 0.07, 0.048, 0.1, 0.05, T.GUNWOOD, { rx: 0.4 }),
      box(0, -0.03, 0.22, 0.062, 0.1, 0.24, T.GUNWOOD, { rx: 0.12 }),
      box(0, -0.05, 0.345, 0.066, 0.13, 0.03, T.LEATHER, { rx: 0.12 }),
      ...rightArm([0.0, -0.08, 0.075]),
    ],
    mag: [],
    support: [0.0, 0.0, -0.32],
    muzzle: [0, 0.035, -0.62],
    hold: [0.15, -0.21, -0.42],
    kick: 2.6,
  },
};

/** The pump, which the left hand works, and is part of the left hand mesh. */
const PUMP: Part = box(0, 0.012, 0, 0.07, 0.062, 0.15, T.GUNWOOD);

function leftArmParts(withPump: boolean): Part[] {
  // Built with the hand at the origin. The forearm is stretched every frame
  // by pointing the mesh from the elbow at wherever the hand needs to be.
  return [
    box(0, 0, 0, 0.085, 0.08, 0.1, T.SKIN),
    ...(withPump ? [PUMP] : []),
  ];
}

const clothUV = tileUV(T.CLOTH);

const smooth = (x: number) => x * x * (3 - 2 * x);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export class ViewModel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(54, 1, 0.01, 4);
  private root = new THREE.Group();
  private guns: THREE.Mesh[] = [];
  private mags: (THREE.Mesh | null)[] = [];
  private hands: THREE.Mesh[] = [];
  private forearm: THREE.Mesh;
  private flash: THREE.Mesh;

  private weapon = 0;
  private shownWeapon = 0;
  private swap = 1;
  private kick = 0;
  private kickSide = 0;
  private flashFor = 0;
  private phase = 0;
  private speed = 0;
  private lagYaw = 0;
  private lagPitch = 0;
  private lastYaw = 0;
  private lastPitch = 0;
  private time = 0;

  constructor() {
    const mat = new THREE.MeshBasicMaterial({ map: atlas(), vertexColors: true });
    this.camera.add(this.root);
    this.scene.add(this.camera);

    for (const w of [W_RIFLE, W_PISTOL, W_SHOTGUN]) {
      const model = MODELS[w];
      const gun = new THREE.Mesh(buildParts(model.body).geometry, mat);
      gun.visible = w === 0;
      this.root.add(gun);
      this.guns.push(gun);
      let mag: THREE.Mesh | null = null;
      if (model.mag.length) {
        mag = new THREE.Mesh(buildParts(model.mag).geometry, mat);
        gun.add(mag);
      }
      this.mags.push(mag);
      const hand = new THREE.Mesh(buildParts(leftArmParts(w === W_SHOTGUN)).geometry, mat);
      hand.visible = w === 0;
      this.root.add(hand);
      this.hands.push(hand);
    }

    // The left forearm: a unit box stretched and aimed each frame.
    this.forearm = new THREE.Mesh(
      buildParts([box(0, 0, 0.5, 0.105, 0.105, 1, T.CLOTH)]).geometry, mat,
    );
    this.root.add(this.forearm);

    // The flash: two crossed bright slabs, additive, a different size and
    // twist every shot. Cosmetic, so Math.random is fine here.
    const fg = new THREE.BufferGeometry();
    const f = 0.07;
    fg.setAttribute("position", new THREE.Float32BufferAttribute([
      -f, 0, 0, f, 0, 0, f, 0, -f * 3, -f, 0, 0, f, 0, -f * 3, -f, 0, -f * 3,
      0, -f, 0, 0, f, 0, 0, f, -f * 3, 0, -f, 0, 0, f, -f * 3, 0, -f, -f * 3,
      -f, -f, 0, f, -f, 0, f, f, 0, -f, -f, 0, f, f, 0, -f, f, 0,
    ], 3));
    this.flash = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({
      color: 0xffd27a, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    }));
    this.flash.visible = false;
    this.root.add(this.flash);
  }

  /** The player's colour on the sleeves. */
  setSleeve(colour: number): void {
    // The sleeves are drawn off the cloth tile, which is near white, so the
    // colour goes on the vertex colours of those faces and nothing else.
    for (const mesh of [...this.guns, this.forearm]) recolour(mesh, colour);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Our own shot, as the client draws it. */
  fired(): void {
    this.kick = Math.min(1.6, this.kick + 1);
    this.kickSide = (Math.random() - 0.5) * 2;
    this.flashFor = 0.05;
    this.flash.scale.setScalar(0.8 + Math.random() * 0.5);
    this.flash.rotation.z = Math.random() * Math.PI;
  }

  /**
   * One frame. `moving` is horizontal speed in blocks per second, `reload`
   * is how far through a reload the server says we are, 0 to 1, or null.
   */
  update(
    dt: number, weapon: number, reload: number | null, moving: number,
    yaw: number, pitch: number, alive: boolean, grounded: boolean,
  ): void {
    this.time += dt;
    this.root.visible = alive;
    if (!alive) return;

    if (weapon !== this.weapon) {
      this.weapon = weapon;
      this.swap = 0;
    }
    // Lower the old gun, then raise the new one.
    this.swap = Math.min(1, this.swap + dt / 0.32);
    if (this.swap >= 0.5 && this.shownWeapon !== this.weapon) {
      this.shownWeapon = this.weapon;
    }
    const lowered = this.swap < 0.5 ? smooth(this.swap * 2) : smooth((1 - this.swap) * 2);
    for (let i = 0; i < this.guns.length; i++) {
      this.guns[i].visible = i === this.shownWeapon;
      this.hands[i].visible = i === this.shownWeapon;
    }
    const model = MODELS[this.shownWeapon] ?? MODELS[0];

    // Bob, from how fast the feet are going. Off the ground it settles.
    const target = grounded ? Math.min(1, moving / 7.4) : 0;
    this.speed += (target - this.speed) * Math.min(1, dt * 10);
    this.phase += dt * (4 + 7 * this.speed);
    const bobX = Math.sin(this.phase) * 0.014 * this.speed;
    const bobY = -Math.abs(Math.cos(this.phase)) * 0.016 * this.speed;
    const idle = 1 - this.speed;
    const swayX = Math.sin(this.time * 1.1) * 0.004 * idle;
    const swayY = Math.sin(this.time * 2.2) * 0.003 * idle;

    // The gun trails a sharp turn a little, then catches up.
    let dyaw = yaw - this.lastYaw;
    if (dyaw > Math.PI) dyaw -= Math.PI * 2;
    if (dyaw < -Math.PI) dyaw += Math.PI * 2;
    const dpitch = pitch - this.lastPitch;
    this.lastYaw = yaw;
    this.lastPitch = pitch;
    const k = Math.min(1, dt * 9);
    this.lagYaw += (Math.max(-0.08, Math.min(0.08, dyaw)) - this.lagYaw) * k;
    this.lagPitch += (Math.max(-0.08, Math.min(0.08, dpitch)) - this.lagPitch) * k;

    // Kick: a spring that snaps back.
    this.kick -= this.kick * Math.min(1, dt * 16);
    const kick = this.kick * model.kick;

    // Reload: tilt the gun in, drop the magazine, bring a fresh one up.
    const r = reload ?? 0;
    const env = reload === null ? 0 : smooth(clamp01(Math.min(r / 0.15, (1 - r) / 0.15)));

    const [hx, hy, hz] = model.hold;
    this.root.position.set(
      hx + bobX + swayX + this.lagYaw * 0.35 + kick * 0.004 * this.kickSide,
      hy + bobY + swayY - lowered * 0.3 - env * 0.05 - this.lagPitch * 0.25,
      hz + kick * 0.05,
    );
    this.root.rotation.set(
      kick * 0.09 - lowered * 0.7 + env * 0.18 + this.lagPitch * 0.6,
      // Toed in a touch, so the barrel points at the crosshair rather than
      // parallel to it.
      0.05 + this.lagYaw * 0.8 + env * 0.15,
      env * 0.55 + bobX * 2,
    );

    // The magazine.
    const mag = this.mags[this.shownWeapon];
    let leftHand: V3 = model.support;
    let pumpBack = 0;
    if (mag) {
      let drop = 0;
      if (reload !== null) {
        if (r < 0.2) drop = 0;
        else if (r < 0.45) drop = smooth((r - 0.2) / 0.25) * 0.4;
        else if (r < 0.55) drop = 0.4;
        else if (r < 0.8) drop = (1 - smooth((r - 0.55) / 0.25)) * 0.4;
      }
      mag.position.set(0, -drop, drop * 0.2);
      mag.visible = !(r >= 0.45 && r < 0.55);
      if (reload !== null && r >= 0.15 && r < 0.85) {
        // The hand goes to the magazine well, follows the new one in.
        const m0 = model.mag[0];
        const reach = smooth(clamp01(Math.min((r - 0.15) / 0.1, (0.85 - r) / 0.1)));
        const target: V3 = [m0.x - 0.02, m0.y - 0.06 - drop, m0.z + drop * 0.2];
        leftHand = [
          leftHand[0] + (target[0] - leftHand[0]) * reach,
          leftHand[1] + (target[1] - leftHand[1]) * reach,
          leftHand[2] + (target[2] - leftHand[2]) * reach,
        ];
      }
    } else if (reload !== null) {
      // Shotgun: shells in one at a time, the pump racked at the end.
      const feeding = r > 0.12 && r < 0.78;
      if (feeding) {
        const s = Math.abs(Math.sin(((r - 0.12) / 0.66) * Math.PI * 5));
        leftHand = [0.03, -0.08 + s * 0.04, -0.05 - s * 0.03];
      }
      if (r > 0.82) pumpBack = Math.sin(((r - 0.82) / 0.18) * Math.PI) * 0.09;
    }
    if (this.shownWeapon === W_SHOTGUN && this.kick > 0.25) {
      pumpBack = Math.max(pumpBack, Math.sin(Math.min(1, (1.6 - this.kick) / 1.2) * Math.PI) * 0.08);
    }

    const hand = this.hands[this.shownWeapon];
    hand.position.set(leftHand[0], leftHand[1], leftHand[2] + pumpBack);
    hand.rotation.set(0, 0, 0);

    // Forearm from the elbow to the back of the left hand.
    const fx = hand.position.x - 0.01;
    const fy = hand.position.y - 0.02;
    const fz = hand.position.z + 0.04;
    const [ex, ey, ez] = LEFT_ELBOW;
    const len = Math.hypot(fx - ex, fy - ey, fz - ez);
    this.forearm.position.set(ex, ey, ez);
    this.forearm.scale.set(1, 1, len);
    this.forearm.rotation.order = "YXZ";
    this.forearm.rotation.set(-Math.asin((fy - ey) / len), Math.atan2(fx - ex, fz - ez), 0);

    // The hands are children of the root, but the gun is offset by the same
    // root, so a hand placed in model space stays on the gun.
    this.flashFor -= dt;
    this.flash.visible = this.flashFor > 0;
    this.flash.position.set(model.muzzle[0], model.muzzle[1], model.muzzle[2]);
  }
}

/**
 * Multiply the colour of every vertex whose texture coordinate falls inside
 * the cloth tile. That is the sleeves and nothing else.
 */
function recolour(mesh: THREE.Mesh, colour: number): void {
  const g = mesh.geometry;
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  const col = g.getAttribute("color") as THREE.BufferAttribute;
  const c = new THREE.Color(colour);
  const [u0, v0, u1, v1] = clothUV;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i);
    const v = uv.getY(i);
    if (u < u0 - 1e-6 || u > u1 + 1e-6 || v < v0 - 1e-6 || v > v1 + 1e-6) continue;
    col.setXYZ(i, col.getX(i) * c.r, col.getY(i) * c.g, col.getZ(i) * c.b);
  }
  col.needsUpdate = true;
}
