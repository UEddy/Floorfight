import * as THREE from "three";
import {
  BODY_HALF_X,
  BODY_HALF_Z,
  BODY_TOP,
  EYE_HEIGHT,
  HEAD_BOTTOM,
  HEAD_HALF,
  HEAD_TOP,
  YAW_UNITS,
} from "../../shared/sim";
import {
  AIR,
  GRID_X,
  GRID_Y,
  GRID_Z,
  MATERIAL_COUNT,
  M_BOOTH,
  M_BOOTH2,
  M_BRICK,
  M_FLOOR,
  M_GALLERY,
  M_IRON,
  M_STAGE,
  M_STAIR,
  M_TRIM,
  SIGNS,
  blockAt,
  blockMinX,
  blockMinZ,
  solidAt,
} from "../../shared/map";
import type { RemoteView } from "./netcode";

export const SLOT_COLORS = [0xff4d3d, 0x3da5ff, 0x4fe08a, 0xffd23a, 0xc46bff, 0x2fe0d6];

/**
 * The Hall, in blocks.
 *
 * Saturated flat colour, no textures on the geometry, and all the light baked
 * into vertex colours at build time: a face angle term so edges read, plus
 * corner occlusion so the lanes between booths have depth. Nothing in the
 * scene is lit at runtime, which is why the whole hall costs one draw call per
 * material.
 *
 * Draw call budget (CLAUDE.md says under 150, and the floor is a Galaxy S10):
 *   up to 9 merged material meshes, 1 sign strip, 3 instanced player meshes,
 *   a gun and a muzzle flash. Around 15, and it does not grow with the size
 *   of the map.
 */
const PALETTE: Record<number, number> = {
  [M_FLOOR]: 0xb5652f,
  [M_BRICK]: 0x9e2b3c,
  [M_BOOTH]: 0x18907d,
  [M_BOOTH2]: 0xe0a21c,
  [M_STAIR]: 0xf2602c,
  [M_GALLERY]: 0x2f6ddf,
  [M_IRON]: 0x37456b,
  [M_STAGE]: 0x7b2fa0,
  [M_TRIM]: 0xffc426,
};

/** Per face brightness. Flat colour with no angle term reads as a fog bank. */
const FACE_SHADE = [0.74, 0.74, 1.0, 0.42, 0.86, 0.86]; // +x -x +y -y +z -z

/** Vertex brightness by how many of its three neighbours are solid. */
const AO_SHADE = [1.0, 0.82, 0.66, 0.5];

/**
 * The six faces, as an outward normal and two in-plane axes chosen so that
 * A cross B equals the normal. That one property makes the corner order
 * (0,0) (1,0) (1,1) (0,1) wind counter clockwise seen from outside for every
 * face, so back face culling keeps exactly the faces a player can see.
 */
type Axis = readonly [number, number, number];
const FACES: readonly { n: Axis; a: Axis; b: Axis }[] = [
  { n: [1, 0, 0], a: [0, 1, 0], b: [0, 0, 1] },
  { n: [-1, 0, 0], a: [0, 0, 1], b: [0, 1, 0] },
  { n: [0, 1, 0], a: [0, 0, 1], b: [1, 0, 0] },
  { n: [0, -1, 0], a: [1, 0, 0], b: [0, 0, 1] },
  { n: [0, 0, 1], a: [1, 0, 0], b: [0, 1, 0] },
  { n: [0, 0, -1], a: [0, 1, 0], b: [1, 0, 0] },
];

/** Corner order, and the two triangles over it. */
const CORNERS: readonly [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
const TRIS = [0, 1, 2, 0, 2, 3];

/** Above the top layer is open sky, so those faces are drawn. */
function occludes(ix: number, iy: number, iz: number): boolean {
  if (iy >= GRID_Y) return false;
  return solidAt(ix, iy, iz);
}

/**
 * Build one merged mesh per material.
 *
 * Only faces with air on the far side are emitted, which throws away every
 * interior face in the hall: the piers, the walls and the booth masses are
 * solid runs of cells and only their skins survive. That is the difference
 * between about sixty thousand triangles and about a million.
 */
function buildGrid(): THREE.Mesh[] {
  const pos: number[][] = [];
  const col: number[][] = [];
  for (let m = 0; m < MATERIAL_COUNT; m++) { pos.push([]); col.push([]); }

  for (let iy = 0; iy < GRID_Y; iy++) {
    for (let iz = 0; iz < GRID_Z; iz++) {
      for (let ix = 0; ix < GRID_X; ix++) {
        const m = blockAt(ix, iy, iz);
        if (m === AIR) continue;
        const base = new THREE.Color(PALETTE[m] ?? 0xcccccc);
        const ox = blockMinX(ix);
        const oz = blockMinZ(iz);
        const P = pos[m];
        const C = col[m];

        for (let f = 0; f < 6; f++) {
          const { n, a, b } = FACES[f];
          if (occludes(ix + n[0], iy + n[1], iz + n[2])) continue;
          const shade = FACE_SHADE[f];

          // Position and brightness of the four corners, then two triangles.
          const vx: number[] = [];
          const vy: number[] = [];
          const vz: number[] = [];
          const vk: number[] = [];
          for (const [sa, sb] of CORNERS) {
            const ha = sa - 0.5;
            const hb = sb - 0.5;
            vx.push(0.5 + 0.5 * n[0] + a[0] * ha + b[0] * hb);
            vy.push(0.5 + 0.5 * n[1] + a[1] * ha + b[1] * hb);
            vz.push(0.5 + 0.5 * n[2] + a[2] * ha + b[2] * hb);

            const du = sa ? 1 : -1;
            const dv = sb ? 1 : -1;
            const sx = ix + n[0], sy = iy + n[1], sz = iz + n[2];
            const s1 = occludes(sx + a[0] * du, sy + a[1] * du, sz + a[2] * du) ? 1 : 0;
            const s2 = occludes(sx + b[0] * dv, sy + b[1] * dv, sz + b[2] * dv) ? 1 : 0;
            const cc = occludes(
              sx + a[0] * du + b[0] * dv,
              sy + a[1] * du + b[1] * dv,
              sz + a[2] * du + b[2] * dv,
            ) ? 1 : 0;
            vk.push(shade * AO_SHADE[s1 && s2 ? 3 : s1 + s2 + cc]);
          }
          for (const i of TRIS) {
            P.push(ox + vx[i], iy + vy[i], oz + vz[i]);
            C.push(base.r * vk[i], base.g * vk[i], base.b * vk[i]);
          }
        }
      }
    }
  }

  const meshes: THREE.Mesh[] = [];
  for (let m = 0; m < MATERIAL_COUNT; m++) {
    if (pos[m].length === 0) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos[m], 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col[m], 3));
    g.computeBoundingSphere();
    // Flat, unlit, vertex coloured. The shading is already in the colours, so
    // there is no normal attribute and no light to evaluate per fragment.
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, fog: true }));
    mesh.frustumCulled = false;
    meshes.push(mesh);
  }
  return meshes;
}

/**
 * Booth signage: one canvas atlas, one merged strip of quads, one draw call.
 *
 * The names are invented. There is no real company, conference or token
 * branding anywhere in the hall, which keeps the app publishable and keeps
 * the set dressing out of anyone's trademark.
 */
function buildSigns(): THREE.Mesh | null {
  if (SIGNS.length === 0) return null;
  const rows = SIGNS.length;
  const W = 1024;
  const H = 64;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H * rows;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  SIGNS.forEach((s, i) => {
    const y = i * H;
    ctx.fillStyle = "#1b1410";
    ctx.fillRect(0, y, W, H);
    ctx.fillStyle = "#ffc426";
    ctx.fillRect(0, y, W, 5);
    ctx.fillRect(0, y + H - 5, W, 5);
    ctx.fillStyle = "#ffe9a8";
    ctx.font = "700 40px Georgia, 'Times New Roman', serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(s.text, W / 2, y + H / 2, W - 40);
  });

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;

  const pos: number[] = [];
  const uv: number[] = [];
  const EPS = 0.03;

  SIGNS.forEach((s, i) => {
    const v0 = i / rows;
    const v1 = (i + 1) / rows;
    const y0 = s.y;
    const y1 = s.y + 1;
    // Corners are listed so that u runs the way a viewer standing in front of
    // the face reads: text on a -z face reads towards decreasing x, and so on
    // round the four facings.
    let a: [number, number], b: [number, number];
    if (s.facing === 0) {
      const z = blockMinZ(s.z) - EPS;
      a = [blockMinX(s.x) + s.w, z];
      b = [blockMinX(s.x), z];
    } else if (s.facing === 1) {
      const z = blockMinZ(s.z) + 1 + EPS;
      a = [blockMinX(s.x), z];
      b = [blockMinX(s.x) + s.w, z];
    } else if (s.facing === 2) {
      const x = blockMinX(s.x) - EPS;
      a = [x, blockMinZ(s.z)];
      b = [x, blockMinZ(s.z) + s.w];
    } else {
      const x = blockMinX(s.x) + 1 + EPS;
      a = [x, blockMinZ(s.z) + s.w];
      b = [x, blockMinZ(s.z)];
    }
    const push = (p: [number, number], y: number, u: number, v: number) => {
      pos.push(p[0], y, p[1]);
      uv.push(u, v);
    };
    // The atlas row runs bottom to top, so v0 goes with the lower edge.
    push(a, y0, 0, v0); push(b, y0, 1, v0); push(b, y1, 1, v1);
    push(a, y0, 0, v0); push(b, y1, 1, v1); push(a, y1, 0, v1);
  });

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: tex, fog: true }));
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * Player meshes are drawn at exactly the sim's hitbox sizes. What you see is
 * what the server tests, so a shot that lands on a drawn body is a shot that
 * lands on the server's body at the rewound tick.
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
  private one = new THREE.Vector3(1, 1, 1);
  private hidden = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(canvas: HTMLCanvasElement, private slots: number) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = false;

    // Gaslight haze. It also hides the far wall of a 48 block hall, which is
    // the cheapest way to keep the depth readable without a shadow in sight.
    const air = 0x2a2230;
    this.scene.background = new THREE.Color(air);
    this.scene.fog = new THREE.Fog(air, 22, 62);

    this.camera = new THREE.PerspectiveCamera(75, 1, 0.05, 140);
    this.camera.rotation.order = "YXZ";
    this.scene.add(this.camera);

    for (const mesh of buildGrid()) this.scene.add(mesh);
    const signs = buildSigns();
    if (signs) this.scene.add(signs);

    // Players: body, head and a visor so facing is readable at range. One
    // lambert pair for all of them, lit by a hemisphere light only, because
    // these are the only objects in the scene that move.
    this.scene.add(new THREE.HemisphereLight(0xfff0d0, 0x40304a, 2.1));
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
      new THREE.MeshBasicMaterial({ color: 0x241f1a }),
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

  /** Draw calls this frame, for the HUD's budget readout. */
  get drawCalls(): number {
    return this.renderer.info.render.calls;
  }

  draw(
    nowMs: number,
    eye: { x: number; y: number; z: number; yaw: number; pitch: number },
    localSlot: number,
    remotes: Map<number, RemoteView>,
  ): void {
    this.camera.position.set(eye.x, eye.y + EYE_HEIGHT, eye.z);
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
      this.m.makeTranslation(r.x, r.y, r.z);
      this.bodies.setMatrixAt(i, this.m);
      this.heads.setMatrixAt(i, this.m);
      this.e.set(0, (r.yaw / YAW_UNITS) * Math.PI * 2, 0);
      this.m.compose(this.v.set(r.x, r.y, r.z), this.q.setFromEuler(this.e), this.one);
      this.visors.setMatrixAt(i, this.m);
    }
    this.bodies.instanceMatrix.needsUpdate = true;
    this.heads.instanceMatrix.needsUpdate = true;
    this.visors.instanceMatrix.needsUpdate = true;

    this.renderer.render(this.scene, this.camera);
  }
}
