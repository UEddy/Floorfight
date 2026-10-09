import * as THREE from "three";
import { HEAD_BOTTOM, HEAD_TOP, YAW_UNITS } from "../../shared/sim";
import { W_PISTOL, W_RIFLE, W_SHOTGUN } from "../../shared/weapons";
import { buildParts, type Part } from "./boxes";
import type { RemoteView } from "./netcode";
import { T, atlas } from "./textures";
import type { RosterEntry } from "../../shared/protocol";
import { probe } from "./lighting";
import { SKR_TIERS, cleanTier } from "../../shared/skr";

/**
 * Other players: blocky characters with a look of their own and a procedural
 * rig that moves like a body rather than a pair of scissors.
 *
 * Looks. A holder whose NFT the server verified at join becomes that NFT: the
 * art on the front of the head, its own colours carried round the sides, back
 * and top, and the body dressed in colours taken from the art. Everyone else
 * gets one of six original characters, each with its own head, outfit and
 * silhouette. None of the six is anybody's collection: holders bring their
 * own art, and the game ships only what it drew itself.
 *
 * Draw calls. Every part is an instanced mesh with one instance per seat
 * (two for limbs), and every head samples one canvas atlas with four cells
 * per seat (front, side, back, top), so six players or sixty cost the same
 * fifteen calls, whatever mix of NFTs is in the match.
 *
 * Honesty. The sim's boxes are axis aligned and do not turn, while a body
 * does, so the body and head are kept inside the circle their hitbox square
 * contains: drawn at any facing they are inside the box the server tests.
 * What reaches outside is forearms, the gun, a hat brim, a tail: things a
 * shot at would miss, the way it would miss a real gun barrel.
 *
 * Movement. There is no animation library here on purpose. Skeletal
 * animation (three.js AnimationMixer and the like) needs rigged, licensed
 * models and gives up the instancing; what moves these is a small rig worked
 * out from the drawn velocity every frame: two part legs whose stride
 * follows the direction of travel relative to the body (so a strafe steps
 * sideways and a backpedal steps back), knees that fold on the swing,
 * cadence that rises with speed, the hips dropping twice a stride, a torso
 * that leans into acceleration and twists against the legs, a tuck in the
 * air and a crouch on landing, a shuffle when turning on the spot, breath
 * when standing, a kick through the arms when they fire and a flinch away
 * from a hit. It is cosmetic only: the sim never reads any of it.
 */

/* ---------------------------------------------------------------- looks --- */

export type HatKind = "none" | "cap" | "fedora" | "beanie";

export interface Look {
  shirt: number;
  trousers: number;
  /** Shoes, hands and anything that is skin rather than cloth. */
  skin: number;
  hat: HatKind;
  hatColour: number;
  tail: number | null;
  spikes: number | null;
  /** A coat to the knee, in this colour. */
  coat: number | null;
  flames: boolean;
}

/** The built in characters, one per seat in roster order. */
interface Builtin extends Look {
  name: string;
  /** Draw the four 16 pixel head faces: front, side, back, top. */
  paint: (f: Painter) => void;
}

/** A 16 by 16 pixel brush for one head face. */
interface Painter {
  face: "front" | "side" | "back" | "top";
  fill(c: string): void;
  px(x: number, y: number, c: string): void;
  rect(x: number, y: number, w: number, h: number, c: string): void;
  speckle(c: string, n: number, seed: number): void;
}

const BUILTINS: readonly Builtin[] = [
  {
    // A dinosaur suit: green scales, a ridge down the back, a tail.
    name: "Rex",
    shirt: 0x4fae4a, trousers: 0x3f8f3c, skin: 0x2f6e2d, hat: "none", hatColour: 0,
    tail: 0x4fae4a, spikes: 0xf2c94c, coat: null, flames: false,
    paint(f) {
      f.fill("#55b54f");
      f.speckle("#3f8f3c", 22, 1);
      if (f.face === "front") {
        f.rect(2, 3, 5, 5, "#ffffff"); f.rect(9, 3, 5, 5, "#ffffff");
        f.rect(4, 5, 2, 2, "#141414"); f.rect(11, 5, 2, 2, "#141414");
        f.rect(2, 2, 5, 1, "#2f6e2d"); f.rect(9, 2, 5, 1, "#2f6e2d");
        f.px(6, 10, "#1e4a1d"); f.px(9, 10, "#1e4a1d");
        f.rect(2, 12, 12, 2, "#1e4a1d");
        for (const x of [3, 6, 9, 12]) f.px(x, 12, "#ffffff");
      }
      if (f.face === "back" || f.face === "top") f.rect(7, 0, 2, 16, "#f2c94c");
    },
  },
  {
    // A detective: a fedora pulled low, a trench coat.
    name: "Noir",
    shirt: 0x8a6e45, trousers: 0x2f3138, skin: 0x1f1c1a, hat: "fedora", hatColour: 0x2d4a52,
    tail: null, spikes: null, coat: 0x8a6e45, flames: false,
    paint(f) {
      f.fill("#c08e6a");
      if (f.face === "front") {
        f.rect(0, 0, 16, 5, "#6e4f3a");
        f.rect(3, 6, 3, 2, "#ffffff"); f.rect(10, 6, 3, 2, "#ffffff");
        f.rect(4, 6, 2, 2, "#3a8f6a"); f.rect(11, 6, 2, 2, "#3a8f6a");
        f.rect(7, 8, 2, 3, "#a7765a");
        f.rect(5, 12, 6, 1, "#5a3a2a"); f.px(11, 11, "#5a3a2a");
        f.speckle("#8a6450", 10, 2);
      } else if (f.face !== "top") {
        f.rect(0, 0, 16, 9, "#2a1d16");
      } else {
        f.fill("#2a1d16");
      }
    },
  },
  {
    // A skater: cap on, purple hoodie.
    name: "Kick",
    shirt: 0x7a3a9a, trousers: 0x3b5a8a, skin: 0x1d1d26, hat: "cap", hatColour: 0x4a86c0,
    tail: null, spikes: null, coat: null, flames: false,
    paint(f) {
      f.fill("#d9a87c");
      if (f.face === "front") {
        f.rect(0, 0, 16, 3, "#5a2a7a");
        f.rect(3, 6, 2, 3, "#1d1d26"); f.rect(11, 6, 2, 3, "#1d1d26");
        f.px(4, 6, "#ffffff"); f.px(12, 6, "#ffffff");
        f.rect(7, 9, 2, 2, "#c08e6a");
        f.rect(4, 12, 8, 1, "#1d1d26");
      } else if (f.face === "side") {
        f.rect(0, 0, 9, 10, "#5a2a7a"); f.rect(10, 5, 2, 3, "#c08e6a");
      } else {
        f.fill("#5a2a7a");
      }
    },
  },
  {
    // A skull on fire.
    name: "Ember",
    shirt: 0x26222a, trousers: 0x18161c, skin: 0x0e0c10, hat: "none", hatColour: 0,
    tail: null, spikes: null, coat: null, flames: true,
    paint(f) {
      f.fill("#2a2420");
      f.speckle("#ff7a2a", 14, 3);
      f.speckle("#ffd23a", 6, 4);
      if (f.face === "front") {
        f.rect(2, 4, 5, 4, "#000000"); f.rect(9, 4, 5, 4, "#000000");
        f.rect(3, 5, 3, 2, "#c46bff"); f.rect(10, 5, 3, 2, "#c46bff");
        f.rect(7, 9, 2, 2, "#000000");
        f.rect(3, 12, 10, 2, "#e8e2d0");
        for (const x of [4, 6, 8, 10, 12]) f.px(x, 12, "#2a2420");
      }
    },
  },
  {
    // A statue come down off its plinth: bronze gone green at the edges.
    name: "Bronze",
    shirt: 0x8a6a3a, trousers: 0x6e5530, skin: 0x4a7a6a, hat: "none", hatColour: 0,
    tail: null, spikes: null, coat: null, flames: false,
    paint(f) {
      f.fill("#a07a42");
      f.speckle("#5e9a86", 18, 5);
      f.speckle("#c99a58", 10, 6);
      if (f.face === "front") {
        f.rect(3, 6, 4, 1, "#4a3418"); f.rect(9, 6, 4, 1, "#4a3418");
        f.rect(7, 7, 2, 4, "#8a6436");
        f.rect(5, 12, 6, 1, "#4a3418");
      }
    },
  },
  {
    // A space visor.
    name: "Nova",
    shirt: 0xeceae4, trousers: 0x5a6070, skin: 0x2b2f3a, hat: "none", hatColour: 0,
    tail: null, spikes: null, coat: null, flames: false,
    paint(f) {
      f.fill("#eceae4");
      f.speckle("#c9c6be", 12, 7);
      if (f.face === "front") {
        f.rect(2, 3, 12, 9, "#1a2a4a");
        f.rect(3, 4, 4, 1, "#7ab8ff"); f.rect(3, 5, 2, 1, "#7ab8ff");
        f.rect(2, 13, 12, 1, "#ff7a2a");
      } else if (f.face === "top") {
        f.rect(7, 7, 2, 2, "#ff4d3d");
      }
    },
  },
];

/** The look a seat has before any NFT is applied. */
export function builtinLook(slot: number): Look {
  return BUILTINS[slot % BUILTINS.length];
}

/** Per seat colour scheme, for anything outside this file (the death burst). */
export interface Scheme { shirt: number; trousers: number; cap: number }

export function scheme(slot: number): Scheme {
  const l = builtinLook(slot);
  return { shirt: l.shirt, trousers: l.trousers, cap: l.hat !== "none" ? l.hatColour : l.skin };
}

/** Skin and hair, for the death burst. */
export const SKIN = 0xe8b08a;
export const HAIR = 0x3b2a20;

/** Seat colours, for the scarf: who is who at a glance. Same as render.ts. */
const SEAT = [0xff4d3d, 0x3da5ff, 0x4fe08a, 0xffd23a, 0xc46bff, 0x2fe0d6];

/* ----------------------------------------------------------- proportions --- */

/* In blocks, feet at 0. */
const HIP = 0.74;
const THIGH = 0.38;
const SHIN = HIP - THIGH;
const SHOULDER = 1.34;
const TORSO_W = 0.5;
const TORSO_D = 0.26;
const LEG_W = 0.2;
const ARM_W = 0.15;
const ARM_LEN = 0.56;
const HEAD_W = 0.42;
const HEAD_Y0 = HEAD_BOTTOM + 0.01;
const HEAD_H = HEAD_TOP - HEAD_Y0 - 0.02;

/** Pixels per head face cell, and cells per seat (front, side, back, top). */
const CELL_PX = 64;
const CELLS = 4;

/** Where the gun's grip sits relative to the right shoulder, arm raised. */
const GRIP_FORWARD = 0.5;

/** Blocks a full stride (two steps) covers at a run. Sets the cadence. */
const STRIDE = 2.3;

/** Third person guns, each with the two hands that hold it. Grip at origin. */
function gunParts(w: number): Part[] {
  const hand = (x: number, y: number, z: number): Part =>
    ({ x, y, z, w: 0.13, h: 0.13, d: 0.13, tile: T.SKIN });
  if (w === W_PISTOL) {
    return [
      { x: 0, y: 0.06, z: -0.1, w: 0.07, h: 0.08, d: 0.26, tile: T.GUNMETAL },
      { x: 0, y: -0.04, z: 0.0, w: 0.06, h: 0.13, d: 0.08, tile: T.GUNMETAL },
      hand(0.0, 0.0, 0.02), hand(-0.06, -0.03, 0.03),
    ];
  }
  if (w === W_SHOTGUN) {
    return [
      { x: 0, y: 0.04, z: -0.3, w: 0.08, h: 0.08, d: 0.8, tile: T.GUNMETAL },
      { x: 0, y: 0.0, z: -0.42, w: 0.1, h: 0.08, d: 0.2, tile: T.GUNWOOD },
      { x: 0, y: -0.02, z: 0.14, w: 0.08, h: 0.13, d: 0.3, tile: T.GUNWOOD },
      hand(0.0, -0.04, 0.0), hand(0.0, -0.02, -0.42),
    ];
  }
  return [
    { x: 0, y: 0.04, z: -0.22, w: 0.08, h: 0.12, d: 0.62, tile: T.GUNMETAL },
    { x: 0, y: 0.04, z: -0.34, w: 0.09, h: 0.1, d: 0.2, tile: T.ACCENT },
    { x: 0, y: -0.06, z: -0.16, w: 0.06, h: 0.16, d: 0.08, tile: T.GUNMETAL },
    { x: 0, y: 0.02, z: 0.16, w: 0.08, h: 0.12, d: 0.22, tile: T.POLYMER },
    hand(0.0, -0.04, 0.0), hand(0.0, -0.02, -0.34),
  ];
}

/* ------------------------------------------------------------------- rig --- */

/** Per seat motion state, all of it smoothed off the drawn positions. */
interface Rig {
  x: number; y: number; z: number; yaw: number;
  vx: number; vz: number;
  /** Speed as a fraction of a run, 0 to 1. */
  speed: number;
  phase: number;
  air: number;
  vy: number;
  /** Landing crouch, 1 just landed, decaying. */
  crouch: number;
  /** Lean, in radians, forward and to the side, sprung. */
  leanF: number; leanS: number;
  /** Arm kick from firing, and flinch from being hit (with its direction). */
  kick: number;
  flinch: number; flinchX: number; flinchZ: number;
  breath: number;
  seen: boolean;
}

function newRig(): Rig {
  return {
    x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0, speed: 0, phase: 0, air: 0, vy: 0, crouch: 0,
    leanF: 0, leanS: 0, kick: 0, flinch: 0, flinchX: 0, flinchZ: 0, breath: Math.random() * 6, seen: false,
  };
}

/** Exponential approach, frame rate independent. */
const approach = (from: number, to: number, rate: number, dt: number) =>
  from + (to - from) * (1 - Math.exp(-rate * dt));

export class Characters {
  private thighs: THREE.InstancedMesh;
  private shins: THREE.InstancedMesh;
  private torsos: THREE.InstancedMesh;
  private arms: THREE.InstancedMesh;
  private heads: THREE.InstancedMesh;
  private scarves: THREE.InstancedMesh;
  private caps: THREE.InstancedMesh;
  private fedoras: THREE.InstancedMesh;
  private beanies: THREE.InstancedMesh;
  private tails: THREE.InstancedMesh;
  private spikes: THREE.InstancedMesh;
  private coats: THREE.InstancedMesh;
  private flames: THREE.InstancedMesh;
  /** The SKR halo, over holders with a badge. */
  private halos: THREE.InstancedMesh;
  /** SKR badge tier per seat, from the server's roster. Cosmetic only. */
  private skrTiers: number[] = [];
  private guns: THREE.InstancedMesh[] = [];
  private all: THREE.InstancedMesh[] = [];
  private rigs: Rig[] = [];
  private looks: Look[] = [];

  /**
   * The heads' material. It samples a canvas with four cells per seat, and
   * a per vertex attribute says which of the four a face is, so a holder's
   * head can carry their art on the front and its colours on the rest.
   */
  readonly faceMaterial: THREE.MeshBasicMaterial;
  private faceCanvas: HTMLCanvasElement;
  private faceTexture: THREE.CanvasTexture;

  private m = new THREE.Matrix4();
  private t = new THREE.Matrix4();
  private base = new THREE.Matrix4();
  private torsoM = new THREE.Matrix4();
  private neck = new THREE.Matrix4();
  private hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  private c = new THREE.Color();

  constructor(scene: THREE.Scene, private slots: number) {
    const mat = new THREE.MeshBasicMaterial({ map: atlas(), vertexColors: true, fog: true });

    this.faceCanvas = document.createElement("canvas");
    this.faceCanvas.width = CELL_PX * CELLS * slots;
    this.faceCanvas.height = CELL_PX;
    this.faceTexture = new THREE.CanvasTexture(this.faceCanvas);
    this.faceTexture.colorSpace = THREE.SRGBColorSpace;
    this.faceTexture.magFilter = THREE.NearestFilter;
    this.faceTexture.minFilter = THREE.LinearMipmapLinearFilter;
    this.faceMaterial = new THREE.MeshBasicMaterial({ map: this.faceTexture, vertexColors: true, fog: true });
    this.faceMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.faceCells = { value: slots * CELLS };
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>
attribute float faceCell;
attribute float faceKind;
uniform float faceCells;`)
        .replace("#include <uv_vertex>", `#include <uv_vertex>
#ifdef USE_MAP
  vMapUv = vec2((faceCell * ${CELLS}.0 + faceKind + clamp(uv.x, 0.0, 1.0)) / faceCells, clamp(uv.y, 0.0, 1.0));
#endif`);
    };

    // Each part hangs from its pivot, so its instance matrix is the joint's.
    const box = (p: Part) => buildParts([p]).geometry;
    const thigh = box({ x: 0, y: -THIGH / 2, z: 0, w: LEG_W, h: THIGH, d: LEG_W + 0.02, tile: T.TROUSER, top: T.CLOTH });
    const shin = box({ x: 0, y: -SHIN / 2, z: -0.01, w: LEG_W - 0.01, h: SHIN, d: LEG_W + 0.03, tile: T.TROUSER, bottom: T.BOOT });
    const torso = box({ x: 0, y: (SHOULDER + 0.1 - HIP) / 2, z: 0, w: TORSO_W, h: SHOULDER + 0.1 - HIP, d: TORSO_D, tile: T.CLOTH });
    const arm = box({ x: 0, y: -ARM_LEN / 2 + 0.06, z: 0, w: ARM_W, h: ARM_LEN, d: ARM_W, tile: T.CLOTH });
    const head = headGeometry();
    const scarf = box({ x: 0, y: 0.04, z: 0, w: TORSO_W - 0.06, h: 0.08, d: TORSO_D + 0.04, tile: T.CLOTH });
    const capH = 0.12;
    const cap = buildParts([
      { x: 0, y: capH / 2, z: 0, w: HEAD_W + 0.04, h: capH, d: HEAD_W + 0.04, tile: T.CLOTH },
      { x: 0, y: 0.015, z: -HEAD_W / 2 - 0.09, w: HEAD_W * 0.8, h: 0.03, d: 0.18, tile: T.CLOTH },
    ]).geometry;
    const fedora = buildParts([
      { x: 0, y: 0.12, z: 0, w: HEAD_W - 0.02, h: 0.2, d: HEAD_W - 0.02, tile: T.CLOTH },
      { x: 0, y: 0.03, z: 0, w: HEAD_W + 0.26, h: 0.03, d: HEAD_W + 0.26, tile: T.CLOTH },
      { x: 0, y: 0.06, z: 0, w: HEAD_W + 0.0, h: 0.04, d: HEAD_W + 0.0, tile: T.ACCENT },
    ]).geometry;
    const beanie = box({ x: 0, y: 0.07, z: 0, w: HEAD_W + 0.03, h: 0.14, d: HEAD_W + 0.03, tile: T.CLOTH });
    // Tail from the small of the back, tapering, pointing back and down.
    const tail = buildParts([
      { x: 0, y: 0, z: 0.16, w: 0.22, h: 0.2, d: 0.32, tile: T.CLOTH, rx: 0.35 },
      { x: 0, y: -0.12, z: 0.42, w: 0.16, h: 0.15, d: 0.3, tile: T.CLOTH, rx: 0.45 },
      { x: 0, y: -0.24, z: 0.64, w: 0.1, h: 0.1, d: 0.24, tile: T.CLOTH, rx: 0.5 },
    ]).geometry;
    // A ridge down the back of the torso, on the torso's pivot.
    const ridge: Part[] = [];
    for (let i = 0; i < 4; i++) {
      const s = 0.12 - i * 0.015;
      ridge.push({ x: 0, y: 0.62 - i * 0.16, z: TORSO_D / 2 + s / 2.5, w: 0.04, h: s, d: s, tile: T.CLOTH, rx: 0.78 });
    }
    const spikes = buildParts(ridge).geometry;
    // A trench coat's skirt, from the waist to the knee, on the torso pivot.
    const coat = buildParts([
      { x: 0, y: -0.2, z: 0, w: TORSO_W + 0.06, h: 0.42, d: TORSO_D + 0.08, tile: T.CLOTH },
      { x: 0, y: 0.25, z: -TORSO_D / 2 - 0.02, w: 0.1, h: 0.4, d: 0.04, tile: T.ACCENT },
    ]).geometry;
    // Flames: a ring of thin blades round the crown, flickered per frame.
    const blades: Part[] = [];
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const r = 0.13;
      blades.push({ x: Math.sin(a) * r, y: 0.12 + (i % 2) * 0.05, z: Math.cos(a) * r, w: 0.08, h: 0.24 + (i % 3) * 0.06, d: 0.08, tile: T.LAMP, ry: a });
    }
    const flames = buildParts(blades).geometry;

    this.thighs = this.instanced(scene, thigh, mat, slots * 2);
    this.shins = this.instanced(scene, shin, mat, slots * 2);
    this.torsos = this.instanced(scene, torso, mat, slots);
    this.arms = this.instanced(scene, arm, mat, slots * 2);
    const cells = new Float32Array(slots);
    for (let i = 0; i < slots; i++) cells[i] = i;
    head.setAttribute("faceCell", new THREE.InstancedBufferAttribute(cells, 1));
    this.heads = this.instanced(scene, head, this.faceMaterial, slots);
    this.scarves = this.instanced(scene, scarf, mat, slots);
    this.caps = this.instanced(scene, cap, mat, slots);
    this.fedoras = this.instanced(scene, fedora, mat, slots);
    this.beanies = this.instanced(scene, beanie, mat, slots);
    this.tails = this.instanced(scene, tail, mat, slots);
    this.spikes = this.instanced(scene, spikes, mat, slots);
    this.coats = this.instanced(scene, coat, mat, slots);
    this.flames = this.instanced(scene, flames, mat, slots);
    // A halo of small blocks over the head, in the badge's colour.
    const ring: Part[] = [];
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      ring.push({ x: Math.sin(a) * 0.24, y: 0, z: Math.cos(a) * 0.24, w: 0.07, h: 0.04, d: 0.07, tile: T.LAMP, ry: a });
    }
    this.halos = this.instanced(scene, buildParts(ring).geometry, mat, slots);
    for (const w of [W_RIFLE, W_PISTOL, W_SHOTGUN]) {
      this.guns.push(this.instanced(scene, buildParts(gunParts(w)).geometry, mat, slots));
    }

    for (let i = 0; i < slots; i++) {
      this.rigs.push(newRig());
      this.looks.push({ ...builtinLook(i) });
      this.paintBuiltin(i);
      this.light(i, [1, 1, 1]);
    }
  }

  /* -------------------------------------------------------------- heads --- */

  private cellX(slot: number, kind: number): number {
    return (slot * CELLS + kind) * CELL_PX;
  }

  /** Paint a seat's four head cells from its built in character. */
  private paintBuiltin(slot: number): void {
    const b = BUILTINS[slot % BUILTINS.length];
    const ctx = this.faceCanvas.getContext("2d")!;
    const small = document.createElement("canvas");
    small.width = small.height = 16;
    const s = small.getContext("2d")!;
    (["front", "side", "back", "top"] as const).forEach((face, kind) => {
      s.clearRect(0, 0, 16, 16);
      b.paint({
        face,
        fill: (c) => { s.fillStyle = c; s.fillRect(0, 0, 16, 16); },
        px: (x, y, c) => { s.fillStyle = c; s.fillRect(x, y, 1, 1); },
        rect: (x, y, w, h, c) => { s.fillStyle = c; s.fillRect(x, y, w, h); },
        speckle: (c, n, seed) => {
          s.fillStyle = c;
          let h = (seed * 2654435761 + kind * 40503) >>> 0;
          for (let i = 0; i < n; i++) {
            h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
            s.fillRect(h & 15, (h >>> 8) & 15, 1, 1);
          }
        },
      });
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(small, 0, 0, 16, 16, this.cellX(slot, kind), 0, CELL_PX, CELL_PX);
    });
    this.faceTexture.needsUpdate = true;
  }

  /**
   * Looks from the roster. A seat whose roster entry carries a mint is one
   * the server verified at join; its image comes from this page's own origin
   * (/api/nft-img), which is what lets WebGL use it and lets this read its
   * pixels for the colours. Anything that fails to load keeps the built in
   * character.
   */
  setFaces(roster: readonly RosterEntry[]): void {
    for (const r of roster) {
      if (r.slot < 0 || r.slot >= this.slots) continue;
      this.looks[r.slot] = { ...builtinLook(r.slot) };
      this.skrTiers[r.slot] = cleanTier(r.skr);
      this.paintBuiltin(r.slot);
      if (!r.mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.mint)) continue;
      const img = new Image();
      img.decoding = "async";
      img.onload = () => this.wearNft(r.slot, img);
      img.src = `/api/nft-img/${r.mint}`;
    }
  }

  /**
   * Dress a seat as its NFT. The art goes on the front of the head, centre
   * cropped to a square. The sides and back take the colour round the art's
   * edge, which for a profile picture is its background, and the top takes
   * the top edge's, so the head reads as that picture from any side. The
   * body takes the art's own colours: the strongest colour in its lower
   * half for the shirt, a darker one for the trousers.
   */
  private wearNft(slot: number, img: HTMLImageElement): void {
    const ctx = this.faceCanvas.getContext("2d")!;
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = (img.naturalWidth - side) / 2;
    const sy = (img.naturalHeight - side) / 2;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, sx, sy, side, side, this.cellX(slot, 0), 0, CELL_PX, CELL_PX);

    const pal = palette(img, sx, sy, side);
    if (!pal) {
      this.faceTexture.needsUpdate = true;
      return;
    }
    const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
    const shade = (c: number, k: number) => {
      this.c.set(c);
      return this.c.setRGB(this.c.r * k, this.c.g * k, this.c.b * k).getHex();
    };
    const fillCell = (kind: number, colour: number) => {
      ctx.fillStyle = hex(colour);
      ctx.fillRect(this.cellX(slot, kind), 0, CELL_PX, CELL_PX);
      // A little of the art's grain, so a flat side does not look painted on.
      ctx.globalAlpha = 0.12;
      ctx.drawImage(img, sx, sy, side, side, this.cellX(slot, kind), 0, CELL_PX, CELL_PX);
      ctx.globalAlpha = 1;
    };
    fillCell(1, pal.edge);
    fillCell(2, shade(pal.edge, 0.85));
    fillCell(3, pal.top);
    this.faceTexture.needsUpdate = true;

    this.looks[slot] = {
      shirt: pal.main, trousers: shade(pal.main, 0.55), skin: shade(pal.edge, 0.5),
      hat: "none", hatColour: 0, tail: null, spikes: null, coat: null, flames: false,
    };
  }

  /* ----------------------------------------------------------- instancing --- */

  private instanced(
    scene: THREE.Scene, g: THREE.BufferGeometry, m: THREE.Material, n: number,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(g, m, n);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    for (let i = 0; i < n; i++) {
      mesh.setMatrixAt(i, this.hidden);
      mesh.setColorAt(i, this.c.set(0xffffff));
    }
    scene.add(mesh);
    this.all.push(mesh);
    return mesh;
  }

  private hide(i: number): void {
    for (const mesh of this.all) {
      const per = mesh.count / this.slots;
      for (let k = 0; k < per; k++) mesh.setMatrixAt(i * per + k, this.hidden);
    }
  }

  /* --------------------------------------------------------------- events --- */

  /** A seat fired: the shot goes back through their arms. */
  fired(slot: number): void {
    const r = this.rigs[slot];
    if (r) r.kick = 1;
  }

  /** A seat was hit from (fromX, fromZ): they flinch away from it. */
  hit(slot: number, fromX: number, fromZ: number): void {
    const r = this.rigs[slot];
    if (!r) return;
    const dx = r.x - fromX;
    const dz = r.z - fromZ;
    const d = Math.hypot(dx, dz) || 1;
    r.flinch = 1;
    r.flinchX = dx / d;
    r.flinchZ = dz / d;
  }

  /** World position of a seat's muzzle, for the remote flash. */
  muzzle(r: RemoteView, out: THREE.Vector3): THREE.Vector3 {
    const yaw = (r.yaw / YAW_UNITS) * Math.PI * 2;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const reach = GRIP_FORWARD + (r.weapon === W_PISTOL ? 0.25 : 0.6);
    return out.set(
      r.x + fx * reach - fz * 0.12,
      r.y + SHOULDER - 0.12 + Math.sin(r.pitch) * reach,
      r.z + fz * reach + fx * 0.12,
    );
  }

  /* --------------------------------------------------------------- frame --- */

  update(dt: number, remotes: Map<number, RemoteView>, localSlot: number): void {
    for (let i = 0; i < this.slots; i++) {
      const r = remotes.get(i);
      const g = this.rigs[i];
      if (i === localSlot || !r || !r.alive) {
        this.hide(i);
        if (r) { g.x = r.x; g.y = r.y; g.z = r.z; g.seen = false; }
        continue;
      }
      this.pose(i, r, g, dt);
    }
    for (const mesh of this.all) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  private pose(i: number, r: RemoteView, g: Rig, dt: number): void {
    const look = this.looks[i];
    const yaw = (r.yaw / YAW_UNITS) * Math.PI * 2;

    /* Velocity off the drawn positions, which is what the eye sees. */
    if (!g.seen || dt <= 0) {
      g.x = r.x; g.y = r.y; g.z = r.z; g.yaw = yaw; g.seen = true;
    }
    let vx = 0, vz = 0, vy = 0;
    if (dt > 0) {
      vx = (r.x - g.x) / dt;
      vz = (r.z - g.z) / dt;
      vy = (r.y - g.y) / dt;
      // A respawn or a correction is a jump of blocks in a frame: no motion.
      if (Math.hypot(vx, vz) > 30) { vx = 0; vz = 0; vy = 0; }
    }
    const prevVx = g.vx, prevVz = g.vz;
    g.vx = approach(g.vx, vx, 14, dt);
    g.vz = approach(g.vz, vz, 14, dt);
    let turn = yaw - g.yaw;
    turn = Math.atan2(Math.sin(turn), Math.cos(turn));
    g.x = r.x; g.y = r.y; g.z = r.z; g.yaw = yaw;

    // In the body's frame: forward is -z at yaw 0, right is +x.
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const fwd = g.vx * fx + g.vz * fz;
    const sidev = g.vx * rx + g.vz * rz;
    const ground = Math.hypot(g.vx, g.vz);
    g.speed = Math.min(1, ground / 7.4);
    const accF = dt > 0 ? ((g.vx - prevVx) * fx + (g.vz - prevVz) * fz) / dt : 0;

    // Air, and the landing that ends it.
    g.vy = approach(g.vy, vy, 20, dt);
    const inAir = Math.abs(g.vy) > 0.6 ? 1 : 0;
    if (g.air > 0.6 && inAir === 0) g.crouch = Math.min(1, 0.4 + Math.abs(g.vy) * 0.05 + g.air * 0.5);
    g.air = approach(g.air, inAir, 14, dt);
    g.crouch = approach(g.crouch, 0, 7, dt);

    // Cadence rises with speed; turning on the spot shuffles the feet.
    const shuffle = Math.min(1, Math.abs(turn) / Math.max(dt, 1e-3) / 6) * (1 - g.speed);
    const stepRate = (ground / STRIDE) * Math.PI * 2 + shuffle * 9;
    g.phase += stepRate * dt;
    g.breath += dt * 1.6;
    g.kick = approach(g.kick, 0, 12, dt);
    g.flinch = approach(g.flinch, 0, 8, dt);

    /* Springs: lean into acceleration and travel, and into a strafe. */
    const leanFTarget = Math.max(-0.25, Math.min(0.25, -0.12 * (fwd / 7.4) - 0.012 * accF));
    const leanSTarget = -0.08 * (sidev / 7.4);
    g.leanF = approach(g.leanF, leanFTarget, 8, dt);
    g.leanS = approach(g.leanS, leanSTarget, 8, dt);

    // Flinch, in the body's frame: thrown back from where the shot came.
    const flF = -(g.flinchX * fx + g.flinchZ * fz) * g.flinch;
    const flS = (g.flinchX * rx + g.flinchZ * rz) * g.flinch;

    /* Hips: drop twice a stride and in a landing crouch. */
    const moveFrac = Math.min(1, ground / 2) * (1 - g.air);
    const hipDrop = Math.abs(Math.sin(g.phase)) * 0.055 * g.speed * (1 - g.air) + g.crouch * 0.14;
    const breathe = Math.sin(g.breath) * 0.008 * (1 - moveFrac);

    this.base.makeRotationY(yaw).setPosition(r.x, r.y - hipDrop * 0.35, r.z);
    this.light(i, probe(r.x, r.y + 1, r.z));

    /* Legs. Direction of swing follows travel in the body's frame. */
    const dirF = ground > 0.3 ? fwd / ground : 0;
    const dirS = ground > 0.3 ? sidev / ground : 0;
    const amp = (0.35 + 0.45 * g.speed) * moveFrac + shuffle * 0.25;
    for (const side of [0, 1]) {
      const ph = g.phase + (side === 0 ? 0 : Math.PI);
      const sx = side === 0 ? -0.12 : 0.12;
      const swing = Math.sin(ph) * amp;
      // Knee folds while the leg swings through, most at mid swing.
      let knee = -Math.max(0, Math.cos(ph)) * (0.25 + 0.9 * g.speed) * moveFrac;
      let thighF = swing * (dirF + (shuffle > 0 && ground < 0.3 ? 0.3 : 0));
      let thighS = swing * dirS * 0.6 + (side === 0 ? -0.04 : 0.04);
      // In the air: a tuck going up, legs reaching down coming in.
      const rising = g.vy > 0 ? 1 : 0;
      const airThigh = rising ? (side === 0 ? 0.7 : 0.25) : (side === 0 ? 0.35 : -0.1);
      const airKnee = rising ? (side === 0 ? -1.2 : -0.5) : -0.35;
      thighF = thighF * (1 - g.air) + airThigh * g.air;
      knee = knee * (1 - g.air) + airKnee * g.air;
      // The landing crouch folds both knees and pushes the thighs forward.
      thighF += g.crouch * 0.45;
      knee -= g.crouch * 0.9;
      thighS *= 1 - g.air;

      this.m.copy(this.base)
        .multiply(this.t.makeTranslation(sx, HIP - hipDrop, 0))
        .multiply(this.t.makeRotationZ(thighS))
        .multiply(this.t.makeRotationX(thighF));
      this.thighs.setMatrixAt(i * 2 + side, this.m);
      this.m.multiply(this.t.makeTranslation(0, -THIGH, 0)).multiply(this.t.makeRotationX(knee));
      this.shins.setMatrixAt(i * 2 + side, this.m);
    }

    /* Torso: lean, twist against the legs, breath, flinch. */
    const twist = Math.sin(g.phase) * 0.12 * g.speed * (1 - g.air) * Math.abs(dirF);
    this.torsoM.copy(this.base)
      .multiply(this.t.makeTranslation(0, HIP - hipDrop, 0))
      .multiply(this.t.makeRotationY(twist))
      .multiply(this.t.makeRotationZ(g.leanS + flS * 0.35))
      .multiply(this.t.makeRotationX(g.leanF + flF * 0.4 - g.crouch * 0.15))
      .multiply(this.t.makeScale(1, 1 + breathe, 1));
    this.torsos.setMatrixAt(i, this.torsoM);
    const shoulderY = SHOULDER - HIP;

    // Pitch is aim, after the lean, so the gun stays on what they look at.
    const pitch = Math.max(-0.9, Math.min(0.9, r.pitch)) - (g.leanF + flF * 0.4);
    const kickBack = g.kick * (r.weapon === W_SHOTGUN ? 0.5 : r.weapon === W_PISTOL ? 0.35 : 0.22);
    const raise = 1.3 + pitch + kickBack;
    const arm = (index: number, x: number, ax: number, ay: number) => {
      this.m.copy(this.torsoM)
        .multiply(this.t.makeTranslation(x, shoulderY, kickBack * 0.15))
        .multiply(this.t.makeRotationY(ay))
        .multiply(this.t.makeRotationX(ax));
      this.arms.setMatrixAt(index, this.m);
    };
    arm(i * 2, TORSO_W / 2 + ARM_W / 2, raise, 0.12);
    arm(i * 2 + 1, -TORSO_W / 2 - ARM_W / 2, raise + 0.15, -0.55);

    for (let w = 0; w < this.guns.length; w++) {
      if (w !== r.weapon) { this.guns[w].setMatrixAt(i, this.hidden); continue; }
      const reach = Math.sin(raise) * (ARM_LEN - 0.06);
      const drop = Math.cos(raise) * (ARM_LEN - 0.06);
      this.m.copy(this.torsoM)
        .multiply(this.t.makeTranslation(0.13, shoulderY - drop, -reach + kickBack * 0.15))
        .multiply(this.t.makeRotationX(pitch + kickBack * 0.6));
      this.guns[w].setMatrixAt(i, this.m);
    }

    /* Neck and head: the head carries half the aim and settles the lean. */
    const neck = this.neck.copy(this.torsoM).multiply(this.t.makeTranslation(0, HEAD_Y0 - HIP, 0));
    this.scarves.setMatrixAt(i, this.m.copy(neck).multiply(this.t.makeTranslation(0, -0.07, 0)));
    const headM = neck.multiply(this.t.makeRotationX(pitch * 0.5 - (g.leanF + flF * 0.4) * 0.5));
    this.heads.setMatrixAt(i, headM);
    const hatAt = (mesh: THREE.InstancedMesh, on: boolean) => {
      mesh.setMatrixAt(i, on ? this.m.copy(headM).multiply(this.t.makeTranslation(0, HEAD_H, 0)) : this.hidden);
    };
    hatAt(this.caps, look.hat === "cap");
    hatAt(this.fedoras, look.hat === "fedora");
    hatAt(this.beanies, look.hat === "beanie");
    const tier = this.skrTiers[i] ?? 0;
    if (tier > 0) {
      this.halos.setMatrixAt(i, this.m.copy(headM)
        .multiply(this.t.makeTranslation(0, HEAD_H + 0.34 + Math.sin(g.breath * 1.3) * 0.02, 0))
        .multiply(this.t.makeRotationY(g.breath * 0.9)));
      const c = SKR_TIERS[tier - 1].colour;
      this.halos.setColorAt(i, this.c.setRGB(((c >> 16) & 255) / 170, ((c >> 8) & 255) / 170, (c & 255) / 170));
    } else {
      this.halos.setMatrixAt(i, this.hidden);
    }
    if (look.flames) {
      const flick = 1 + Math.sin(g.breath * 7 + i) * 0.15 + Math.sin(g.breath * 13.3) * 0.08;
      this.flames.setMatrixAt(i, this.m.copy(headM)
        .multiply(this.t.makeTranslation(0, HEAD_H - 0.06, 0))
        .multiply(this.t.makeScale(1, flick + g.speed * 0.25, 1)));
    } else {
      this.flames.setMatrixAt(i, this.hidden);
    }

    /* The extras. */
    this.spikes.setMatrixAt(i, look.spikes !== null ? this.torsoM : this.hidden);
    if (look.coat !== null) {
      // The coat skirt swings a little behind the legs and flares in a run.
      const flare = -0.1 * g.speed * Math.abs(dirF) - g.air * 0.15;
      this.coats.setMatrixAt(i, this.m.copy(this.torsoM).multiply(this.t.makeRotationX(-flare)));
    } else {
      this.coats.setMatrixAt(i, this.hidden);
    }
    if (look.tail !== null) {
      const sway = Math.sin(g.phase * 0.5 + 0.6) * (0.15 + 0.25 * g.speed) + Math.sin(g.breath) * 0.05;
      this.tails.setMatrixAt(i, this.m.copy(this.base)
        .multiply(this.t.makeTranslation(0, HIP - hipDrop + 0.05, TORSO_D / 2))
        .multiply(this.t.makeRotationY(sway))
        .multiply(this.t.makeRotationX(-0.1 * g.speed + g.air * 0.3)));
    } else {
      this.tails.setMatrixAt(i, this.hidden);
    }
  }

  /**
   * Light the seat's parts the way the hall around them is lit: the baked
   * sky and lantern light at the cell they stand in, multiplied over their
   * colours. A player walking under a lantern warms up, and one in the shade
   * of a gallery goes dark, which keeps the bodies from glowing flat against
   * a lit hall.
   */
  private light(i: number, l: readonly [number, number, number]): void {
    const look = this.looks[i];
    const lit = (hex: number, k = 1.15) => {
      this.c.set(hex);
      return this.c.setRGB(this.c.r * l[0] * k, this.c.g * l[1] * k, this.c.b * l[2] * k);
    };
    this.torsos.setColorAt(i, lit(look.shirt));
    this.arms.setColorAt(i * 2, lit(look.shirt));
    this.arms.setColorAt(i * 2 + 1, lit(look.shirt));
    for (const k of [0, 1]) {
      this.thighs.setColorAt(i * 2 + k, lit(look.trousers));
      this.shins.setColorAt(i * 2 + k, lit(look.trousers));
    }
    this.heads.setColorAt(i, lit(0xffffff));
    this.scarves.setColorAt(i, lit(SEAT[i % SEAT.length]));
    for (const hat of [this.caps, this.fedoras, this.beanies]) hat.setColorAt(i, lit(look.hatColour));
    this.tails.setColorAt(i, lit(look.tail ?? 0xffffff));
    this.spikes.setColorAt(i, lit(look.spikes ?? 0xffffff));
    this.coats.setColorAt(i, lit(look.coat ?? 0xffffff));
    // Fire is its own light.
    this.flames.setColorAt(i, this.c.setRGB(1.6, 0.75, 0.25));
    for (const gun of this.guns) gun.setColorAt(i, lit(0xffffff));
  }
}

/**
 * A head: one box, every face sampling the seat's cells in the face canvas.
 * Built by buildParts for its shading and winding, then given plain 0 to 1
 * texture coordinates per face and a `faceKind` saying which cell each face
 * reads: 0 front (-z), 1 sides, 2 back (+z), 3 top and bottom.
 */
function headGeometry(): THREE.BufferGeometry {
  const g = buildParts([{
    x: 0, y: HEAD_H / 2, z: 0, w: HEAD_W, h: HEAD_H, d: HEAD_W, tile: T.SKIN,
  }]).geometry;
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  const quad = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const kinds = [1, 1, 3, 3, 2, 0]; // +x -x +y -y +z -z
  const kind = new Float32Array(24);
  for (let f = 0; f < 6; f++) {
    for (let k = 0; k < 4; k++) {
      uv.setXY(f * 4 + k, quad[k][0], quad[k][1]);
      kind[f * 4 + k] = kinds[f];
    }
  }
  uv.needsUpdate = true;
  g.setAttribute("faceKind", new THREE.Float32BufferAttribute(kind, 1));
  return g;
}

/**
 * The colours of a picture, for dressing a body in it: the average round
 * its edge (a profile picture's background), along its top edge, and the
 * strongest colour in its lower middle, which is usually what the character
 * is wearing. Read off a 24 pixel copy, so it costs nothing.
 */
function palette(img: HTMLImageElement, sx: number, sy: number, side: number):
  { edge: number; top: number; main: number } | null {
  const n = 24;
  const cv = document.createElement("canvas");
  cv.width = cv.height = n;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, sx, sy, side, side, 0, 0, n, n);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, n, n).data;
  } catch {
    return null;
  }
  const at = (x: number, y: number) => {
    const i = (y * n + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const avg = (cells: [number, number][]) => {
    let r = 0, g = 0, b = 0;
    for (const [x, y] of cells) { const p = at(x, y); r += p[0]; g += p[1]; b += p[2]; }
    const k = cells.length || 1;
    return (Math.round(r / k) << 16) | (Math.round(g / k) << 8) | Math.round(b / k);
  };
  const edge: [number, number][] = [];
  const top: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    edge.push([i, 0], [0, i], [n - 1, i]);
    top.push([i, 0]);
  }
  // The strongest colour low in the middle: score by saturation and by
  // distance from the background, so a shirt beats the wall behind it.
  const bg = at(0, 0);
  let best: number[] | null = null;
  let bestScore = -1;
  for (let y = Math.floor(n * 0.62); y < n; y++) {
    for (let x = Math.floor(n * 0.2); x < Math.ceil(n * 0.8); x++) {
      const p = at(x, y);
      const mx = Math.max(p[0], p[1], p[2]);
      const mn = Math.min(p[0], p[1], p[2]);
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      const away = Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]);
      const score = sat * 0.6 + (away / 765) * 1.2 + (mx / 255) * 0.2;
      if (score > bestScore) { bestScore = score; best = p; }
    }
  }
  const main = best ? (best[0] << 16) | (best[1] << 8) | best[2] : avg(edge);
  return { edge: avg(edge), top: avg(top), main };
}
