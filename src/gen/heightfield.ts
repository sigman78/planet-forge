// Whole-cube height helpers: texel solid angles, area-weighted percentiles, sea-level shift and scaling,
// and a padded index map that addresses texels across face edges (used by erosion and flow routing).

import { dirToFace, faceToDir, sToTexel, texelToS, warp } from '../core/cube.ts';
import type { FaceCoord, Vec3 } from '../core/cube.ts';
import type { GenParams } from './params.ts';

/** Relative solid angle of each texel of a face (T×T, identical for all faces). Interior texels sum to 4π/6. */
export function texelAreaWeights(N: number): Float32Array {
  const T = N + 2;
  const w = new Float32Array(T * T);
  const ds = 2 / N;
  const k = (Math.PI / 4) * (Math.PI / 4) * ds * ds;
  for (let y = 0; y < T; y++) {
    const cv = warp(texelToS(y, N));
    for (let x = 0; x < T; x++) {
      const cu = warp(texelToS(x, N));
      const r2 = 1 + cu * cu + cv * cv;
      w[y * T + x] = (k * (1 + cu * cu) * (1 + cv * cv)) / (r2 * Math.sqrt(r2));
    }
  }
  return w;
}

/**
 * Area-weighted quantiles of the interior texels of a cube array (6·T·T), optionally restricted to a value range.
 * Uses a fine histogram; `qs` are in [0, 1]. Returns one value per quantile.
 */
export function weightedQuantiles(
  data: Float32Array, N: number, qs: number[], lo = -Infinity, hi = Infinity, areaW?: Float32Array,
): number[] {
  const T = N + 2;
  const w = areaW ?? texelAreaWeights(N);
  let mn = Infinity, mx = -Infinity;
  for (let f = 0; f < 6; f++)
    for (let y = 1; y <= N; y++) {
      const row = (f * T + y) * T;
      for (let x = 1; x <= N; x++) {
        const v = data[row + x];
        if (v < lo || v > hi) continue;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
  if (!(mx >= mn)) return qs.map(() => 0);
  if (mx === mn) return qs.map(() => mn);
  const B = 1 << 16;
  const hist = new Float64Array(B);
  const scale = (B - 1) / (mx - mn);
  let total = 0;
  for (let f = 0; f < 6; f++)
    for (let y = 1; y <= N; y++) {
      const row = (f * T + y) * T;
      const wrow = y * T;
      for (let x = 1; x <= N; x++) {
        const v = data[row + x];
        if (v < lo || v > hi) continue;
        const a = w[wrow + x];
        hist[Math.floor((v - mn) * scale)] += a;
        total += a;
      }
    }
  return qs.map((q) => {
    const target = Math.min(1, Math.max(0, q)) * total;
    let acc = 0;
    for (let b = 0; b < B; b++) {
      const h = hist[b];
      if (acc + h >= target) {
        const frac = h > 0 ? (target - acc) / h : 0;
        return mn + (b + frac) / scale;
      }
      acc += h;
    }
    return mx;
  });
}

/** Area fraction of interior texels with value < threshold. */
export function areaFractionBelow(data: Float32Array, N: number, threshold = 0, areaW?: Float32Array): number {
  const T = N + 2;
  const w = areaW ?? texelAreaWeights(N);
  let below = 0, total = 0;
  for (let f = 0; f < 6; f++)
    for (let y = 1; y <= N; y++)
      for (let x = 1; x <= N; x++) {
        const a = w[y * T + x];
        total += a;
        if (data[(f * T + y) * T + x] < threshold) below += a;
      }
  return below / total;
}

/** Shift heights so the area-weighted `coverage` percentile becomes exactly 0. Returns the shift subtracted. */
export function shiftToSeaLevel(height: Float32Array, N: number, coverage: number, areaW?: Float32Array): number {
  const [sea] = weightedQuantiles(height, N, [coverage], -Infinity, Infinity, areaW);
  for (let i = 0; i < height.length; i++) height[i] -= sea;
  return sea;
}

/**
 * Raw terrain (≈ km) -> metres relative to sea level. Sea level is the ocean-coverage percentile.
 * Land is scaled so its 99.99th percentile = maxElevation, sea floor so its 99.9th depth percentile = maxDepth.
 */
export function normalizeHeights(height: Float32Array, N: number, p: GenParams, areaW?: Float32Array): void {
  shiftToSeaLevel(height, N, p.oceanCoverage, areaW);
  const [landTop] = weightedQuantiles(height, N, [0.9999], 0, Infinity, areaW);
  const [deepest] = weightedQuantiles(height, N, [0.001], -Infinity, 0, areaW);
  const ls = landTop > 1e-6 ? p.maxElevation / landTop : 1000;
  const os = deepest < -1e-6 ? p.maxDepth / -deepest : 1000;
  for (let i = 0; i < height.length; i++) {
    const v = height[i];
    height[i] = v > 0 ? v * ls : v * os;
  }
}

/**
 * Padded neighbour map: for each face, a (N+2P)² grid of texel coordinates [1-P, N+P] whose entries are the
 * canonical index (face·T + y)·T + x of the *interior* texel owning that direction (nearest texel).
 * Lets stencils and droplets read/write across face edges without branching.
 */
export interface PadMap {
  N: number;
  T: number;
  P: number;
  W: number;
  map: Int32Array;
}

export function buildPadMap(N: number, P: number): PadMap {
  const T = N + 2;
  const W = N + 2 * P;
  const map = new Int32Array(6 * W * W);
  const d: Vec3 = [0, 0, 0];
  const fc: FaceCoord = { face: 0, s: 0, t: 0 };
  for (let f = 0; f < 6; f++) {
    for (let ay = 0; ay < W; ay++) {
      const y = ay - P + 1;
      for (let ax = 0; ax < W; ax++) {
        const x = ax - P + 1;
        let idx: number;
        if (x >= 1 && x <= N && y >= 1 && y <= N) {
          idx = (f * T + y) * T + x;
        } else {
          faceToDir(f, texelToS(x, N), texelToS(y, N), d);
          dirToFace(d[0], d[1], d[2], fc);
          const px = Math.min(N, Math.max(1, Math.round(sToTexel(fc.s, N))));
          const py = Math.min(N, Math.max(1, Math.round(sToTexel(fc.t, N))));
          idx = (fc.face * T + py) * T + px;
        }
        map[(f * W + ay) * W + ax] = idx;
      }
    }
  }
  return { N, T, P, W, map };
}

/** Padded-map slot of interior texel (f, x, y) (x, y may be in [1-P, N+P]). */
export function padIndex(pm: PadMap, f: number, x: number, y: number): number {
  return (f * pm.W + (y + pm.P - 1)) * pm.W + (x + pm.P - 1);
}

/** Copy one face (T×T) out of a cube array. */
export function faceSlice<A extends Float32Array | Uint8Array>(data: A, N: number, face: number, channels = 1): A {
  const T = N + 2;
  const n = T * T * channels;
  return data.slice(face * n, face * n + n) as A;
}
