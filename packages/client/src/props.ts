import * as THREE from "three";
import {
  ENGINES,
  GRID_X,
  GRID_Y,
  GRID_Z,
  LEVEL_GROUND,
  M_BRICK,
  STALLS,
  M_IRON,
  blockAt,
  blockMinX,
  blockMinZ,
  solidAt,
} from "../../shared/map";
import { buildParts, type Part } from "./boxes";
import { LANTERNS, probe } from "./lighting";
import { T, atlas, tileUV } from "./textures";

/**
 * Set dressing: the sky, the glass roof, the lanterns and the plants.
 *
 * None of it is in the block grid and none of it is solid, so none of it is
 * allowed to look like cover. A plant a player could crouch behind, that a
 * bullet then went straight through, would be a lie about the one thing a
 * shooter has to be able to trust. So everything here is flat against a
 * surface (ivy, grass at the foot of a wall), above head height (lanterns,
 * bunting, the roof), or on top of a stall or an engine where nobody stands.
 *
 * Draw calls: sky, roof iron, roof glass, solid props, cut out props and the
 * lantern glows. Six, whatever the number of things in them.
 */

const HALF_X = GRID_X / 2;
const HALF_Z = GRID_Z / 2;

/** Cosmetic hash, for which wall gets ivy and which ledge gets a plant. */
function hash(a: number, b: number, c = 0): number {
  let h = Math.imul(a, 374761393) ^ Math.imul(b, 668265263) ^ Math.imul(c, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/* ---------------------------------------------------------------- sky --- */

/**
 * Past the far corner of the hall from anywhere inside it, and inside the
 * camera's far plane (render.ts), so it is never clipped.
 */
export const SKY_RADIUS = 160;

/**
 * Dusk over the glass: deep blue overhead, violet, then a warm band at the
 * horizon. A gradient on a big sphere, drawn first and never fogged.
 */
function sky(): THREE.Mesh {
  const g = new THREE.SphereGeometry(SKY_RADIUS, 24, 12);
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color(0x141a44) },
      mid: { value: new THREE.Color(0x4a3477) },
      low: { value: new THREE.Color(0xe2875e) },
    },
    vertexShader: `
      varying float h;
      void main() {
        h = normalize(position).y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 top; uniform vec3 mid; uniform vec3 low;
      varying float h;
      void main() {
        vec3 c = h > 0.25 ? mix(mid, top, smoothstep(0.25, 0.85, h))
                          : mix(low, mid, smoothstep(-0.05, 0.25, h));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  return mesh;
}

/* --------------------------------------------------------------- roof --- */

/**
 * A barrel vault of glass on white iron ribs over the whole hall, the way
 * the great Victorian exhibition halls are roofed. It springs from the top of
 * the walls and is above everything a player can reach, so it is purely
 * something to look up at.
 */
const SPRING = GRID_Y;
const RISE = 14;
const SEGMENTS = 20;
const RIB_EVERY = 6;
/** Length of a glass pane along the hall. Two to a bay between ribs. */
const PANE = 3;

/** A point on the arch, t from 0 (west wall) to 1 (east wall). */
function arch(t: number): [number, number] {
  const x = -HALF_X + t * GRID_X;
  // A segmental arch: a circle through both wall tops and the crown.
  const half = HALF_X;
  const r = (half * half + RISE * RISE) / (2 * RISE);
  const y = SPRING + RISE - r + Math.sqrt(Math.max(0, r * r - x * x));
  return [x, y];
}

function roof(): { iron: THREE.Mesh; glass: THREE.Mesh } {
  const parts: Part[] = [];
  const rib = (z: number, size: number) => {
    for (let i = 0; i < SEGMENTS; i++) {
      const [x0, y0] = arch(i / SEGMENTS);
      const [x1, y1] = arch((i + 1) / SEGMENTS);
      const len = Math.hypot(x1 - x0, y1 - y0);
      parts.push({
        x: (x0 + x1) / 2, y: (y0 + y1) / 2, z,
        w: len + 0.1, h: size, d: size, tile: T.TRIM_TOP,
        rz: Math.atan2(y1 - y0, x1 - x0),
      });
    }
  };
  for (let z = -HALF_Z; z <= HALF_Z; z += RIB_EVERY) rib(z, z === -HALF_Z || z === HALF_Z ? 0.7 : 0.45);
  // Purlins running the length of the hall between the ribs.
  for (let i = 1; i < SEGMENTS; i += 2) {
    const [x, y] = arch(i / SEGMENTS);
    parts.push({ x, y: y + 0.05, z: 0, w: 0.2, h: 0.2, d: GRID_Z, tile: T.TRIM_TOP });
  }
  const iron = new THREE.Mesh(
    buildParts(parts).geometry,
    new THREE.MeshBasicMaterial({ map: atlas(), vertexColors: true, fog: true }),
  );
  iron.frustumCulled = false;
  tintAll(iron, 0.8);

  // Glass: one quad per arch segment per bay, and the two end fans.
  const pos: number[] = [];
  const uv: number[] = [];
  const [u0, v0, u1, v1] = tileUV(T.GLASS);
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    uv.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
  };
  for (let z = -HALF_Z; z < HALF_Z; z += PANE) {
    for (let i = 0; i < SEGMENTS; i++) {
      const [x0, y0] = arch(i / SEGMENTS);
      const [x1, y1] = arch((i + 1) / SEGMENTS);
      quad([x0, y0, z], [x0, y0, z + PANE], [x1, y1, z + PANE], [x1, y1, z]);
    }
  }
  // End walls: fan the arch down to the wall top.
  for (const z of [-HALF_Z, HALF_Z]) {
    for (let i = 0; i < SEGMENTS; i++) {
      const [x0, y0] = arch(i / SEGMENTS);
      const [x1, y1] = arch((i + 1) / SEGMENTS);
      quad([x0, SPRING, z], [x1, SPRING, z], [x1, y1, z], [x0, y0, z]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  const glass = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
    map: atlas(), transparent: true, opacity: 0.32, side: THREE.DoubleSide,
    depthWrite: false, fog: true, color: 0xcfd8ff,
  }));
  glass.frustumCulled = false;
  return { iron, glass };
}

function tintAll(mesh: THREE.Mesh, k: number): void {
  const c = mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
  for (let i = 0; i < c.count; i++) c.setXYZ(i, c.getX(i) * k, c.getY(i) * k, c.getZ(i) * k * 1.05);
  c.needsUpdate = true;
}

/* ----------------------------------------------------------- lanterns --- */

function lanternParts(): Part[] {
  const parts: Part[] = [];
  for (const l of LANTERNS) {
    parts.push(
      { x: l.x, y: l.y, z: l.z, w: 0.22, h: 0.28, d: 0.22, tile: T.LAMP, top: T.GUNMETAL },
      { x: l.x, y: l.y + 0.17, z: l.z, w: 0.28, h: 0.06, d: 0.28, tile: T.GUNMETAL },
      // The bracket back to the wall.
      {
        x: l.x + l.wx * 0.16, y: l.y + 0.24, z: l.z + l.wz * 0.16,
        w: l.wx !== 0 ? 0.32 : 0.05, h: 0.05, d: l.wz !== 0 ? 0.32 : 0.05, tile: T.GUNMETAL,
      },
    );
  }
  return parts;
}

/** A soft round glow round each lantern, additive, one draw call for all. */
function glows(): THREE.Points {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,226,160,0.9)");
  grad.addColorStop(0.25, "rgba(255,180,90,0.35)");
  grad.addColorStop(1, "rgba(255,140,60,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  const pos: number[] = [];
  for (const l of LANTERNS) pos.push(l.x, l.y, l.z);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  const pts = new THREE.Points(g, new THREE.PointsMaterial({
    map: new THREE.CanvasTexture(c), size: 1.5, sizeAttenuation: true, transparent: true,
    depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
  }));
  pts.frustumCulled = false;
  return pts;
}

/* -------------------------------------------------------------- flora --- */

/**
 * Little potted palms on the tops of the market stalls and the engines,
 * which are two blocks and more off the floor: out of reach of a step and of
 * a jump, so nobody stands among them and nobody is fooled into hiding
 * behind one.
 */
function plantParts(): { solid: Part[]; leaves: Quad[] } {
  const solid: Part[] = [];
  const leaves: Quad[] = [];
  const tops: { x: number; z: number; w: number; d: number; top: number }[] = [
    ...STALLS.map((s) => ({ x: s.x, z: s.z, w: 3, d: 4, top: LEVEL_GROUND + s.h })),
    ...ENGINES.map((e) => ({ x: e.x, z: e.z, w: e.w, d: e.d, top: LEVEL_GROUND + e.h })),
  ];
  tops.forEach((t, n) => {
    const corners = [[0, 0], [t.w - 1, 0], [0, t.d - 1], [t.w - 1, t.d - 1]];
    for (let k = 0; k < 4; k++) {
      if (hash(n, k) > 0.6) continue;
      const ix = t.x + corners[k][0];
      const iz = t.z + corners[k][1];
      const y = t.top;
      if (solidAt(ix, y, iz) || !solidAt(ix, y - 1, iz)) continue;
      const x = blockMinX(ix) + 0.5;
      const z = blockMinZ(iz) + 0.5;
      solid.push({ x, y: y + 0.2, z, w: 0.4, h: 0.4, d: 0.4, tile: T.POT });
      const s = 0.55 + hash(ix, iz) * 0.25;
      leaves.push(...cross(x, y + 0.3, z, s * 2, s * 2.2, T.FROND, hash(iz, ix) * Math.PI));
    }
  });
  return { solid, leaves };
}

interface Quad { p: number[]; uv: number[]; light: [number, number, number] }

/** Two quads crossed at right angles, standing on (x, y, z). */
function cross(x: number, y: number, z: number, w: number, h: number, tile: number, turn: number): Quad[] {
  const out: Quad[] = [];
  const [u0, v0, u1, v1] = tileUV(tile);
  const light = probe(x, y + 0.5, z);
  for (const a of [turn, turn + Math.PI / 2]) {
    const dx = Math.cos(a) * w / 2;
    const dz = Math.sin(a) * w / 2;
    out.push({
      p: [x - dx, y, z - dz, x + dx, y, z + dz, x + dx, y + h, z + dz, x - dx, y + h, z - dz],
      uv: [u0, v0, u1, v0, u1, v1, u0, v1],
      light,
    });
  }
  return out;
}

/**
 * Flat against a wall face: a quad on the air side of block (ix, iy, iz),
 * on the face pointing along (nx, nz).
 */
function onWall(ix: number, iy: number, iz: number, nx: number, nz: number, tile: number): Quad {
  const [u0, v0, u1, v1] = tileUV(tile);
  const off = 0.03;
  let x0: number, z0: number, x1: number, z1: number;
  const bx = blockMinX(ix);
  const bz = blockMinZ(iz);
  if (nx !== 0) {
    const x = nx > 0 ? bx + 1 + off : bx - off;
    x0 = x; x1 = x;
    z0 = nx > 0 ? bz + 1 : bz; z1 = nx > 0 ? bz : bz + 1;
  } else {
    const z = nz > 0 ? bz + 1 + off : bz - off;
    z0 = z; z1 = z;
    x0 = nz > 0 ? bx : bx + 1; x1 = nz > 0 ? bx + 1 : bx;
  }
  const light = probe(bx + 0.5 + nx, iy + 0.1, bz + 0.5 + nz);
  return {
    p: [x0, iy, z0, x1, iy, z1, x1, iy + 1, z1, x0, iy + 1, z0],
    uv: [u0, v0, u1, v0, u1, v1, u0, v1],
    light,
  };
}

/** Ivy down the brick walls and the iron piers, and grass at their feet. */
function ivyAndGrass(): Quad[] {
  const out: Quad[] = [];
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  for (let iz = 0; iz < GRID_Z; iz++) {
    for (let ix = 0; ix < GRID_X; ix++) {
      for (const [nx, nz] of dirs) {
        // A column of wall facing open air.
        const m = blockAt(ix, LEVEL_GROUND, iz);
        if (m !== M_BRICK && m !== M_IRON) continue;
        if (solidAt(ix + nx, LEVEL_GROUND, iz + nz)) continue;
        const h = hash(ix * 4 + nx + 2, iz * 4 + nz + 2);
        // Grass at the foot of about one wall cell in three.
        if (h < 0.33) {
          const tufts = onWall(ix, LEVEL_GROUND, iz, nx, nz, T.TUFT);
          // Pulled out a little from the wall and only knee high.
          for (let i = 0; i < 4; i++) {
            tufts.p[i * 3] += nx * 0.12;
            tufts.p[i * 3 + 2] += nz * 0.12;
          }
          for (const i of [2, 3]) tufts.p[i * 3 + 1] = LEVEL_GROUND + 0.45;
          out.push(tufts);
        }
        // Ivy: a strand hanging from somewhere up the wall, for a cell in
        // five. It hangs down to the floor or until the wall runs out.
        if (h > 0.8) {
          const top = 3 + Math.floor(hash(iz, ix, 7) * 6);
          for (let y = top; y >= LEVEL_GROUND; y--) {
            if (blockAt(ix, y, iz) !== m) break;
            if (solidAt(ix + nx, y, iz + nz)) break;
            if (y < top - 4 && hash(ix, y, iz) < 0.4) break;
            out.push(onWall(ix, y, iz, nx, nz, T.IVY));
          }
        }
      }
    }
  }
  return out;
}

/**
 * Strings of pennants across the nave, high above the galleries. Triangles
 * in the stall colours, sagging between the walls. Two runs across the hall
 * between column pairs and two down the nave inside the columns, so the
 * nave's long lines have something overhead to read depth against.
 */
function bunting(): Quad[] {
  const out: Quad[] = [];
  const colours = [0xe4532f, 0xf6c443, 0x16a08f, 0x2a6fd0, 0xe8467a, 0xf2efe6];
  const [u0, v0, u1, v1] = tileUV(T.CLOTH);
  const runs: [number, number, number, number, number][] = [
    // x0, z0, x1, z1, height
    [-40.5, -6.5, 40.5, -6.5, 13.4],
    [-40.5, 17.5, 40.5, 17.5, 13.4],
    [-12.5, -40.5, -12.5, 40.5, 14.6],
    [12.5, -40.5, 12.5, 40.5, 14.6],
  ];
  for (const [x0, z0, x1, z1, y] of runs) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.floor(len / 0.7);
    for (let i = 0; i < n; i++) {
      const t0 = i / n;
      const t1 = (i + 0.7) / n;
      const sag = (t: number) => y - Math.sin(t * Math.PI * 10) ** 2 * 0.8;
      const ax = x0 + (x1 - x0) * t0, az = z0 + (z1 - z0) * t0;
      const bx = x0 + (x1 - x0) * t1, bz = z0 + (z1 - z0) * t1;
      const ay = sag(t0), by = sag(t1);
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      // Skip any pennant that would hang inside a block.
      if (solidAt(Math.floor(mx + HALF_X), Math.floor(ay - 0.3), Math.floor(mz + HALF_Z))) continue;
      const c = new THREE.Color(colours[i % colours.length]);
      const light = probe(mx, ay, mz);
      out.push({
        // A triangle, as a quad with two corners at the tip.
        p: [ax, ay, az, bx, by, bz, mx, (ay + by) / 2 - 0.42, mz, mx, (ay + by) / 2 - 0.42, mz],
        uv: [u0, v1, u1, v1, (u0 + u1) / 2, v0, (u0 + u1) / 2, v0],
        light: [light[0] * c.r * 1.2, light[1] * c.g * 1.2, light[2] * c.b * 1.2],
      });
    }
  }
  return out;
}

function quadsMesh(quads: Quad[]): THREE.Mesh {
  const pos: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (const q of quads) {
    const base = pos.length / 3;
    pos.push(...q.p);
    uv.push(...q.uv);
    for (let i = 0; i < 4; i++) col.push(...q.light);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
    map: atlas(), vertexColors: true, alphaTest: 0.5, side: THREE.DoubleSide, fog: true,
  }));
  mesh.frustumCulled = false;
  return mesh;
}

/** Everything above, added to the scene. */
export function addProps(scene: THREE.Scene): void {
  scene.add(sky());
  const { iron, glass } = roof();
  scene.add(iron);
  scene.add(glass);

  const plants = plantParts();
  const solid = new THREE.Mesh(
    buildParts([...lanternParts(), ...plants.solid]).geometry,
    new THREE.MeshBasicMaterial({ map: atlas(), vertexColors: true, fog: true }),
  );
  solid.frustumCulled = false;
  scene.add(solid);

  scene.add(quadsMesh([...ivyAndGrass(), ...plants.leaves, ...bunting()]));
  scene.add(glows());
}
