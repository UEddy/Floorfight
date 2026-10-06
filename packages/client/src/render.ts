import * as THREE from "three";
import {
  EYE_HEIGHT,
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
import { addProps } from "./props";
import { SKY, SKY_FLOOR, WARM, lanternsSeenFrom, skyAt, warmAt } from "./lighting";
import { Characters, HAIR, SKIN, scheme } from "./characters";

/** Chunks a body bursts into, and how many the pool holds. */
const CHUNKS_PER_DEATH = 34;
const CHUNK_POOL = CHUNKS_PER_DEATH * 6;
const CHUNK_LIFE = 2.2;

/** Tracers alive at once, and how long one lasts. */
const TRACER_POOL = 24;
const TRACER_LIFE = 0.07;

interface Chunk {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  rx: number; ry: number;
  life: number;
  colour: THREE.Color;
  /** Scale of this chunk against the base cube. */
  size: number;
}

interface Tracer {
  x0: number; y0: number; z0: number;
  x1: number; y1: number; z1: number;
  life: number;
}

/** Vertical field of view, in degrees. */
const FOV = 85;

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
      if (top || bottom) return T.TRIM_TOP;
      // Stacked trim is a gallery pier, a column rather than a balustrade.
      return blockAt(ix, iy + 1, iz) === M_TRIM || blockAt(ix, iy - 1, iz) === M_TRIM
        ? T.COLUMN : T.TRIM;
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

          // Light for this face: how much sky the air cell in front of it
          // sees, and which lanterns it can see from its centre.
          const fcx = ox + 0.5 + n[0] * 0.5;
          const fcy = iy + 0.5 + n[1] * 0.5;
          const fcz = oz + 0.5 + n[2] * 0.5;
          const sky = SKY_FLOOR + (1 - SKY_FLOOR) *
            skyAt(fcx + n[0] * 0.45, fcy + n[1] * 0.45, fcz + n[2] * 0.45);
          const seen = lanternsSeenFrom(fcx, fcy, fcz, n[0], n[1], n[2]);

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
            const ao = AO_SHADE[s1 && s2 ? 3 : s1 + s2 + cc];
            const base = shade * ao * sky;
            const warm = seen.length ? warmAt(ox + lx, iy + ly, oz + lz, seen) * (0.4 + 0.6 * ao) : 0;
            vk.push(
              base * SKY[0] + warm * WARM[0],
              base * SKY[1] + warm * WARM[1],
              base * SKY[2] + warm * WARM[2],
            );
          }
          for (const i of TRIS) {
            P.push(ox + vx[i], iy + vy[i], oz + vz[i]);
            C.push(vk[i * 3], vk[i * 3 + 1], vk[i * 3 + 2]);
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
 * Player bodies are drawn inside the sim's hitboxes at any facing (see
 * characters.ts), so a shot that lands on a drawn body is a shot that lands
 * on the server's body at the rewound tick.
 */
export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  private scene = new THREE.Scene();
  private people: Characters;
  private view = new ViewModel();
  private lastEye = { x: 0, z: 0 };
  private moving = 0;
  private bobPhase = 0;
  private shake = 0;
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
  private scratch = new THREE.Vector3(1, 1, 1);
  private hidden = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(canvas: HTMLCanvasElement, private slots: number) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = false;

    // Dusk haze, the colour of the sky low down through the glass. It softens
    // the far end of a 48 block hall, which is the cheapest way to keep depth
    // readable without a shadow in sight. The sky itself is a dome in props.
    this.scene.fog = new THREE.Fog(0x4b3a66, 14, 62);

    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 140);
    this.camera.rotation.order = "YXZ";
    this.scene.add(this.camera);

    this.scene.add(buildGrid());
    addProps(this.scene);
    const signs = buildSigns();
    if (signs) this.scene.add(signs);

    // Players. The hemisphere light is only for the death chunks, which
    // tumble, so a baked face shade would be wrong half the time.
    this.scene.add(new THREE.HemisphereLight(0xfff0d0, 0x40304a, 2.1));
    this.people = new Characters(this.scene, slots);

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

  /** Our own shot: the view model kicks and flashes, the camera shakes. */
  muzzleFlash(weapon: number): void {
    this.view.fired();
    this.shake = Math.min(1, this.shake + (weapon === 2 ? 0.9 : weapon === 1 ? 0.5 : 0.3));
  }

  /**
   * Screen pixels from the centre for an aim deviation in yaw units, at the
   * current field of view. The crosshair is drawn with this.
   */
  spreadPixels(units: number): number {
    const angle = (units / YAW_UNITS) * Math.PI * 2;
    const half = (this.camera.fov * Math.PI) / 360;
    return (Math.tan(angle) / Math.tan(half)) * (innerHeight / 2);
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
    // Coloured like the body they came from: mostly shirt, then trousers,
    // skin, hair and a little of the cap.
    const s = scheme(slot);
    const palette = [s.shirt, s.shirt, s.shirt, s.trousers, s.trousers, SKIN, SKIN, HAIR, s.cap];
    for (let i = 0; i < CHUNKS_PER_DEATH; i++) {
      const colour = new THREE.Color(palette[Math.floor(Math.random() * palette.length)]);
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
        colour: colour.multiplyScalar(0.75 + Math.random() * 0.4),
        size: 0.6 + Math.random() * 0.8,
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
      const fade = (c.life < 0.35 ? c.life / 0.35 : 1) * c.size;
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
    const dt = this.lastDraw === 0 ? 0 : Math.min(0.1, (nowMs - this.lastDraw) / 1000);
    this.lastDraw = nowMs;

    // Head bob while walking, and a shake when we fire. Both move the
    // camera's position by a few centimetres and roll it, and neither turns
    // it: the middle of the screen stays exactly where the next shot goes,
    // which a pitch or yaw shake would quietly break.
    const run = Math.min(1, this.moving / 7.4) * (held.grounded ? 1 : 0);
    this.bobPhase += dt * (5 + 6 * run);
    const bobY = -Math.abs(Math.sin(this.bobPhase)) * 0.045 * run;
    const bobX = Math.cos(this.bobPhase) * 0.025 * run;
    this.shake -= this.shake * Math.min(1, dt * 18);
    const jx = (Math.random() - 0.5) * 0.03 * this.shake;
    const jy = (Math.random() - 0.5) * 0.03 * this.shake;
    const cy = Math.cos(eye.yaw);
    const sy = Math.sin(eye.yaw);
    this.camera.position.set(
      eye.x + (bobX + jx) * cy,
      eye.y + EYE_HEIGHT + bobY + jy,
      eye.z - (bobX + jx) * sy,
    );
    this.camera.rotation.set(
      eye.pitch, eye.yaw,
      Math.cos(this.bobPhase) * 0.006 * run + (Math.random() - 0.5) * 0.02 * this.shake,
    );

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

    this.people.update(dt, remotes, localSlot);
    for (let i = 0; i < this.slots; i++) {
      const r = remotes.get(i);
      // Muzzle flash at the end of their gun.
      if (r && r.alive && i !== localSlot && nowMs < this.muzzleUntil[i]) {
        this.people.muzzle(r, this.v);
        this.m.makeTranslation(this.v.x, this.v.y, this.v.z);
        this.muzzles.setMatrixAt(i, this.m);
      }
    }

    this.advance(dt, nowMs);
    this.renderer.info.reset();
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.clearDepth();
    this.renderer.render(this.view.scene, this.view.camera);
  }
}
