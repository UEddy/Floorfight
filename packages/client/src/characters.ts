import * as THREE from "three";
import { HEAD_BOTTOM, HEAD_TOP, YAW_UNITS } from "../../shared/sim";
import { W_PISTOL, W_RIFLE, W_SHOTGUN } from "../../shared/weapons";
import { buildParts, type Part } from "./boxes";
import type { RemoteView } from "./netcode";
import { ATLAS_H, ATLAS_W, T, atlas, atlasImage, tileUV } from "./textures";
import type { RosterEntry } from "../../shared/protocol";
import { probe } from "./lighting";

/**
 * Other players, as blocky people: head, torso, two arms, two legs and the
 * gun they are holding.
 *
 * Every part is an instanced mesh with one instance per seat (two for arms
 * and legs), so six players or sixty cost the same nine draw calls. The
 * light is baked into the vertex colours like everything else in the hall.
 *
 * The silhouette is sized to the sim's hitbox. The sim's boxes are axis
 * aligned and do not turn, while a person does, so the body here is kept
 * inside the circle the hitbox square contains: a body drawn at any facing
 * is inside the box the server tests. The head is sized the same way against
 * the head box. What reaches outside is the forearms and the gun, by about a
 * hand's width, which is what holding a gun in front of you looks like. A
 * shot at a gun barrel is a shot at a gun barrel, and misses.
 */

/** Per seat colour scheme: shirt, trousers and cap. */
export interface Scheme { shirt: number; trousers: number; cap: number }

export const SCHEMES: readonly Scheme[] = [
  { shirt: 0xff4d3d, trousers: 0x2b3550, cap: 0xf4f1ea },
  { shirt: 0x3da5ff, trousers: 0x4a3426, cap: 0xffc426 },
  { shirt: 0x4fe08a, trousers: 0x2a2a30, cap: 0xff7a2a },
  { shirt: 0xffd23a, trousers: 0x4a3a6a, cap: 0x2b3550 },
  { shirt: 0xc46bff, trousers: 0x2f4a3a, cap: 0xf4f1ea },
  { shirt: 0x2fe0d6, trousers: 0x5a2a2a, cap: 0xff4d8a },
];

export function scheme(slot: number): Scheme {
  return SCHEMES[slot % SCHEMES.length];
}

/** Skin and hair, for the death burst. */
export const SKIN = 0xe8b08a;
export const HAIR = 0x3b2a20;

/* Proportions, in blocks. Feet at 0. */
const HIP = 0.72;
const SHOULDER = 1.34;
const TORSO_W = 0.5;
const TORSO_D = 0.26;
const LEG_W = 0.22;
const ARM_W = 0.15;
const ARM_LEN = 0.56;
const HEAD = 0.42;
const HEAD_Y0 = HEAD_BOTTOM + 0.02;
const CAP_H = HEAD_TOP - HEAD_Y0 - HEAD;

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

/** Pixels per face in the face atlas. */
const FACE_PX = 128;

/** Where the gun's grip sits relative to the right shoulder, arm raised. */
const GRIP_FORWARD = 0.5;

interface Walk { x: number; z: number; y: number; speed: number; phase: number; air: number }

export class Characters {
  private legs: THREE.InstancedMesh;
  private torsos: THREE.InstancedMesh;
  private arms: THREE.InstancedMesh;
  private heads: THREE.InstancedMesh;
  private caps: THREE.InstancedMesh;
  private guns: THREE.InstancedMesh[] = [];
  private walk: Walk[] = [];
  /**
   * The material the head's front face uses. It samples a face atlas with
   * one cell per seat: the default face, or the seat's verified NFT image.
   * A per instance attribute picks the cell, so every face is still one draw
   * call however many different NFTs are in the match.
   */
  readonly faceMaterial: THREE.MeshBasicMaterial;
  private faceCanvas: HTMLCanvasElement;
  private faceTexture: THREE.CanvasTexture;

  private m = new THREE.Matrix4();
  private base = new THREE.Matrix4();
  private part = new THREE.Matrix4();
  private rot = new THREE.Matrix4();
  private hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  private c = new THREE.Color();

  constructor(scene: THREE.Scene, private slots: number) {
    const mat = new THREE.MeshBasicMaterial({ map: atlas(), vertexColors: true, fog: true });
    this.faceCanvas = document.createElement("canvas");
    this.faceCanvas.width = FACE_PX * slots;
    this.faceCanvas.height = FACE_PX;
    this.faceTexture = new THREE.CanvasTexture(this.faceCanvas);
    this.faceTexture.colorSpace = THREE.SRGBColorSpace;
    this.faceTexture.magFilter = THREE.NearestFilter;
    this.faceTexture.minFilter = THREE.LinearMipmapLinearFilter;
    for (let i = 0; i < slots; i++) this.drawDefaultFace(i);
    this.faceMaterial = new THREE.MeshBasicMaterial({
      map: this.faceTexture, vertexColors: true, fog: true,
    });
    // The front face's texture coordinates point at the FACE tile in the
    // block atlas. Remap them into this seat's cell of the face atlas.
    const [u0, v0, u1, v1] = tileUV(T.FACE);
    this.faceMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.faceRect = { value: new THREE.Vector4(u0, v0, u1, v1) };
      shader.uniforms.faceCells = { value: slots };
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>
attribute float faceCell;
uniform vec4 faceRect;
uniform float faceCells;`)
        .replace("#include <uv_vertex>", `#include <uv_vertex>
#ifdef USE_MAP
  vMapUv = vec2(
    (faceCell + clamp((uv.x - faceRect.x) / (faceRect.z - faceRect.x), 0.0, 1.0)) / faceCells,
    clamp((uv.y - faceRect.y) / (faceRect.w - faceRect.y), 0.0, 1.0));
#endif`);
    };

    // Each part is built hanging from its pivot, so its instance matrix is a
    // translation to the joint and a rotation about it.
    const leg = buildParts([{
      x: 0, y: -HIP / 2, z: 0, w: LEG_W, h: HIP, d: LEG_W + 0.02,
      tile: T.TROUSER, top: T.CLOTH, bottom: T.BOOT,
    }]).geometry;
    const torso = buildParts([{
      x: 0, y: (SHOULDER + 0.1 - HIP) / 2, z: 0, w: TORSO_W, h: SHOULDER + 0.1 - HIP, d: TORSO_D,
      tile: T.CLOTH,
    }]).geometry;
    const arm = buildParts([{
      x: 0, y: -ARM_LEN / 2 + 0.06, z: 0, w: ARM_W, h: ARM_LEN, d: ARM_W, tile: T.CLOTH,
    }]).geometry;
    const head = buildParts([{
      x: 0, y: HEAD / 2, z: 0, w: HEAD, h: HEAD, d: HEAD,
      tile: T.HEAD_SIDE, top: T.HAIR, bottom: T.SKIN, front: T.FACE,
    }], true).geometry;
    // The back of the head is its own tile, so it reads as hair from behind.
    // buildParts only takes one side tile, so the +z face is patched here.
    setFaceTile(head, 4, T.HEAD_BACK);
    const cap = buildParts([
      { x: 0, y: CAP_H / 2, z: 0, w: HEAD + 0.04, h: CAP_H, d: HEAD + 0.04, tile: T.CLOTH },
      { x: 0, y: 0.015, z: -HEAD / 2 - 0.08, w: HEAD * 0.8, h: 0.03, d: 0.16, tile: T.CLOTH },
    ]).geometry;

    this.legs = this.instanced(scene, leg, mat, slots * 2);
    this.torsos = this.instanced(scene, torso, mat, slots);
    this.arms = this.instanced(scene, arm, mat, slots * 2);
    const cells = new Float32Array(slots);
    for (let i = 0; i < slots; i++) cells[i] = i;
    head.setAttribute("faceCell", new THREE.InstancedBufferAttribute(cells, 1));
    this.heads = this.instanced(scene, head, [mat, this.faceMaterial], slots);
    this.caps = this.instanced(scene, cap, mat, slots);
    for (const w of [W_RIFLE, W_PISTOL, W_SHOTGUN]) {
      this.guns.push(this.instanced(scene, buildParts(gunParts(w)).geometry, mat, slots));
    }

    const c = new THREE.Color();
    for (let i = 0; i < slots; i++) {
      const s = scheme(i);
      this.torsos.setColorAt(i, c.set(s.shirt));
      this.arms.setColorAt(i * 2, c.set(s.shirt));
      this.arms.setColorAt(i * 2 + 1, c.set(s.shirt));
      this.legs.setColorAt(i * 2, c.set(s.trousers));
      this.legs.setColorAt(i * 2 + 1, c.set(s.trousers));
      this.caps.setColorAt(i, c.set(s.cap));
      this.heads.setColorAt(i, c.set(0xffffff));
      for (const g of this.guns) g.setColorAt(i, c.set(0xffffff));
      this.walk.push({ x: 0, z: 0, y: 0, speed: 0, phase: 0, air: 0 });
    }
  }

  /** The default face, scaled up from the block atlas, into a seat's cell. */
  private drawDefaultFace(slot: number): void {
    const ctx = this.faceCanvas.getContext("2d")!;
    const [u0, v0, u1, v1] = tileUV(T.FACE);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      atlasImage(),
      u0 * ATLAS_W, (1 - v1) * ATLAS_H, (u1 - u0) * ATLAS_W, (v1 - v0) * ATLAS_H,
      slot * FACE_PX, 0, FACE_PX, FACE_PX,
    );
    this.faceTexture.needsUpdate = true;
  }

  /**
   * Faces from the roster. A seat whose roster entry carries a mint is one
   * the server verified at join; its image comes from this page's own origin
   * (/api/nft-img), which is what lets WebGL use it without a cross origin
   * taint. Anything that fails to load keeps the default face.
   */
  setFaces(roster: readonly RosterEntry[]): void {
    for (const r of roster) {
      if (r.slot < 0 || r.slot >= this.slots) continue;
      this.drawDefaultFace(r.slot);
      if (!r.mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.mint)) continue;
      const img = new Image();
      img.decoding = "async";
      img.onload = () => {
        const ctx = this.faceCanvas.getContext("2d")!;
        ctx.imageSmoothingEnabled = true;
        // Centre crop to a square, so a portrait or landscape image is not
        // squashed onto a square face.
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        ctx.drawImage(
          img,
          (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side,
          r.slot * FACE_PX, 0, FACE_PX, FACE_PX,
        );
        this.faceTexture.needsUpdate = true;
      };
      img.src = `/api/nft-img/${r.mint}`;
    }
  }

  private instanced(
    scene: THREE.Scene, g: THREE.BufferGeometry, m: THREE.Material | THREE.Material[], n: number,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(g, m, n);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    for (let i = 0; i < n; i++) mesh.setMatrixAt(i, this.hidden);
    scene.add(mesh);
    return mesh;
  }

  private hide(i: number): void {
    this.legs.setMatrixAt(i * 2, this.hidden);
    this.legs.setMatrixAt(i * 2 + 1, this.hidden);
    this.arms.setMatrixAt(i * 2, this.hidden);
    this.arms.setMatrixAt(i * 2 + 1, this.hidden);
    this.torsos.setMatrixAt(i, this.hidden);
    this.heads.setMatrixAt(i, this.hidden);
    this.caps.setMatrixAt(i, this.hidden);
    for (const g of this.guns) g.setMatrixAt(i, this.hidden);
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

  update(dt: number, remotes: Map<number, RemoteView>, localSlot: number): void {
    for (let i = 0; i < this.slots; i++) {
      const r = remotes.get(i);
      if (i === localSlot || !r || !r.alive) {
        this.hide(i);
        if (r) {
          const w = this.walk[i];
          w.x = r.x; w.z = r.z; w.y = r.y;
        }
        continue;
      }

      // Walk speed off the interpolated position, which is what is drawn.
      const w = this.walk[i];
      if (dt > 0) {
        const v = Math.hypot(r.x - w.x, r.z - w.z) / dt;
        const target = v > 30 ? 0 : Math.min(1, v / 7.4);
        w.speed += (target - w.speed) * Math.min(1, dt * 10);
        const vy = (r.y - w.y) / dt;
        const air = Math.abs(vy) > 0.5 ? 1 : 0;
        w.air += (air - w.air) * Math.min(1, dt * 12);
      }
      w.x = r.x; w.z = r.z; w.y = r.y;
      w.phase += dt * (2 + 10 * w.speed);
      this.light(i, probe(r.x, r.y + 1, r.z));

      const yaw = (r.yaw / YAW_UNITS) * Math.PI * 2;
      const swing = Math.sin(w.phase) * 0.75 * w.speed * (1 - w.air);
      const bob = Math.abs(Math.cos(w.phase)) * 0.05 * w.speed;
      const pitch = Math.max(-0.9, Math.min(0.9, r.pitch));

      this.base.makeRotationY(yaw).setPosition(r.x, r.y + bob, r.z);

      // Legs swing from the hip, opposite each other. In the air they part.
      for (const side of [0, 1]) {
        const sx = side === 0 ? -0.12 : 0.12;
        const a = (side === 0 ? swing : -swing) + (side === 0 ? -0.35 : 0.25) * w.air;
        this.set(this.legs, i * 2 + side, sx, HIP, 0, a, 0);
      }
      this.torsos.setMatrixAt(i, this.m.copy(this.base).multiply(this.part.makeTranslation(0, HIP, 0)));

      // Arms raised to the gun and following the aim. The left one crosses
      // in to the foregrip.
      const raise = 1.3 + pitch;
      this.set(this.arms, i * 2, TORSO_W / 2 + ARM_W / 2, SHOULDER, 0, raise, 0.12);
      this.set(this.arms, i * 2 + 1, -TORSO_W / 2 - ARM_W / 2, SHOULDER, 0, raise + 0.15, -0.55);

      this.heads.setMatrixAt(i, this.jointed(0, HEAD_Y0 - bob, 0, pitch * 0.5, 0));
      this.caps.setMatrixAt(i, this.jointed(0, HEAD_Y0 + HEAD - bob, 0, pitch * 0.5, 0));

      // The gun, at the right hand, along the aim.
      for (let g = 0; g < this.guns.length; g++) {
        if (g !== r.weapon) { this.guns[g].setMatrixAt(i, this.hidden); continue; }
        const reach = Math.sin(raise) * (ARM_LEN - 0.06);
        const drop = Math.cos(raise) * (ARM_LEN - 0.06);
        this.guns[g].setMatrixAt(i, this.jointed(0.13, SHOULDER - drop, -reach, pitch, 0));
      }
    }
    for (const mesh of [this.legs, this.torsos, this.arms, this.heads, this.caps, ...this.guns]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
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
    const s = scheme(i);
    const lit = (hex: number) => {
      this.c.set(hex);
      return this.c.setRGB(this.c.r * l[0] * 1.15, this.c.g * l[1] * 1.15, this.c.b * l[2] * 1.15);
    };
    this.torsos.setColorAt(i, lit(s.shirt));
    this.arms.setColorAt(i * 2, lit(s.shirt));
    this.arms.setColorAt(i * 2 + 1, lit(s.shirt));
    this.legs.setColorAt(i * 2, lit(s.trousers));
    this.legs.setColorAt(i * 2 + 1, lit(s.trousers));
    this.caps.setColorAt(i, lit(s.cap));
    this.heads.setColorAt(i, lit(0xffffff));
    for (const g of this.guns) g.setColorAt(i, lit(0xffffff));
  }

  /** base * translate(joint) * rotX(ax) * rotY(ay), into this.m. */
  private jointed(x: number, y: number, z: number, ax: number, ay: number): THREE.Matrix4 {
    this.m.copy(this.base).multiply(this.part.makeTranslation(x, y, z));
    if (ay !== 0) this.m.multiply(this.rot.makeRotationY(ay));
    if (ax !== 0) this.m.multiply(this.rot.makeRotationX(ax));
    return this.m;
  }

  private set(
    mesh: THREE.InstancedMesh, index: number,
    x: number, y: number, z: number, ax: number, ay: number,
  ): void {
    mesh.setMatrixAt(index, this.jointed(x, y, z, ax, ay));
  }
}

/** Point one face of a single box geometry at a different atlas tile. */
function setFaceTile(g: THREE.BufferGeometry, face: number, tile: number): void {
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  const [u0, v0, u1, v1] = tileUV(tile);
  const quad = [[0, 0], [1, 0], [1, 1], [0, 1]];
  for (let i = 0; i < 4; i++) {
    uv.setXY(face * 4 + i, u0 + (u1 - u0) * quad[i][0], v0 + (v1 - v0) * quad[i][1]);
  }
  uv.needsUpdate = true;
}
