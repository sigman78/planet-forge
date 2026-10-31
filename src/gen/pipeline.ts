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
import { Noise3, Rng, smoothstep } from './noise.ts';
import { resolveParams } from './params.ts';
import type { GenParams } from './params.ts';
import { generateSurfaceFace } from './surface.ts';
import type { SurfaceFaceOutput } from './surface.ts';
import { capBox, generateTerrainFace, prepareTerrain, VK } from './terrain.ts';
import type { FaceTerrain, TerrainContext } from './terrain.ts';
import { buildInfo, CRATER_STRIDE, planWorld, windAt, windWarp } from './world.ts';
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
  /** Non-spherical figure (m), from the terrain stage. */
  figure: Float32Array;
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

/**
 * Wind streaks: tapered plumes downwind of obstacles (fresh craters, rises, volcanoes), bright where dust settles
 * in the lee or dark where the wind strips it. Written into aux channel 3 as 128 +- v (0 = none). Returns the
 * number of obstacles that got one.
 */
function stampWindStreaks(plan: WorldPlan, N: number, aux: Uint8Array, n: Noise3): number {
  const T = N + 2;
  const wind = plan.wind;
  const rng = new Rng(plan.p.seed, 31);
  const texel = 1.6 / N;
  type Ob = { x: number; y: number; z: number; r: number; k: number };
  const obs: Ob[] = [];
  const addCraters = (C: Float64Array, maxDeg: number) => {
    for (let o = 0; o < C.length; o += CRATER_STRIDE) {
      if (C[o + 7] === 4 || C[o + 8] > maxDeg || C[o + 3] < 3 * texel) continue;
      obs.push({ x: C[o], y: C[o + 1], z: C[o + 2], r: C[o + 3], k: 1 });
    }
  };
  addCraters(plan.youngCraters, 0.5);
  addCraters(plan.oldCraters, 0.35);
  for (const r of plan.rises) obs.push({ x: r.x, y: r.y, z: r.z, r: r.r * 0.5, k: 0.7 });
  for (const v of plan.volcanoes) obs.push({ x: v.x, y: v.y, z: v.z, r: v.r * 0.6, k: 1 });
  obs.sort((a, b) => b.r - a.r);
  if (obs.length > 350) obs.length = 350;
  const W: Vec3 = [0, 0, 0], d: Vec3 = [0, 0, 0];
  const box = { x0: 0, x1: 0, y0: 0, y1: 0 };
  const scale = Math.min(1, wind.strength);
  let count = 0;
  for (const ob of obs) {
    const len = 3.5 + 4.5 * rng.next();
    const sign = wind.sign;
    const amp = scale * ob.k * (0.6 + 0.4 * rng.next());
    windAt(wind, n, ob.x, ob.y, ob.z, W);
    // Across-wind tangent.
    const tx = ob.y * W[2] - ob.z * W[1], ty = ob.z * W[0] - ob.x * W[2], tz = ob.x * W[1] - ob.y * W[0];
    const R = ob.r, L = R * len, fr = 2.5 / R;
    // Cap around the plume's middle, not the obstacle: the box is a fraction of the one around the obstacle.
    const mx = ob.x + W[0] * L * 0.5, my = ob.y + W[1] * L * 0.5, mz = ob.z + W[2] * L * 0.5;
    const ml = 1 / Math.hypot(mx, my, mz);
    let wrote = false;
    for (let f = 0; f < 6; f++) {
      if (!capBox(f, N, mx * ml, my * ml, mz * ml, L * 0.5 + 1.8 * R, box)) continue;
      for (let y = box.y0; y <= box.y1; y++) {
        for (let x = box.x0; x <= box.x1; x++) {
          faceToDir(f, texelToS(x, N), texelToS(y, N), d);
          const rx = d[0] - ob.x, ry = d[1] - ob.y, rz = d[2] - ob.z;
          const s = rx * W[0] + ry * W[1] + rz * W[2];
          if (s < 0.8 * R || s > L) continue;
          const u = rx * tx + ry * ty + rz * tz;
          const hw0 = R * (0.6 + 0.12 * (s / R));
          if (Math.abs(u) > 1.6 * hw0) continue;
          // Half-width grows slowly downwind; the edges are ragged; the plume fades along a soft tail.
          const hw = hw0 * (1 + 0.3 * n.simplex(d[0] * fr, d[1] * fr, d[2] * fr));
          const across = Math.exp((-2.5 * u * u) / (hw * hw));
          if (across < 0.05) continue;
          const head = smoothstep(0.8 * R, 1.6 * R, s);
          const tail = Math.pow(1 - Math.max(0, (s - 1.4 * R) / (L - 1.4 * R)), 1.4);
          const tex = 0.75 + 0.25 * n.fbm(d[0] * fr * 2.4, d[1] * fr * 2.4, d[2] * fr * 2.4, 2);
          const v = Math.round(127 * amp * across * head * tail * tex);
          if (v < 4) continue;
          const i = ((f * T + y) * T + x) * 4 + 3;
          const cur = aux[i];
          const ex = cur === 0 ? 0 : cur - 128;
          if (v > Math.abs(ex)) { aux[i] = 128 + sign * v; wrote = true; }
        }
      }
    }
    if (wrote) count++;
  }
  return count;
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
  // --- feature limit: soft-compress stacked feature relief (rise + shield + dichotomy + basins). Scales with the
  // wildness cap factor and the relief slider: +7.5% / -5.5% of R at capK·relief = 1, at most +20% / -17%. ---
  const Rm = plan.bulk.radiusKm * 1000;
  {
    const L = plan.capK * plan.relief;
    const Lu = Math.min(L, 0.2 / 0.075), Ld = Math.min(L, 0.17 / 0.055);
    const kUp = 0.045 * Lu * Rm, cUp = 0.03 * Lu * Rm, kDn = -0.035 * Ld * Rm, cDn = 0.02 * Ld * Rm;
    for (let i = 0; i < total; i++) {
      const v = h[i];
      if (v > kUp) { const e = v - kUp; h[i] = kUp + (cUp * e) / (e + cUp); }
      else if (v < kDn) { const e = kDn - v; h[i] = kDn - (cDn * e) / (e + cDn); }
    }
  }
  timings.flood = now() - t0;

  // --- figure: triaxial stretch + lumps on top of the (limited) features; seas and the datum see the total ---
  for (let i = 0; i < total; i++) h[i] += inp.figure[i];
  if (pre) for (let i = 0; i < total; i++) pre[i] += inp.figure[i];

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
    // Lp is on the figure-included topography; the flood level Lf is not (the maria follow the figure).
    level = Lp - (Number.isFinite(Lf) ? 120 * plan.relief : 0);
    const deep = 1500 * plan.relief;
    for (let i = 0; i < total; i++) {
      if (pre[i] < Lp) h[i] = Math.min(h[i], level - 25 * plan.relief - 200 * plan.relief * smoothstep(Lp, Lp - deep, pre[i]));
      else if (h[i] < level + 20) h[i] = level + 20;
    }
  } else level = solveLevel();
  // Lava lakes sit in the patera calderas. Calderas high above the lava level (on edifices or figure highs) are not
  // dragged down to it (that dug 1-texel shafts tens of km deep); the forcing fades out 2.5–5 km·relief above it.
  if (seaKind === 'lava') {
    const tgt = level - 250 * plan.relief, d0 = 2500 * plan.relief, d1 = 5000 * plan.relief;
    for (let i = 0; i < total; i++) {
      if (inp.vkind[i] !== VK.CALDERA || h[i] <= tgt) continue;
      h[i] -= (h[i] - tgt) * smoothstep(d1, d0, h[i] - tgt);
    }
  }

  // --- dunes: sand seas in the lowlands (needs wind) ---
  if (plan.s.dunes > 0.01) {
    const [qLow, qMid] = weightedQuantiles(h, N, [0.2, 0.5], -Infinity, Infinity, areaW);
    const amp = 120 * plan.s.dunes * plan.relief * plan.gRel;
    const df = N * 0.16;
    const wind = plan.wind, wa = wind.axis, wq: Vec3 = [0, 0, 0];
    for (let i = 0; i < total; i++) {
      const v = h[i];
      if (v > qMid || (hasSea && v < level + 10)) continue;
      const q = dirOf(i);
      const erg = smoothstep(0.02, 0.22, n.fbm(q[0] * 3.1 + 70.3, q[1] * 3.1 - 1.1, q[2] * 3.1 + 5.5, 3) + 0.15 * (plan.s.dunes - 1))
        * smoothstep(qMid, qLow, v);
      if (erg < 0.02) continue;
      // Transverse ridges, crests across the prevailing wind: the ridged noise is compressed along the wind axis in
      // the wind-warped domain, so the crests follow the meridians of that axis and wander where the flow wanders.
      windWarp(wind, n, q[0], q[1], q[2], wq);
      const wd = 0.7 * (wq[0] * wa[0] + wq[1] * wa[1] + wq[2] * wa[2]);
      const r = n.ridged((wq[0] - wd * wa[0]) * df, (wq[1] - wd * wa[1]) * df, (wq[2] - wd * wa[2]) * df, 2, 1.8);
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
  // Renderer contract: the displaced cube sphere stays star-shaped well inside ±25% of R. Smooth clamp beyond
  // ±20% (asymptote ±24.5%), after the datum shift so the stats see it. Sea texels (h < 0, ≥ −20% R) are untouched.
  const kC = 0.2 * Rm, cC = 0.045 * Rm;
  for (let i = 0; i < total; i++) {
    const v = h[i] - level;
    if (v > kC) { const e = v - kC; h[i] = kC + (cC * e) / (e + cC); }
    else if (v < -kC) { const e = -kC - v; h[i] = -kC - (cC * e) / (e + cC); }
    else h[i] = v;
  }
  refillGutters(h, N);

  // --- flow routing, river wetness, closed-basin deposits ---
  const { acc, fill } = flowAccumulation(h, N, pm, hasSea ? 0 : -Infinity);
  const { flow01, wet01 } = flowToWetness(acc, N, pm, fill);
  // Closed-basin deposits need a carrier: running fluids (playas), frost (icy / cryo) or sulfur plumes.
  const deposits = plan.s.erosion > 0 || plan.icy || plan.archetype === 'sulfur' || plan.arch.family === 'cryovolcanic';
  if (plan.s.salt > 0.01 && deposits) {
    // Evaporites / frost deposits: only the deepest pockets of closed basins, broken into patches, and capped by
    // area (a giant basin floor is one huge closed depression; it must not turn into one salt pan).
    const depth0 = 500 * plan.relief * plan.gRel;
    const target = Math.min(0.035, 0.02 * plan.s.salt); // area fraction before patchiness (which removes ~half)
    const [fq] = weightedQuantiles(fill, N, [1 - target], -Infinity, Infinity, areaW);
    const f0 = Math.max(depth0, fq), f1 = f0 + Math.max(depth0, 0.5 * f0);
    for (let i = 0; i < total; i++) {
      if ((hasSea && h[i] < 0) || fill[i] <= f0) continue;
      const q = dirOf(i);
      const patch = smoothstep(-0.15, 0.25, n.fbm(q[0] * 14 + 9.1, q[1] * 14 - 4.2, q[2] * 14 + 2.7, 3));
      const pl = smoothstep(f0, f1, fill[i]) * patch * Math.min(1, plan.s.salt);
      if (pl > 0.02) aux[i * 4 + 2] = Math.round(255 * pl);
    }
  }
  // Pointwise masks are already consistent in the gutters except where erosion moved heights; refresh the
  // flood/dune/playa/streak channels' gutters with nearest-texel copies.
  const streakCount = plan.wind.strength > 0 ? stampWindStreaks(plan, N, aux, n) : 0;
  for (let c = 0; c < 4; c++) refillGuttersNearest(aux, N, 4, c);
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
    streakCount,
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
    figure: assembleCube(faces.map((f) => f.figure), (k) => new Float32Array(k)),
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
