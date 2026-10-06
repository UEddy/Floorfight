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
  rayGrid,
} from "../../shared/sim";
import {
  AIR,
  GRID_X,
  GRID_Y,
  GRID_Z,
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
  blockIX,
  blockIZ,
  blockMinX,
  blockMinZ,
  solidAt,
} from "../../shared/map";
import type { RemoteView } from "./netcode";
import { T, atlas, tileUV } from "./textures";
import { ViewModel } from "./viewmodel";

/** Chunks a body bursts into, and how many the pool holds. */
const CHUNKS_PER_DEATH = 26;
const CHUNK_POOL = CHUNKS_PER_DEATH * 6;
const CHUNK_LIFE = 1.6;

/** Tracers alive at once, and how long one lasts. */
const TRACER_POOL = 24;
const TRACER_LIFE = 0.07;

interface Chunk {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  rx: number; ry: number;
  life: number;
  colour: THREE.Color;
}

interface Tracer {
  x0: number; y0: number; z0: number;
  x1: number; y1: number; z1: number;
  life: number;
}

export const SLOT_COLORS = [0xff4d3d, 0x3da5ff, 0x4fe08a, 0xffd23a, 0xc46bff, 0x2fe0d6];

/**
 * The Hall, in blocks.
 *
 * Every block face samples one 16 pixel tile out of a single atlas (see
 * textures.ts), and all the light is baked into vertex colours at build time:
 * a face angle term so edges read, plus corner occlusion so the lanes between
 * booths have depth. Nothing in the scene is lit at runtime, and because every
 * material now shares the one atlas, the whole hall is a single draw call.
 *
 * Draw call budget (CLAUDE.md says under 150, and the floor is a Galaxy S10):
 *   1 hall mesh, 1 sign strip, 3 instanced player meshes, a gun and a muzzle
 *   flash, the death chunks, the tracers and remote muzzle flashes. Around
 *   ten, and it does not grow with the size of the map.
 */

/** Per face brightness. Flat colour with no angle term reads as a fog bank. */
const FACE_SHADE = [0.78, 0.78, 1.0, 0.5, 0.9, 0.9]; // +x -x +y -y +z -z

/** Vertex brightness by how many of its three neighbours are solid. */
const AO_SHADE = [1.0, 0.8, 0.64, 0.48];

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

/** Cheap integer hash for picking tile variants. Cosmetic only. */
function cellHash(ix: number, iy: number, iz: number): number {
  let h = (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  return (h ^ (h >>> 15)) >>> 0;
}

/** Floor columns and rows that are lanes between the booth bays. */
const LANE_X = new Set([14, 15, 21, 22, 28, 29, 35, 36]);
const LANE_Z = new Set([15, 21, 22, 28, 29, 35, 36]);

const isIron = (ix: number, iy: number, iz: number) => blockAt(ix, iy, iz) === M_IRON;

/**
 * Which tile a face shows. `f` is the face index: 2 is the top, 3 the bottom,
 * anything else a side.
 */
function tileFor(m: number, f: number, ix: number, iy: number, iz: number): number {
  const top = f === 2;
  const bottom = f === 3;
  const h = cellHash(ix, iy, iz);
  switch (m) {
    case M_FLOOR:
      if (!top) return T.STONE;
      // Carpet runners down the aisles, the way an exhibition lays them, and
      // bare boards under and round the booths.
      if (LANE_X.has(ix) || LANE_Z.has(iz)) return h % 5 === 0 ? T.CARPET_WORN : T.CARPET;
      return h % 3 === 0 ? T.PLANK_WORN : T.PLANK;
    case M_BRICK:
      if (top || bottom) return T.STONE_CAP;
      // A plinth of cut stone at the foot of every wall, brick above it, and
      // damp moss only near the floor.
      if (iy <= 1) return T.STONE;
      return iy <= 4 && h % 4 === 0 ? T.BRICK_MOSS : T.BRICK;
    case M_BOOTH: {
      if (top || bottom) return T.CANVAS;
      return ((ix / 7) | 0) % 2 === 0 ? T.FABRIC_A : T.FABRIC_A2;
    }
    case M_BOOTH2: {
      if (top || bottom) return T.CANVAS;
      if (iy >= 4) return T.FABRIC_B2;
      return ((iz / 7) | 0) % 2 === 0 ? T.FABRIC_B : T.CRATE;
    }
    case M_STAIR:
      return top ? T.STAIR : T.STAIR_SIDE;
    case M_GALLERY:
      return top || bottom ? T.DECK : T.DECK_SIDE;
    case M_IRON: {
      if (top || bottom) return T.IRON_TOP;
      // One block thick is a truss and shows its lattice. Anything thicker is
      // a pier and shows riveted plate.
      const thin = (!isIron(ix - 1, iy, iz) && !isIron(ix + 1, iy, iz)) ||
        (!isIron(ix, iy, iz - 1) && !isIron(ix, iy, iz + 1));
      return thin ? T.IRON : T.IRON_RIVET;
    }
    case M_STAGE:
      if (top || bottom) return T.STAGE_TOP;
      return iy <= 4 ? T.VELVET : T.STAGE_TOP;
    case M_TRIM:
      return top || bottom ? T.TRIM_TOP : T.TRIM;
    default:
      return T.STONE;
  }
}

/**
 * Texture coordinate across a side face, so that u runs left to right for a
 * viewer standing in front of it and v always runs up. Without this half the
 * walls in the hall would show their bricks lying on their side.
 */
function faceUV(f: number, lx: number, ly: number, lz: number): [number, number] {
  switch (f) {
    case 0: return [1 - lz, ly];
    case 1: return [lz, ly];
    case 4: return [lx, ly];
    case 5: return [1 - lx, ly];
    default: return [lx, 1 - lz];
  }
}

/**
 * Build the hall as one merged mesh.
 *
 * Only faces with air on the far side are emitted, which throws away every
 * interior face in the hall: the piers, the walls and the booth masses are
 * solid runs of cells and only their skins survive. That is the difference
 * between about sixty thousand triangles and about a million.
 */
function buildGrid(): THREE.Mesh {
  const P: number[] = [];
  const C: number[] = [];
  const U: number[] = [];

  for (let iy = 0; iy < GRID_Y; iy++) {
    for (let iz = 0; iz < GRID_Z; iz++) {
      for (let ix = 0; ix < GRID_X; ix++) {
        const m = blockAt(ix, iy, iz);
        if (m === AIR) continue;
        const ox = blockMinX(ix);
        const oz = blockMinZ(iz);

        for (let f = 0; f < 6; f++) {
          const { n, a, b } = FACES[f];
          if (occludes(ix + n[0], iy + n[1], iz + n[2])) continue;
          const shade = FACE_SHADE[f];
          const [u0, v0, u1, v1] = tileUV(tileFor(m, f, ix, iy, iz));

          // Position, brightness and texture coordinate of the four corners,
          // then two triangles.
          const vx: number[] = [];
          const vy: number[] = [];
          const vz: number[] = [];
          const vk: number[] = [];
          const vu: number[] = [];
          const vv: number[] = [];
          for (const [sa, sb] of CORNERS) {
            const ha = sa - 0.5;
            const hb = sb - 0.5;
            const lx = 0.5 + 0.5 * n[0] + a[0] * ha + b[0] * hb;
            const ly = 0.5 + 0.5 * n[1] + a[1] * ha + b[1] * hb;
            const lz = 0.5 + 0.5 * n[2] + a[2] * ha + b[2] * hb;
            vx.push(lx); vy.push(ly); vz.push(lz);
            const [tu, tv] = faceUV(f, lx, ly, lz);
            vu.push(u0 + (u1 - u0) * tu);
            vv.push(v0 + (v1 - v0) * tv);

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
            C.push(vk[i], vk[i], vk[i]);
            U.push(vu[i], vv[i]);
          }
        }
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(C, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(U, 2));
  g.computeBoundingSphere();
  // Unlit and vertex coloured. The shading is already in the colours, so
  // there is no normal attribute and no light to evaluate per fragment.
  const mesh = new THREE.Mesh(
    g, new THREE.MeshBasicMaterial({ map: atlas(), vertexColors: true, fog: true }),
  );
  mesh.frustumCulled = false;
  return mesh;
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
  private view = new ViewModel();
  private lastEye = { x: 0, z: 0 };
  private moving = 0;
  private chunks: THREE.InstancedMesh;
  private chunkState: Chunk[] = [];
  private tracers: THREE.LineSegments;
  private tracerState: Tracer[] = [];
  private tracerPos: Float32Array;
  private muzzles: THREE.InstancedMesh;
  private muzzleUntil: number[] = [];
  private lastDraw = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  private scratch = new THREE.Vector3(1, 1, 1);
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

    this.scene.add(buildGrid());
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

    // Death chunks: one instanced mesh for every body that has ever burst.
    // Purely cosmetic, so this is the one place in the client that may use
    // Math.random freely. Nothing here is sent anywhere or predicted.
    this.chunks = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.17, 0.17, 0.17),
      new THREE.MeshLambertMaterial(),
      CHUNK_POOL,
    );
    this.chunks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.chunks.frustumCulled = false;
    for (let i = 0; i < CHUNK_POOL; i++) this.chunks.setMatrixAt(i, this.hidden);
    this.scene.add(this.chunks);

    // Tracers: one line list with a fixed buffer, redrawn each frame.
    this.tracerPos = new Float32Array(TRACER_POOL * 6);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute("position", new THREE.BufferAttribute(this.tracerPos, 3));
    tg.setDrawRange(0, 0);
    this.tracers = new THREE.LineSegments(
      tg, new THREE.LineBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.75 }),
    );
    this.tracers.frustumCulled = false;
    this.scene.add(this.tracers);

    // Other players' muzzle flashes, one slot each.
    this.muzzles = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.22, 0.22, 0.22),
      new THREE.MeshBasicMaterial({ color: 0xffe9a8 }),
      slots,
    );
    this.muzzles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.muzzles.frustumCulled = false;
    for (let i = 0; i < slots; i++) {
      this.muzzles.setMatrixAt(i, this.hidden);
      this.muzzleUntil.push(0);
    }
    this.scene.add(this.muzzles);

    // The hall, then the view model on top of it with depth cleared. Two
    // render calls, so the clear between them is ours to make.
    this.renderer.autoClear = false;
    // Counted over the whole frame rather than per render call, so the debug
    // overlay's draw call figure covers both passes.
    this.renderer.info.autoReset = false;

    this.resize();
    addEventListener("resize", () => this.resize());
  }

  resize(): void {
    const w = innerWidth;
    const h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.view.resize(w / h);
  }

  /** Our own shot: the view model kicks and flashes. */
  muzzleFlash(): void {
    this.view.fired();
  }

  /** The local player's colour, for the sleeves. */
  setLocalSlot(slot: number): void {
    this.view.setSleeve(SLOT_COLORS[slot % SLOT_COLORS.length]);
  }

  /** Somebody else fired: show a flash at their hands for a moment. */
  remoteFlash(slot: number, nowMs: number): void {
    if (slot < 0 || slot >= this.muzzleUntil.length) return;
    this.muzzleUntil[slot] = nowMs + 60;
  }

  /**
   * A body comes apart into blocks.
   *
   * The velocities are random because they are decoration: the server has
   * already decided who died, and nothing about where a chunk lands is ever
   * told to anyone.
   */
  burst(x: number, y: number, z: number, slot: number): void {
    const colour = new THREE.Color(SLOT_COLORS[slot % SLOT_COLORS.length]);
    for (let i = 0; i < CHUNKS_PER_DEATH; i++) {
      if (this.chunkState.length >= CHUNK_POOL) this.chunkState.shift();
      const up = 2.5 + Math.random() * 4.5;
      this.chunkState.push({
        x: x + (Math.random() - 0.5) * 0.5,
        y: y + 0.2 + Math.random() * 1.5,
        z: z + (Math.random() - 0.5) * 0.5,
        vx: (Math.random() - 0.5) * 6,
        vy: up,
        vz: (Math.random() - 0.5) * 6,
        rx: Math.random() * 6,
        ry: Math.random() * 6,
        life: CHUNK_LIFE,
        // Carried on the chunk rather than written straight into the
        // instance: chunks expire out of the middle of the pool, so the
        // instance a chunk occupies changes during its life.
        colour: colour.clone().multiplyScalar(0.7 + Math.random() * 0.5),
      });
    }
  }

  /** A shot's path, drawn for a few frames. */
  tracer(
    x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  ): void {
    if (this.tracerState.length >= TRACER_POOL) this.tracerState.shift();
    this.tracerState.push({ x0, y0, z0, x1, y1, z1, life: TRACER_LIFE });
  }

  /**
   * Where a world point lands on screen, for the HUD's nameplates and damage
   * numbers.
   *
   * `clear` is a line of sight test against the block grid, using the same
   * ray the server uses for shots, so a nameplate behind a booth is hidden
   * rather than floating in front of it.
   */
  project(x: number, y: number, z: number): {
    sx: number; sy: number; dist: number; onScreen: boolean; clear: boolean;
  } {
    const cam = this.camera;
    this.v.set(x, y, z);
    const dx = x - cam.position.x;
    const dy = y - cam.position.y;
    const dz = z - cam.position.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    this.v.project(cam);
    const sx = (this.v.x * 0.5 + 0.5) * innerWidth;
    const sy = (-this.v.y * 0.5 + 0.5) * innerHeight;
    const onScreen = this.v.z < 1 && this.v.x > -1.1 && this.v.x < 1.1 &&
      this.v.y > -1.1 && this.v.y < 1.1;
    let clear = false;
    if (dist > 0.001) {
      const hit = rayGrid(
        cam.position.x, cam.position.y, cam.position.z,
        dx / dist, dy / dist, dz / dist, dist,
      );
      clear = hit >= dist;
    }
    return { sx, sy, dist, onScreen, clear };
  }

  /** Advance the cosmetic simulation: chunks fall, tracers fade. */
  private advance(dt: number, nowMs: number): void {
    for (let i = this.chunkState.length - 1; i >= 0; i--) {
      const c = this.chunkState[i];
      c.life -= dt;
      if (c.life <= 0) {
        this.chunkState.splice(i, 1);
        continue;
      }
      c.vy -= 22 * dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.z += c.vz * dt;
      // Bounce off whatever they land on, losing most of the energy. The grid
      // is right here, so a chunk resting on a booth roof is free.
      if (c.vy < 0 && solidAt(blockIX(c.x), Math.floor(c.y), blockIZ(c.z))) {
        c.y = Math.floor(c.y) + 1;
        c.vy = -c.vy * 0.28;
        c.vx *= 0.6;
        c.vz *= 0.6;
        if (c.vy < 0.6) c.vy = 0;
      }
    }
    for (let i = 0; i < CHUNK_POOL; i++) {
      const c = this.chunkState[i];
      if (!c) {
        this.chunks.setMatrixAt(i, this.hidden);
        continue;
      }
      this.chunks.setColorAt(i, c.colour);
      const spin = (CHUNK_LIFE - c.life) * 3;
      this.e.set(c.rx + spin, c.ry + spin, 0);
      const fade = c.life < 0.35 ? c.life / 0.35 : 1;
      this.m.compose(
        this.v.set(c.x, c.y, c.z),
        this.q.setFromEuler(this.e),
        this.scratch.set(fade, fade, fade),
      );
      this.chunks.setMatrixAt(i, this.m);
    }
    this.chunks.instanceMatrix.needsUpdate = true;
    if (this.chunks.instanceColor) this.chunks.instanceColor.needsUpdate = true;

    let n = 0;
    for (let i = this.tracerState.length - 1; i >= 0; i--) {
      const t = this.tracerState[i];
      t.life -= dt;
      if (t.life <= 0) this.tracerState.splice(i, 1);
    }
    for (const t of this.tracerState) {
      this.tracerPos[n * 6] = t.x0;
      this.tracerPos[n * 6 + 1] = t.y0;
      this.tracerPos[n * 6 + 2] = t.z0;
      this.tracerPos[n * 6 + 3] = t.x1;
      this.tracerPos[n * 6 + 4] = t.y1;
      this.tracerPos[n * 6 + 5] = t.z1;
      n++;
    }
    this.tracers.geometry.setDrawRange(0, n * 2);
    (this.tracers.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    this.tracers.visible = n > 0;

    for (let i = 0; i < this.muzzleUntil.length; i++) {
      if (nowMs >= this.muzzleUntil[i]) this.muzzles.setMatrixAt(i, this.hidden);
    }
    this.muzzles.instanceMatrix.needsUpdate = true;
  }

  /** Draw calls this frame, for the HUD's budget readout. */
  get drawCalls(): number {
    return this.renderer.info.render.calls;
  }

  /** Triangles submitted this frame. The other half of the budget. */
  get triangles(): number {
    return this.renderer.info.render.triangles;
  }

  draw(
    nowMs: number,
    eye: { x: number; y: number; z: number; yaw: number; pitch: number },
    localSlot: number,
    remotes: Map<number, RemoteView>,
    held: { weapon: number; reload: number | null; alive: boolean; grounded: boolean },
  ): void {
    this.camera.position.set(eye.x, eye.y + EYE_HEIGHT, eye.z);
    this.camera.rotation.set(eye.pitch, eye.yaw, 0);

    const dt = this.lastDraw === 0 ? 0 : Math.min(0.1, (nowMs - this.lastDraw) / 1000);
    this.lastDraw = nowMs;

    // Horizontal speed off the drawn eye, smoothed, for the bob. A respawn is
    // a jump of many blocks in one frame and is ignored.
    if (dt > 0) {
      const v = Math.hypot(eye.x - this.lastEye.x, eye.z - this.lastEye.z) / dt;
      if (v < 30) this.moving += (v - this.moving) * Math.min(1, dt * 12);
    }
    this.lastEye.x = eye.x;
    this.lastEye.z = eye.z;
    this.view.update(
      dt, held.weapon, held.reload, this.moving, eye.yaw, eye.pitch, held.alive, held.grounded,
    );

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

      // Muzzle flash in front of the chest, on the side their gun is on.
      if (nowMs < this.muzzleUntil[i]) {
        const yaw = (r.yaw / YAW_UNITS) * Math.PI * 2;
        const fx = -Math.sin(yaw);
        const fz = -Math.cos(yaw);
        this.m.makeTranslation(
          r.x + fx * 0.55 - fz * 0.2,
          r.y + 1.25,
          r.z + fz * 0.55 + fx * 0.2,
        );
        this.muzzles.setMatrixAt(i, this.m);
      }
    }
    this.bodies.instanceMatrix.needsUpdate = true;
    this.heads.instanceMatrix.needsUpdate = true;
    this.visors.instanceMatrix.needsUpdate = true;

    this.advance(dt, nowMs);
    this.renderer.info.reset();
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.clearDepth();
    this.renderer.render(this.view.scene, this.view.camera);
  }
}
