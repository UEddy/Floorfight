import * as THREE from "three";
import {
  ARENA_HALF,
  BODY_HALF_X,
  BODY_HALF_Z,
  BODY_TOP,
  CRATES,
  EYE_HEIGHT,
  HEAD_BOTTOM,
  HEAD_HALF,
  HEAD_TOP,
  YAW_UNITS,
} from "../../shared/sim";
import type { RemoteView } from "./netcode";

export const SLOT_COLORS = [0xe8553e, 0x3e8be8, 0x4fc46a, 0xe8c23e, 0xb05ee8, 0x3ed6d0];

/**
 * Greybox renderer.
 *
 * Player meshes are drawn at exactly the sim's hitbox sizes. What you see is
 * what the server tests, so a shot that lands on a drawn body is a shot that
 * lands on the server's body at the rewound tick.
 *
 * Budget: every repeated shape is one InstancedMesh, no shadows, one light
 * pair. This scene is about ten draw calls.
 */
export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  private scene = new THREE.Scene();
  private bodies: THREE.InstancedMesh;
  private heads: THREE.InstancedMesh;
  private visors: THREE.InstancedMesh;
  private flash: THREE.Mesh;
  private flashUntil = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private hidden = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(canvas: HTMLCanvasElement, private slots: number) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = false;

    this.scene.background = new THREE.Color(0x9fb6c9);
    this.scene.fog = new THREE.Fog(0x9fb6c9, 40, 95);
    this.scene.add(new THREE.HemisphereLight(0xdfe9f3, 0x4a4a42, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(20, 40, 10);
    this.scene.add(sun);

    this.camera = new THREE.PerspectiveCamera(75, 1, 0.05, 200);
    this.camera.rotation.order = "YXZ";
    this.scene.add(this.camera);

    // Floor and grid.
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(ARENA_HALF * 2, ARENA_HALF * 2),
      new THREE.MeshLambertMaterial({ color: 0x6f7468 }),
    );
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);
    const grid = new THREE.GridHelper(ARENA_HALF * 2, ARENA_HALF, 0x585c52, 0x585c52);
    grid.position.y = 0.01;
    this.scene.add(grid);

    // Perimeter walls and crates share one instanced mesh.
    const boxes: { x: number; z: number; hx: number; hz: number; top: number; c: number }[] = [];
    const W = ARENA_HALF;
    boxes.push({ x: 0, z: -W, hx: W, hz: 0.5, top: 4, c: 0x8a8f86 });
    boxes.push({ x: 0, z: W, hx: W, hz: 0.5, top: 4, c: 0x8a8f86 });
    boxes.push({ x: -W, z: 0, hx: 0.5, hz: W, top: 4, c: 0x8a8f86 });
    boxes.push({ x: W, z: 0, hx: 0.5, hz: W, top: 4, c: 0x8a8f86 });
    CRATES.forEach((c, i) => boxes.push({ ...c, c: i % 2 ? 0xa88a62 : 0x98794f }));

    const boxMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial(),
      boxes.length,
    );
    boxes.forEach((b, i) => {
      this.m.compose(
        this.v.set(b.x, b.top / 2, b.z),
        this.q.identity(),
        new THREE.Vector3(b.hx * 2, b.top, b.hz * 2),
      );
      boxMesh.setMatrixAt(i, this.m);
      boxMesh.setColorAt(i, new THREE.Color(b.c));
    });
    this.scene.add(boxMesh);

    // Players: body, head and a visor so facing is readable at range.
    const mat = new THREE.MeshLambertMaterial();
    this.bodies = new THREE.InstancedMesh(
      new THREE.BoxGeometry(BODY_HALF_X * 2, BODY_TOP, BODY_HALF_Z * 2).translate(0, BODY_TOP / 2, 0),
      mat, slots);
    this.heads = new THREE.InstancedMesh(
      new THREE.BoxGeometry(HEAD_HALF * 2, HEAD_TOP - HEAD_BOTTOM, HEAD_HALF * 2)
        .translate(0, (HEAD_BOTTOM + HEAD_TOP) / 2, 0),
      mat, slots);
    this.visors = new THREE.InstancedMesh(
      new THREE.BoxGeometry(HEAD_HALF * 1.6, 0.12, 0.06).translate(0, HEAD_BOTTOM + 0.3, -HEAD_HALF - 0.02),
      new THREE.MeshBasicMaterial({ color: 0x111111 }),
      slots);
    for (let i = 0; i < slots; i++) {
      const c = new THREE.Color(SLOT_COLORS[i % SLOT_COLORS.length]);
      this.bodies.setColorAt(i, c);
      this.heads.setColorAt(i, c.clone().multiplyScalar(1.15));
    }
    for (const mesh of [this.bodies, this.heads, this.visors]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      this.scene.add(mesh);
    }

    // First person gun and muzzle flash, parented to the camera.
    const gun = new THREE.Mesh(
      new THREE.BoxGeometry(0.045, 0.06, 0.3),
      new THREE.MeshLambertMaterial({ color: 0x2b2d30 }),
    );
    gun.position.set(0.16, -0.15, -0.42);
    this.camera.add(gun);
    this.flash = new THREE.Mesh(
      new THREE.SphereGeometry(0.035, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffe08a }),
    );
    this.flash.position.set(0.16, -0.13, -0.6);
    this.flash.visible = false;
    this.camera.add(this.flash);

    this.resize();
    addEventListener("resize", () => this.resize());
  }

  resize(): void {
    const w = innerWidth;
    const h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  muzzleFlash(nowMs: number): void {
    this.flashUntil = nowMs + 50;
  }

  draw(
    nowMs: number,
    eye: { x: number; z: number; yaw: number; pitch: number },
    localSlot: number,
    remotes: Map<number, RemoteView>,
  ): void {
    this.camera.position.set(eye.x, EYE_HEIGHT, eye.z);
    this.camera.rotation.set(eye.pitch, eye.yaw, 0);
    this.flash.visible = nowMs < this.flashUntil;

    for (let i = 0; i < this.slots; i++) {
      const r = remotes.get(i);
      if (i === localSlot || !r || !r.alive) {
        this.bodies.setMatrixAt(i, this.hidden);
        this.heads.setMatrixAt(i, this.hidden);
        this.visors.setMatrixAt(i, this.hidden);
        continue;
      }
      // Hitboxes in the sim are axis aligned and do not rotate with yaw. The
      // body is drawn the same way so the silhouette is the hitbox. Only the
      // visor turns, to show facing.
      this.m.makeTranslation(r.x, 0, r.z);
      this.bodies.setMatrixAt(i, this.m);
      this.heads.setMatrixAt(i, this.m);
      this.e.set(0, (r.yaw / YAW_UNITS) * Math.PI * 2, 0);
      this.m.compose(this.v.set(r.x, 0, r.z), this.q.setFromEuler(this.e), new THREE.Vector3(1, 1, 1));
      this.visors.setMatrixAt(i, this.m);
    }
    this.bodies.instanceMatrix.needsUpdate = true;
    this.heads.instanceMatrix.needsUpdate = true;
    this.visors.instanceMatrix.needsUpdate = true;

    this.renderer.render(this.scene, this.camera);
  }
}
