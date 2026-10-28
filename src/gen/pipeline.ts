// Pure generation stages shared by the worker pool (index.ts / worker.ts), the main-thread fallback and the CLI.
// No DOM or worker APIs here.
//
//   plan (bulk + history features, cheap, every worker rebuilds it)
//   -> terrain per face (parallel)
//   -> cube stage (one worker): flood basalts, young craters, sea level, dunes, erosion, datum, flow, playas
//   -> surface per face (parallel): temperature, units, splat
//   -> gutters refilled, info (bulk, history, units, look)

import { faceToDir, refillGutters, sToTexel, dirToFace, texelToS } from '../core/cube.ts';
import type { FaceCoord, Vec3 } from '../core/cube.ts';
import type { PlanetData } from '../core/types.ts';
import { erodeCube, flowAccumulation, flowToWetness } from './erosion.ts';
import { buildPadMap, faceSlice, texelAreaWeights, weightedQuantiles } from './heightfield.ts';
import { Noise3, smoothstep } from './noise.ts';
import { resolveParams } from './params.ts';
import type { GenParams } from './params.ts';
import { generateSurfaceFace } from './surface.ts';
import type { SurfaceFaceOutput } from './surface.ts';
import { generateTerrainFace, prepareTerrain, VK } from './terrain.ts';
import type { FaceTerrain, TerrainContext } from './terrain.ts';
import { buildInfo, planWorld } from './world.ts';
import type { SurfaceStats, WorldPlan } from './world.ts';

export type ProgressFn = (stage: string, frac: number) => void;

// ---- plan / terrain context (memoised per parameter set) ---------------------------------------------

let _key = '';
let _plan: WorldPlan | null = null;
let _tctx: TerrainContext | null = null;

export function worldPlan(p: GenParams): WorldPlan {
  const key = JSON.stringify(p);
  if (_plan && key === _key) return _plan;
  _plan = planWorld(p);
  _tctx = null;
  _key = key;
  return _plan;
}

function terrainCtx(p: GenParams): TerrainContext {
  const plan = worldPlan(p);
  if (!_tctx) _tctx = prepareTerrain(plan);
  return _tctx;
}

// ---- stage 1: terrain per face ----------------------------------------------------------------------

export function stageTerrainFace(p: GenParams, face: number): FaceTerrain {
  return generateTerrainFace(terrainCtx(p), face);
}

/** Concatenate six per-face arrays into one cube array (face order 0..5). */
export function assembleCube<A extends Float32Array | Uint8Array>(faces: A[], make: (n: number) => A): A {
  const n = faces[0].length;
  const out = make(n * 6);
  for (let f = 0; f < 6; f++) out.set(faces[f], f * n);
  return out;
}

// ---- stage 2: whole cube ------------------------------------------------------------------------------

export interface CubeStageInput {
  height: Float32Array;
  young: Float32Array;
  vkind: Uint8Array;
}

export interface CubeStageOutput {
  /** Metres relative to datum (sea level, or the mean radius when there is no sea), gutters refilled. */
  height: Float32Array;
  flow: Float32Array;
  wet: Float32Array;
  /** RGBA8 cube: R flood basalt, G dunes, B closed-basin deposits. */
  aux: Uint8Array;
  stats: SurfaceStats;
  timings: Record<string, number>;
}

/** Sea level for a global equivalent layer `gel` (m): Σ area·(L − h)+ = gel·4π (area in steradians). */
export function solveSeaLevelByVolume(h: Float32Array, N: number, gel: number, areaW: Float32Array): number {
  const T = N + 2;
  let lo = Infinity, hi = -Infinity;
  for (let f = 0; f < 6; f++)
    for (let y = 1; y <= N; y++)
      for (let x = 1; x <= N; x++) { const v = h[(f * T + y) * T + x]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const target = gel * 4 * Math.PI;
  hi += gel;
  for (let it = 0; it < 40; it++) {
    const L = (lo + hi) / 2;
    let vol = 0;
    for (let f = 0; f < 6; f++)
      for (let y = 1; y <= N; y++) {
        const row = (f * T + y) * T, wr = y * T;
        for (let x = 1; x <= N; x++) { const dd = L - h[row + x]; if (dd > 0) vol += dd * areaW[wr + x]; }
      }
    if (vol > target) hi = L; else lo = L;
  }
  return (lo + hi) / 2;
}

function areaMean(h: Float32Array, N: number, areaW: Float32Array): number {
  const T = N + 2;
  let s = 0, a = 0;
  for (let f = 0; f < 6; f++)
    for (let y = 1; y <= N; y++)
      for (let x = 1; x <= N; x++) { const w = areaW[y * T + x]; s += h[(f * T + y) * T + x] * w; a += w; }
  return s / a;
}

function maskCoverage(mask: Uint8Array, N: number, ch: number, areaW: Float32Array): number {
  const T = N + 2;
  let s = 0, a = 0;
  for (let f = 0; f < 6; f++)
    for (let y = 1; y <= N; y++)
      for (let x = 1; x <= N; x++) { const w = areaW[y * T + x]; a += w; if (mask[((f * T + y) * T + x) * 4 + ch] > 127) s += w; }
  return s / a;
}

/** Takes ownership of the input arrays. */
export function stageCube(inp: CubeStageInput, p: GenParams, onProgress?: ProgressFn): CubeStageOutput {
  const plan = worldPlan(p);
  const N = p.resolution;
  const T = N + 2;
  const TT = T * T;
  const timings: Record<string, number> = {};
  const areaW = texelAreaWeights(N);
  const h = inp.height;
  const total = h.length;
  const aux = new Uint8Array(total * 4);
  const n = new Noise3(p.seed ^ 0xf100d);
  const d: Vec3 = [0, 0, 0];
  const dirOf = (i: number) => {
    const f = Math.floor(i / TT), r = i - f * TT, y = Math.floor(r / T), x = r - y * T;
    faceToDir(f, texelToS(x, N), texelToS(y, N), d);
    return d;
  };
  let t0 = now();

  // Lava seas are defined on the pre-flood topography (smooth basin contours) and sit just below the flood plains.
  const lavaSea = plan.bulk.seaKind === 'lava' && plan.seaMode !== 'none';
  const pre = lavaSea ? h.slice() : null;
  let Lf = -Infinity;
  // --- flood basalts: fill the low basins up to an area percentile, with wrinkle ridges ---
  if (plan.s.floodLevel > 0.002) {
    [Lf] = weightedQuantiles(h, N, [plan.s.floodLevel], -Infinity, Infinity, areaW);
    const wrAmp = 160 * plan.relief * plan.gRel;
    const k = 120 * plan.relief;
    const wrW = Math.max(0.15, 1.2 * (Math.PI / 2 / N) * 22 * 1.6);
    for (let i = 0; i < total; i++) {
      const v = h[i];
      if (v > Lf + 4 * k || inp.vkind[i] === VK.CALDERA) continue;
      const q = dirOf(i);
      // Wrinkle ridges: smooth gaussian crests along the zero set of a noise field, never thinner than ~2 texels.
      const sv = n.simplex(q[0] * 22, q[1] * 22, q[2] * 22) + 0.25 * n.simplex(q[0] * 50 + 3, q[1] * 50, q[2] * 50);
      const wr = wrAmp * Math.exp(-((sv / wrW) ** 2));
      const level = Lf + wr;
      // Smooth max: lava ponds up to the level, shores blend.
      const hh = 0.5 * (v + level + Math.sqrt((v - level) * (v - level) + k * k));
      aux[i * 4] = Math.round(255 * smoothstep(Lf + 1.5 * k, Lf - 0.5 * k, v));
      h[i] = hh;
    }
  }
  // --- young craters on top of the maria ---
  for (let i = 0; i < total; i++) h[i] += inp.young[i];
  // --- figure limit: soft-compress stacked relief (rise + shield + dichotomy): at most +7.5% / -5.5% of the radius about the mean ---
  {
    const Rm = plan.bulk.radiusKm * 1000;
    const kUp = 0.045 * Rm, cUp = 0.03 * Rm, kDn = -0.035 * Rm, cDn = 0.02 * Rm;
    for (let i = 0; i < total; i++) {
      const v = h[i];
      if (v > kUp) { const e = v - kUp; h[i] = kUp + (cUp * e) / (e + cUp); }
      else if (v < kDn) { const e = kDn - v; h[i] = kDn - (cDn * e) / (e + cDn); }
    }
  }
  timings.flood = now() - t0;

  // --- sea level ---
  t0 = now();
  const seaKind = plan.bulk.seaKind;
  const hasSea = plan.seaMode !== 'none';
  const solveLevel = () => (plan.seaMode === 'coverage'
    ? weightedQuantiles(h, N, [plan.seaValue], -Infinity, Infinity, areaW)[0]
    : plan.seaMode === 'volume' ? solveSeaLevelByVolume(h, N, plan.seaValue, areaW) : areaMean(h, N, areaW));
  let level: number;
  if (pre) {
    // Lava sea: the lowest pre-flood basins (coverage), ponded flat just below the flood plains, crisp shores.
    const cov = plan.seaMode === 'coverage' ? plan.seaValue : 0.03;
    const floodCov = plan.s.floodLevel > 0.002 ? plan.s.floodLevel : 1;
    const [Lp] = weightedQuantiles(pre, N, [Math.min(cov, 0.8 * floodCov)], -Infinity, Infinity, areaW);
    level = Number.isFinite(Lf) ? Math.min(Lf, Lp) - 120 * plan.relief : Lp;
    const deep = 1500 * plan.relief;
    for (let i = 0; i < total; i++) {
      if (pre[i] < Lp) h[i] = Math.min(h[i], level - 25 * plan.relief - 200 * plan.relief * smoothstep(Lp, Lp - deep, pre[i]));
      else if (h[i] < level + 20) h[i] = level + 20;
    }
  } else level = solveLevel();
  // Lava lakes sit in the patera calderas.
  if (seaKind === 'lava') for (let i = 0; i < total; i++) if (inp.vkind[i] === VK.CALDERA) h[i] = Math.min(h[i], level - 250 * plan.relief);

  // --- dunes: sand seas in the lowlands (needs wind) ---
  if (plan.s.dunes > 0.01) {
    const [qLow, qMid] = weightedQuantiles(h, N, [0.2, 0.5], -Infinity, Infinity, areaW);
    const amp = 120 * plan.s.dunes * plan.relief * plan.gRel;
    const df = N * 0.16;
    for (let i = 0; i < total; i++) {
      const v = h[i];
      if (v > qMid || (hasSea && v < level + 10)) continue;
      const q = dirOf(i);
      const erg = smoothstep(0.02, 0.22, n.fbm(q[0] * 3.1 + 70.3, q[1] * 3.1 - 1.1, q[2] * 3.1 + 5.5, 3) + 0.15 * (plan.s.dunes - 1))
        * smoothstep(qMid, qLow, v);
      if (erg < 0.02) continue;
      // Transverse ridges, crests roughly north-south.
      const r = n.ridged(q[0] * df, q[1] * df * 0.3, q[2] * df, 2, 1.8);
      h[i] += amp * erg * r;
      aux[i * 4 + 1] = Math.round(255 * smoothstep(0.1, 0.5, erg));
    }
  }
  timings.seaLevel = now() - t0;

  // --- erosion: fluvial / outflow / lava-channel droplets + talus ---
  t0 = now();
  const pm = buildPadMap(N, 4);
  const droplets = plan.s.erosion > 0 ? p.erosionDroplets * plan.s.erosion : 0;
  let dropCount = 0;
  if (droplets > 0 || p.thermalIterations > 0) {
    dropCount = erodeCube(h, N, {
      seed: p.seed, radius: plan.bulk.radiusKm * 1000, droplets, erosionRate: p.erosionRate, depositionRate: p.depositionRate,
      inertia: p.inertia, evaporation: p.evaporation, capacity: p.capacity, brushRadius: p.brushRadius,
      thermalIterations: p.thermalIterations, talusAngle: p.talusAngle, seaLevel: hasSea ? level : -Infinity,
    }, onProgress ? (fr) => onProgress('erosion', fr) : undefined, pm);
  }
  timings.erosion = now() - t0;

  // --- datum: sea level (exact coverage / volume) or the mean radius ---
  t0 = now();
  if (!pre) level = solveLevel();
  for (let i = 0; i < total; i++) h[i] -= level;
  refillGutters(h, N);

  // --- flow routing, river wetness, closed-basin deposits ---
  const { acc, fill } = flowAccumulation(h, N, pm, hasSea ? 0 : -Infinity);
  const { flow01, wet01 } = flowToWetness(acc, N, pm);
  // Closed-basin deposits need a carrier: running fluids (playas), frost (icy / cryo) or sulfur plumes.
  const deposits = plan.s.erosion > 0 || plan.icy || plan.archetype === 'sulfur' || plan.arch.family === 'cryovolcanic';
  if (plan.s.salt > 0.01 && deposits) {
    // Only the floors of deep closed basins (on tiny high-relief bodies shallow closed depressions are everywhere).
    const depth0 = 500 * plan.relief * plan.gRel, depth1 = 1400 * plan.relief * plan.gRel;
    for (let i = 0; i < total; i++) {
      if (hasSea && h[i] < 0) continue;
      const pl = smoothstep(depth0, depth1, fill[i]) * Math.min(1, plan.s.salt);
      if (pl > 0.02) aux[i * 4 + 2] = Math.round(255 * pl);
    }
  }
  // Pointwise masks are already consistent in the gutters except where erosion moved heights; refresh the
  // flood/dune/playa channels' gutters with nearest-texel copies.
  for (let c = 0; c < 3; c++) refillGuttersNearest(aux, N, 4, c);
  timings.flow = now() - t0;

  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < total; i++) { const v = h[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  const capFrac = (lat: number) => (lat >= Math.PI / 2 ? 0 : (1 - Math.sin(lat)) / 2);
  const stats: SurfaceStats = {
    seaCoverage: hasSea ? areaFracBelow0(h, N, areaW) : 0,
    seaGEL: hasSea ? seaGEL(h, N, areaW) : 0,
    floodCoverage: maskCoverage(aux, N, 0, areaW),
    duneCoverage: maskCoverage(aux, N, 1, areaW),
    playaCoverage: maskCoverage(aux, N, 2, areaW),
    capCoverage: (capFrac(plan.capLat[0]) + capFrac(plan.capLat[1])) / 2,
    minHeight: mn,
    maxHeight: mx,
    droplets: dropCount,
  };
  return { height: h, flow: flow01, wet: wet01, aux, stats, timings };
}

function areaFracBelow0(h: Float32Array, N: number, areaW: Float32Array): number {
  const T = N + 2;
  let s = 0, a = 0;
  for (let f = 0; f < 6; f++)
    for (let y = 1; y <= N; y++)
      for (let x = 1; x <= N; x++) { const w = areaW[y * T + x]; a += w; if (h[(f * T + y) * T + x] < 0) s += w; }
  return s / a;
}

function seaGEL(h: Float32Array, N: number, areaW: Float32Array): number {
  const T = N + 2;
  let v = 0;
  for (let f = 0; f < 6; f++)
    for (let y = 1; y <= N; y++)
      for (let x = 1; x <= N; x++) { const z = h[(f * T + y) * T + x]; if (z < 0) v -= z * areaW[y * T + x]; }
  return v / (4 * Math.PI);
}

// ---- stage 3: surface per face --------------------------------------------------------------------------

export interface SurfaceSlices {
  height: Float32Array; featA: Uint8Array; featB: Uint8Array; vkind: Uint8Array; aux: Uint8Array; flow: Float32Array; wet: Float32Array;
}

export function stageSurfaceFace(p: GenParams, face: number, s: SurfaceSlices): SurfaceFaceOutput {
  return generateSurfaceFace(worldPlan(p), { face, N: p.resolution, ...s });
}

/** Slices one face's inputs for the surface stage out of the cube arrays. */
export function surfaceSlices(N: number, face: number, cube: CubeStageOutput, featA: Uint8Array, featB: Uint8Array, vkind: Uint8Array): SurfaceSlices {
  return {
    height: faceSlice(cube.height, N, face), featA: faceSlice(featA, N, face, 4), featB: faceSlice(featB, N, face, 4),
    vkind: faceSlice(vkind, N, face), aux: faceSlice(cube.aux, N, face, 4), flow: faceSlice(cube.flow, N, face), wet: faceSlice(cube.wet, N, face),
  };
}

/**
 * After assembling per-face outputs: refill gutters so GPU bilinear filtering is seamless.
 * Splat and climate R/G/B are bilinear; the unit id (climate A) uses the nearest texel.
 */
export function finalizeSurface(splat0: Uint8Array, splat1: Uint8Array, climate: Uint8Array, N: number): void {
  for (let c = 0; c < 4; c++) {
    refillGutters(splat0, N, 4, c);
    refillGutters(splat1, N, 4, c);
  }
  for (let c = 0; c < 3; c++) refillGutters(climate, N, 4, c);
  refillGuttersNearest(climate, N, 4, 3);
}

/** Like `refillGutters`, but copies the nearest interior texel (for categorical data such as unit ids). */
export function refillGuttersNearest(data: Uint8Array | Float32Array, N: number, channels = 1, channel = 0): void {
  const T = N + 2;
  const d: Vec3 = [0, 0, 0];
  const fc: FaceCoord = { face: 0, s: 0, t: 0 };
  for (let f = 0; f < 6; f++)
    for (let y = 0; y < T; y++)
      for (let x = 0; x < T; x++) {
        if (x !== 0 && y !== 0 && x !== T - 1 && y !== T - 1) continue;
        faceToDir(f, texelToS(x, N), texelToS(y, N), d);
        dirToFace(d[0], d[1], d[2], fc);
        const px = Math.min(N, Math.max(1, Math.round(sToTexel(fc.s, N))));
        const py = Math.min(N, Math.max(1, Math.round(sToTexel(fc.t, N))));
        data[((f * T + y) * T + x) * channels + channel] = data[((fc.face * T + py) * T + px) * channels + channel];
      }
}

// ---- drivers ------------------------------------------------------------------------------------------------

/**
 * The whole pipeline as a generator that yields between stages (so an async driver can stay responsive and
 * honour aborts). Returns the PlanetData.
 */
export function* pipelineSteps(params: Partial<GenParams>, onProgress?: ProgressFn): Generator<string, PlanetData> {
  const p = resolveParams(params);
  const N = p.resolution;
  const T = N + 2;
  const timings: Record<string, number> = {};
  const tAll = now();
  let t0 = now();
  const plan = worldPlan(p);
  timings.plan = now() - t0;
  yield 'plan';

  t0 = now();
  const faces: FaceTerrain[] = [];
  for (let f = 0; f < 6; f++) {
    faces.push(stageTerrainFace(p, f));
    onProgress?.('terrain', (f + 1) / 6);
    yield 'terrain';
  }
  const featA = assembleCube(faces.map((f) => f.featA), (k) => new Uint8Array(k));
  const featB = assembleCube(faces.map((f) => f.featB), (k) => new Uint8Array(k));
  const vkind = assembleCube(faces.map((f) => f.vkind), (k) => new Uint8Array(k));
  const cubeIn: CubeStageInput = {
    height: assembleCube(faces.map((f) => f.height), (k) => new Float32Array(k)),
    young: assembleCube(faces.map((f) => f.young), (k) => new Float32Array(k)),
    vkind,
  };
  timings.terrain = now() - t0;

  const cube = stageCube(cubeIn, p, onProgress);
  Object.assign(timings, cube.timings);
  yield 'cube';

  t0 = now();
  const splat0 = new Uint8Array(6 * T * T * 4);
  const splat1 = new Uint8Array(6 * T * T * 4);
  const climate = new Uint8Array(6 * T * T * 4);
  for (let f = 0; f < 6; f++) {
    const r = stageSurfaceFace(p, f, surfaceSlices(N, f, cube, featA, featB, vkind));
    splat0.set(r.splat0, f * T * T * 4);
    splat1.set(r.splat1, f * T * T * 4);
    climate.set(r.climate, f * T * T * 4);
    onProgress?.('surface', (f + 1) / 6);
    yield 'surface';
  }
  finalizeSurface(splat0, splat1, climate, N);
  timings.surface = now() - t0;
  timings.total = now() - tAll;
  return assemblePlanet(p, plan, cube, splat0, splat1, climate, timings);
}

export function assemblePlanet(p: GenParams, plan: WorldPlan, cube: CubeStageOutput, splat0: Uint8Array, splat1: Uint8Array, climate: Uint8Array,
  timings: Record<string, number>): PlanetData {
  const N = p.resolution;
  return {
    N, T: N + 2, radius: plan.bulk.radiusKm * 1000, height: cube.height, minHeight: cube.stats.minHeight, maxHeight: cube.stats.maxHeight,
    splat0, splat1, climate, info: buildInfo(plan, cube.stats), timings,
  };
}

/** Runs every stage on the calling thread (CLI, tests). */
export function generatePlanetSync(params: Partial<GenParams>, onProgress?: ProgressFn): PlanetData {
  const it = pipelineSteps(params, onProgress);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

export function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
