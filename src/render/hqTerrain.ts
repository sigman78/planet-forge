import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { dirToFace, faceST, faceToDir } from '../core/cube.ts';
import { COMMON, HQ_LEVELS, type PlanetView } from './planetView.ts';
import terrainCommon from '../shaders/terrain_common.glsl?raw';
import terrainLight from '../shaders/terrain_light.glsl?raw';
import terrainFrag from '../shaders/terrain.frag.glsl?raw';
import hqVert from '../shaders/terrain_hq.vert.glsl?raw';
import terrainFine from '../shaders/terrain_fine.glsl?raw';
import terrainHq from '../shaders/terrain_hq.glsl?raw';
import probeFrag from '../shaders/terrain_probe.frag.glsl?raw';

/** Ring levels at most (level k has cells 2^-k of the coarse spacing: 1.64 km -> 3.2 m on R 800 at 768). */
export const HQ_MAX_LEVELS = HQ_LEVELS;
/** Cells per ring side that can be chosen. 32 is about half the cost of 64; 64 carries relief twice as far out. */
export const HQ_RING_CELLS = [32, 64] as const;
/** Rings fade out (into the coarse mesh) between these heights above the ground, km. */
const FADE_ALT: [number, number] = [14, 20];
/** Keep the anchor face until the nadir is this far (grid units) past its edge. */
const FACE_HYSTERESIS = 0.02;
/** Cells per side of a draw block: the unit of ordering and culling. */
const BLOCK = 8;
/** Chunk sets per grid: the 4 hole variants (child offset b = 0/1 per axis), then the full grid. */
const FULL = 4;

/** Everything that depends on the ring size n (cells per side). */
interface RingGrid {
  n: number;
  blocks: number;
  /** Blocks nearest the centre (the camera nadir) first, so near relief hides far relief before it is shaded. */
  order: [number, number][];
  /** [inner rings, outer ring on even coarse parity, outer ring on odd] -> hole variant -> block chunks. */
  chunks: Uint16Array[][][];
  pos: THREE.BufferAttribute;
  /**
   * Morph band in cells from the nadir (box distance). The child ring covers up to n/4 + 1 parent cells from the
   * nadir, so the parent must be unmorphed there; the window edge sits n/2 - 2 .. n/2 + 2 cells out, so the morph
   * must be complete before it.
   */
  morph: [number, number];
}

/**
 * Grid indices of a (n+1)^2 vertex grid with the child's window cut out (or not), one chunk per block in `order`.
 * Within a block cells go row by row, which keeps the vertex cache warm.
 *
 * Inner rings split every cell along a-c: a collapsed child cell then has its parent's diagonal. The outer ring
 * (`coarseParity` set) splits its cells like the coarse cell they lie in (geometry.ts alternates the diagonal), so
 * collapsed it is exactly the coarse mesh: no seam with it, and no pop when the rings fade out.
 */
function ringIndex(n: number, order: [number, number][], hole: [number, number] | null, coarseParity: number | null): Uint16Array[] {
  const row = n + 1;
  return order.map(([bx, by]) => {
    const idx: number[] = [];
    for (let j = by * BLOCK; j < (by + 1) * BLOCK; j++) {
      for (let i = bx * BLOCK; i < (bx + 1) * BLOCK; i++) {
        if (hole && i >= hole[0] && i < hole[0] + n / 2 && j >= hole[1] && j < hole[1] + n / 2) continue;
        const a = j * row + i, b = a + 1, c = a + row + 1, d = a + row;
        if (coarseParity !== null && ((i >> 1) + (j >> 1) + coarseParity) & 1) idx.push(a, b, d, b, c, d);
        else idx.push(a, b, c, a, c, d);
      }
    }
    return new Uint16Array(idx);
  });
}

function makeGrid(n: number): RingGrid {
  const blocks = n / BLOCK;
  const order: [number, number][] = [];
  for (let by = 0; by < blocks; by++) for (let bx = 0; bx < blocks; bx++) order.push([bx, by]);
  const dist = ([bx, by]: [number, number]) => Math.hypot(bx + 0.5 - blocks / 2, by + 0.5 - blocks / 2);
  order.sort((a, b) => dist(a) - dist(b));
  const chunkSet = (parity: number | null) => {
    // The child window starts n/4 + b parent cells into the parent (b = 0 or 1 per axis, from the snapping).
    const out = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([bx, by]) => ringIndex(n, order, [n / 4 + bx, n / 4 + by], parity));
    out.push(ringIndex(n, order, null, parity));
    return out;
  };
  const pos = new Float32Array((n + 1) * (n + 1) * 3);
  for (let j = 0, v = 0; j <= n; j++) for (let i = 0; i <= n; i++, v++) pos.set([i, j, 0], v * 3);
  return { n, blocks, order, chunks: [chunkSet(null), chunkSet(0), chunkSet(1)], pos: new THREE.BufferAttribute(pos, 3), morph: [(n * 5) / 16, n / 2 - 4] };
}

interface Ring {
  mesh: THREE.Mesh;
  U: Record<string, THREE.IUniform>;
  index: THREE.BufferAttribute;
  /** Grid, chunk set, hole variant and visible blocks the index was last built for. */
  key: string;
}

/**
 * HQ terrain: nested camera-centred grid rings that carry real geometry below the coarse mesh spacing, displaced
 * by the same height function as the coarse mesh (and the fragment normals). Coarse vertices inside the rings sink
 * below them (uHQSink), so the depth test drops those triangles before shading.
 */
export class HQTerrain {
  readonly group = new THREE.Group();
  private rings: Ring[] = [];
  private grids = new Map<number, RingGrid>();
  private grid!: RingGrid;
  private frustum = new THREE.Frustum();
  private projView = new THREE.Matrix4();
  private corner = new Float32Array(0);
  private cornerFar = new Float32Array(0);
  private tmpDir: [number, number, number] = [0, 0, 0];
  private tmpV = new THREE.Vector3();
  /** A ring level shows once its cells span this many pixels at the nadir, and is fully in at twice that. */
  cellPx = 10;
  /** Coarse vertices more than this many outer-ring cells inside its edge sink below the rings. */
  sinkInset = 0.5;
  /** Cull blocks outside the view (debugging and cost tests). */
  cull = true;
  /** Blocks drawn last frame, over all rings. */
  drawnBlocks = 0;
  private face = -1;
  /** Levels drawn last frame (0 = off). */
  activeLevels = 0;
  /** Cap on the levels drawn. */
  maxLevels = HQ_MAX_LEVELS;
  /**
   * Surface radius (km) the rings draw under the camera, read back from the GPU about a frame late; NaN while the
   * rings are off or no reading has arrived yet.
   */
  probeRadius = NaN;
  private probeRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false, generateMipmaps: false });
  private probeMat: THREE.ShaderMaterial;
  private probeQuad: FullScreenQuad;
  private probeBuf = new Float32Array(4);
  private probeBusy = false;
  /** Bumped whenever the rings turn off, so readings in flight from before are dropped. */
  private probeGen = 0;
  private finestFp = 1;

  constructor(private view: PlanetView) {
    const T = view.terrainMat.uniforms;
    this.probeMat = new THREE.ShaderMaterial({
      uniforms: { ...T, uProbeDir: { value: new THREE.Vector3(0, 1, 0) }, uProbeFp: { value: 1 } },
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: COMMON + terrainCommon + terrainFine + probeFrag,
      depthTest: false,
      depthWrite: false,
    });
    this.probeQuad = new FullScreenQuad(this.probeMat);
    for (let k = 1; k <= HQ_MAX_LEVELS; k++) {
      const U: Record<string, THREE.IUniform> = {
        ...T,
        uHQOrigin: { value: new THREE.Vector2() },
        uHQNadir: { value: new THREE.Vector2() },
        uHQCellS: { value: 1 },
        uHQCellKm: { value: 1 },
        uHQBlend: { value: 1 },
        uHQLevel: { value: k },
      };
      const mat = new THREE.ShaderMaterial({
        uniforms: U,
        vertexShader: COMMON + terrainCommon + terrainFine + terrainHq + hqVert,
        fragmentShader: COMMON + terrainCommon + terrainLight + terrainFrag,
      });
      const geo = new THREE.BufferGeometry();
      const maxN = Math.max(...HQ_RING_CELLS);
      const index = new THREE.BufferAttribute(new Uint16Array(maxN * maxN * 6), 1);
      index.setUsage(THREE.DynamicDrawUsage);
      geo.setIndex(index);
      geo.setDrawRange(0, 0);
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      // Finest first: near ground hides what lies behind it before that gets shaded.
      mesh.renderOrder = -1 - k * 0.01;
      mesh.visible = false;
      this.group.add(mesh);
      this.rings.push({ mesh, U, index, key: '' });
    }
    this.setCells(HQ_RING_CELLS[0]);
  }

  /** Cells per ring side. */
  get cells() {
    return this.grid.n;
  }

  /** Switch the ring size (one of HQ_RING_CELLS). */
  setCells(n: number) {
    if (this.grid?.n === n) return;
    let g = this.grids.get(n);
    if (!g) {
      g = makeGrid(n);
      this.grids.set(n, g);
    }
    this.grid = g;
    const T = this.view.terrainMat.uniforms;
    (T.uHQMorph.value as THREE.Vector2).set(g.morph[0], g.morph[1]);
    T.uHQN.value = n;
    this.corner = new Float32Array((g.blocks + 1) * (g.blocks + 1) * 3);
    this.cornerFar = new Float32Array((g.blocks + 1) * (g.blocks + 1));
    for (const r of this.rings) {
      r.mesh.geometry.setAttribute('position', g.pos);
      r.key = '';
    }
  }

  /** Program for the rings, so the first toggle does not stall on the (large) terrain shader. */
  compile(renderer: THREE.WebGLRenderer, camera: THREE.Camera, scene: THREE.Scene) {
    const vis = this.rings[0].mesh.visible;
    this.rings[0].mesh.visible = true;
    renderer.compileAsync(scene, camera).catch(() => {});
    this.rings[0].mesh.visible = vis;
  }

  /**
   * Place the rings under the camera. `groundAltKm` is the camera height above the terrain; `pixelAngle` the
   * radians per screen pixel.
   */
  update(camera: THREE.Camera, groundAltKm: number, pixelAngle: number, enabled: boolean) {
    const T = this.view.terrainMat.uniforms;
    const segments = this.view.segments;
    const altBlend = 1 - THREE.MathUtils.smoothstep(groundAltKm, FADE_ALT[0], FADE_ALT[1]);
    if (!enabled || segments < 1 || altBlend <= 0) {
      this.off();
      return;
    }
    const p = camera.position;
    let st = this.face >= 0 ? faceST(this.face, p.x, p.y, p.z) : null;
    if (!st || Math.max(Math.abs(st.s), Math.abs(st.t)) > 1 + FACE_HYSTERESIS) {
      this.face = dirToFace(p.x, p.y, p.z).face;
      st = faceST(this.face, p.x, p.y, p.z);
    }
    const spacingKm = T.uVertexSpacing.value as number;
    const N = this.grid.n;
    const pxKm = Math.max(groundAltKm, 0.005) * pixelAngle;
    // Levels in: cells of at least cellPx pixels at the nadir.
    const blend: number[] = [];
    for (let k = 1; k <= this.maxLevels; k++) {
      const r = spacingKm / 2 ** k / pxKm;
      const b = Math.min(THREE.MathUtils.clamp((r - this.cellPx) / this.cellPx, 0, 1), altBlend);
      if (b <= 0) break;
      blend.push(b);
    }
    const K = blend.length;
    if (K === 0) {
      this.off();
      return;
    }
    this.activeLevels = K;
    // The finest ring at the nadir: its footprint, grown toward the parent's while it fades in.
    this.finestFp = 2 * (spacingKm / 2 ** K) * (2 - blend[K - 1]);
    T.uHQOn.value = K > 0 ? 1 : 0;
    T.uHQK.value = K;
    T.uHQFace.value = this.face;
    const wire = this.view.terrainMat.wireframe;
    const origins: number[][] = [];
    for (let k = 1; k <= HQ_MAX_LEVELS; k++) {
      const ring = this.rings[k - 1];
      if (k > K) {
        ring.mesh.visible = false;
        continue;
      }
      const cellS = 2 / segments / 2 ** k;
      const ns = (st.s + 1) / cellS, nt = (st.t + 1) / cellS;
      const ox = 2 * Math.floor(ns / 2) - N / 2, oy = 2 * Math.floor(nt / 2) - N / 2;
      origins.push([ox, oy]);
      const U = ring.U;
      (U.uHQOrigin.value as THREE.Vector2).set(ox, oy);
      (U.uHQNadir.value as THREE.Vector2).set(ns - ox, nt - oy);
      U.uHQCellS.value = cellS;
      U.uHQCellKm.value = spacingKm / 2 ** k;
      U.uHQBlend.value = blend[k - 1];
      (T.uHQOriginA.value as THREE.Vector2[])[k - 1].set(ox, oy);
      (T.uHQNadirA.value as THREE.Vector2[])[k - 1].set(ns - ox, nt - oy);
      (T.uHQCellSA.value as number[])[k - 1] = cellS;
      (T.uHQCellKmA.value as number[])[k - 1] = spacingKm / 2 ** k;
      (T.uHQBlendA.value as number[])[k - 1] = blend[k - 1];
      ring.mesh.visible = true;
      (ring.mesh.material as THREE.ShaderMaterial).wireframe = wire;
      if (k === 1) {
        // Coarse vertices inside the outer ring sink below the rings. The coarse triangles along its edge then dive
        // under the outer ring's collapsed band, which is the coarse mesh itself, so nothing is shaded twice.
        const cs = cellS, si = this.sinkInset;
        (T.uHQSink.value as THREE.Vector4).set(-1 + (ox + si) * cs, -1 + (oy + si) * cs, -1 + (ox + N - si) * cs, -1 + (oy + N - si) * cs);
      }
    }
    this.prepareCull(camera, groundAltKm);
    this.drawnBlocks = 0;
    for (let k = 1; k <= K; k++) {
      let variant = FULL;
      const [ox, oy] = origins[k - 1];
      if (k < K) {
        const [cx, cy] = origins[k];
        const bx = cx / 2 - ox - N / 4, by = cy / 2 - oy - N / 4;
        variant = (bx ? 1 : 0) + (by ? 2 : 0);
      }
      // Outer ring: ring cells (ox + i) lie in coarse cells (ox + i) >> 1, and ox is even.
      const set = k === 1 ? 1 + ((((ox + oy) / 2) % 2) + 2) % 2 : 0;
      this.buildIndex(this.rings[k - 1], set, variant, ox, oy, 2 / segments / 2 ** k);
    }
  }

  /** Frustum and ground for this frame's block culling. */
  private cullGroundR = 0;
  private nadir = new THREE.Vector3();
  private prepareCull(camera: THREE.Camera, groundAltKm: number) {
    camera.updateMatrixWorld();
    this.group.updateWorldMatrix(true, false);
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(this.group.matrixWorld);
    this.frustum.setFromProjectionMatrix(this.projView, THREE.WebGLCoordinateSystem, camera.reversedDepth);
    const r = camera.position.length();
    this.nadir.copy(camera.position).divideScalar(r);
    this.cullGroundR = r - groundAltKm;
  }

  /**
   * Fill a ring's index with its visible blocks, nearest first. A block is culled when its box lies outside a
   * frustum plane; its height range is bounded from the ground under the camera by the horizontal distance
   * (slopes up to 2:1 plus 0.2 km), so nothing that can show is dropped.
   */
  private buildIndex(ring: Ring, set: number, variant: number, ox: number, oy: number, cellS: number) {
    const g = this.grid, B = g.blocks, chunks = g.chunks[set][variant];
    const face = this.face;
    const C = this.corner, far = this.cornerFar, d = this.tmpDir, R = this.cullGroundR;
    for (let j = 0, c = 0; j <= B; j++) {
      for (let i = 0; i <= B; i++, c++) {
        faceToDir(face, -1 + (ox + i * BLOCK) * cellS, -1 + (oy + j * BLOCK) * cellS, d);
        C[c * 3] = d[0]; C[c * 3 + 1] = d[1]; C[c * 3 + 2] = d[2];
        const cos = d[0] * this.nadir.x + d[1] * this.nadir.y + d[2] * this.nadir.z;
        far[c] = Math.acos(Math.min(1, cos)) * R;
      }
    }
    const planes = this.frustum.planes, v = this.tmpV;
    const visible: number[] = [];
    g.order.forEach(([bx, by], n) => {
      if (chunks[n].length === 0) return;
      if (this.cull) {
        const cs = [by * (B + 1) + bx, by * (B + 1) + bx + 1, (by + 1) * (B + 1) + bx, (by + 1) * (B + 1) + bx + 1];
        const m = 0.2 + 2 * Math.max(far[cs[0]], far[cs[1]], far[cs[2]], far[cs[3]]);
        for (const p of planes) {
          let inside = false;
          for (const c of cs) {
            for (const rr of [R - m, R + m]) {
              v.set(C[c * 3] * rr, C[c * 3 + 1] * rr, C[c * 3 + 2] * rr);
              if (p.distanceToPoint(v) >= 0) { inside = true; break; }
            }
            if (inside) break;
          }
          if (!inside) return;
        }
      }
      visible.push(n);
    });
    this.drawnBlocks += visible.length;
    const key = g.n + ':' + set + ':' + variant + ':' + visible.join(',');
    if (key === ring.key) return;
    ring.key = key;
    const arr = ring.index.array as Uint16Array;
    let count = 0;
    for (const n of visible) {
      const ch = chunks[n];
      arr.set(ch, count);
      count += ch.length;
    }
    ring.index.clearUpdateRanges();
    ring.index.addUpdateRange(0, count);
    ring.index.needsUpdate = true;
    ring.mesh.geometry.setDrawRange(0, count);
  }

  private off() {
    this.activeLevels = 0;
    this.view.terrainMat.uniforms.uHQOn.value = 0;
    this.view.terrainMat.uniforms.uHQK.value = 0;
    for (const r of this.rings) r.mesh.visible = false;
    if (!Number.isNaN(this.probeRadius) || this.probeBusy) this.probeGen++;
    this.probeRadius = NaN;
  }

  /** Ask the GPU for the ring surface under the camera (one pixel, read back asynchronously). */
  probe(renderer: THREE.WebGLRenderer, camera: THREE.Camera) {
    if (this.activeLevels === 0 || this.probeBusy) return;
    const U = this.probeMat.uniforms;
    (U.uProbeDir.value as THREE.Vector3).copy(camera.position).normalize();
    U.uProbeFp.value = this.finestFp;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.probeRT);
    this.probeQuad.render(renderer);
    renderer.setRenderTarget(prev);
    this.probeBusy = true;
    const gen = this.probeGen;
    renderer
      .readRenderTargetPixelsAsync(this.probeRT, 0, 0, 1, 1, this.probeBuf)
      .then(() => {
        if (gen === this.probeGen && this.activeLevels > 0 && Number.isFinite(this.probeBuf[0])) this.probeRadius = this.probeBuf[0];
      })
      .catch(() => {})
      .finally(() => {
        this.probeBusy = false;
      });
  }

  dispose() {
    this.probeRT.dispose();
    this.probeMat.dispose();
    this.probeQuad.dispose();
    for (const r of this.rings) {
      r.mesh.geometry.dispose();
      (r.mesh.material as THREE.Material).dispose();
    }
  }
}
