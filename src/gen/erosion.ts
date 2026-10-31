// Whole-cube erosion: droplet hydraulic erosion, thermal (talus) relaxation, and flow accumulation.
//
// Droplets walk in face-local texel coordinates. Every read and write goes through a padded index map whose
// out-of-face entries point at the neighbouring face's interior texels, and a droplet that leaves its face is
// re-projected onto the neighbour through its 3D direction (faceToDir -> dirToFace). The result is seamless
// across face edges without per-step trigonometry. Call `refillGutters` afterwards.

import { dirToFace, faceToDir, FACE_BASIS, sToTexel, texelToS, unwarp, refillGutters } from '../core/cube.ts';
import type { FaceCoord, Vec3 } from '../core/cube.ts';
import { buildPadMap, texelAreaWeights } from './heightfield.ts';
import type { PadMap } from './heightfield.ts';
import { Rng } from './noise.ts';

/** Erosion height unit: metres -> units where 1 = UNIT_PER_SLOPE⁻¹ of a 45° slope over one texel. */
const UNIT_PER_SLOPE = 0.05;

/** Erosion settings (derived from GenParams + the world plan by the pipeline). */
export interface ErosionSettings {
  seed: number;
  radius: number;
  /** Droplets per land texel (0 = no hydraulic erosion). */
  droplets: number;
  erosionRate: number;
  depositionRate: number;
  inertia: number;
  evaporation: number;
  capacity: number;
  brushRadius: number;
  thermalIterations: number;
  talusAngle: number;
  /** Droplets that reach this level stop and drop their load (-Infinity = no sea). */
  seaLevel: number;
}

/** Mean texel edge length in metres. */
export function texelMeters(N: number, radius: number): number {
  return ((Math.PI / 2) / N) * radius;
}

/** Hydraulic + thermal erosion in place (height in metres, sea level 0). Gutters are refilled at the end. */
export function erodeCube(
  height: Float32Array, N: number, p: ErosionSettings, onProgress?: (frac: number) => void, padMap?: PadMap,
): number {
  const pm = padMap ?? buildPadMap(N, 4);
  let droplets = 0;
  if (p.droplets > 0) droplets = hydraulicErosion(height, pm, p, onProgress);
  if (p.thermalIterations > 0) thermalErosion(height, pm, p);
  refillGutters(height, N);
  return droplets;
}

function hydraulicErosion(H: Float32Array, pm: PadMap, p: ErosionSettings, onProgress?: (frac: number) => void): number {
  const { N, T, P, W, map } = pm;
  const tm = texelMeters(N, p.radius);
  const k = UNIT_PER_SLOPE / tm;
  const sea0 = p.seaLevel;
  // Work relative to the sea level so "below 0" means "in the sea".
  const off = Number.isFinite(sea0) ? sea0 : 0;
  for (let i = 0; i < H.length; i++) H[i] = (H[i] - off) * k;
  const seaK = Number.isFinite(sea0) ? 0 : -Infinity;

  // Count land texels to size the droplet budget.
  let land = 0;
  for (let f = 0; f < 6; f++)
    for (let y = 1; y <= N; y++)
      for (let x = 1; x <= N; x++) if (H[(f * T + y) * T + x] > seaK) land++;
  // Droplet paths lengthen with N (maxLife ~ N/6), so the per-texel density falls as (256/N)^1.5 to keep N=512 fast.
  const count = Math.floor(p.droplets * land * Math.min(1, Math.pow(256 / N, 1.5)));

  // Brush offsets & weights.
  const r = p.brushRadius;
  const bx: number[] = [], by: number[] = [], bw: number[] = [];
  let wsum = 0;
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < r + 0.5) {
        const w = r + 0.5 - d;
        bx.push(dx); by.push(dy); bw.push(w); wsum += w;
      }
    }
  const BN = bx.length;
  const brushOff = new Int32Array(BN);
  const brushW = new Float32Array(BN);
  for (let i = 0; i < BN; i++) { brushOff[i] = by[i] * W + bx[i]; brushW[i] = bw[i] / wsum; }

  const inertia = p.inertia;
  const capF = p.capacity;
  const minCap = 0.0005;
  const erodeR = p.erosionRate;
  const depR = p.depositionRate;
  const evap = p.evaporation;
  const gravity = 4;
  const maxLife = Math.min(160, Math.max(30, Math.round(N / 6)));
  const rng = new Rng(p.seed, 404);
  const fc: FaceCoord = { face: 0, s: 0, t: 0 };
  const dA: Vec3 = [0, 0, 0];
  const lo = 0.5, hi = N + 0.5 - 1e-7;
  const progressEvery = Math.max(1, Math.floor(count / 20));

  for (let n = 0; n < count; n++) {
    if (onProgress && n % progressEvery === 0) onProgress(n / count);
    // Spawn on land.
    let f = 0, px = 0, py = 0;
    let ok = false;
    for (let tries = 0; tries < 8 && !ok; tries++) {
      f = rng.int(6);
      px = lo + rng.next() * N;
      py = lo + rng.next() * N;
      const ix = Math.floor(px + 0.5), iy = Math.floor(py + 0.5);
      ok = H[(f * T + iy) * T + ix] > seaK;
    }
    if (!ok) continue;
    let dx = 0, dy = 0, speed = 1, water = 1, sed = 0;

    for (let life = 0; life < maxLife; life++) {
      const x0 = Math.floor(px), y0 = Math.floor(py);
      const fx = px - x0, fy = py - y0;
      const slot = (f * W + (y0 + P - 1)) * W + (x0 + P - 1);
      const i00 = map[slot], i10 = map[slot + 1], i01 = map[slot + W], i11 = map[slot + W + 1];
      const h00 = H[i00], h10 = H[i10], h01 = H[i01], h11 = H[i11];
      const gx = (h10 - h00) * (1 - fy) + (h11 - h01) * fy;
      const gy = (h01 - h00) * (1 - fx) + (h11 - h10) * fx;
      const h = h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) + h01 * (1 - fx) * fy + h11 * fx * fy;

      dx = dx * inertia - gx * (1 - inertia);
      dy = dy * inertia - gy * (1 - inertia);
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1e-12) {
        const a = rng.next() * Math.PI * 2;
        dx = Math.cos(a); dy = Math.sin(a);
      } else { dx /= len; dy /= len; }

      // Move one texel and hop faces if needed.
      let nf = f, npx = px + dx, npy = py + dy;
      if (npx < lo || npx > hi || npy < lo || npy > hi) {
        faceToDir(f, texelToS(npx, N), texelToS(npy, N), dA);
        dirToFace(dA[0], dA[1], dA[2], fc);
        nf = fc.face;
        npx = Math.min(hi, Math.max(lo, sToTexel(fc.s, N)));
        npy = Math.min(hi, Math.max(lo, sToTexel(fc.t, N)));
        // Re-express the travel direction on the new face by projecting a point a bit further along.
        faceToDir(f, texelToS(px + dx * 1.5, N), texelToS(py + dy * 1.5, N), dA);
        const b = FACE_BASIS[nf];
        const dn = dA[0] * b.n[0] + dA[1] * b.n[1] + dA[2] * b.n[2];
        if (dn > 1e-6) {
          const sx = sToTexel(unwarp((dA[0] * b.u[0] + dA[1] * b.u[1] + dA[2] * b.u[2]) / dn), N);
          const sy = sToTexel(unwarp((dA[0] * b.v[0] + dA[1] * b.v[1] + dA[2] * b.v[2]) / dn), N);
          let ndx = sx - npx, ndy = sy - npy;
          const l2 = Math.sqrt(ndx * ndx + ndy * ndy);
          if (l2 > 1e-9) { ndx /= l2; ndy /= l2; dx = ndx; dy = ndy; }
        }
      }

      // New height.
      const nx0 = Math.floor(npx), ny0 = Math.floor(npy);
      const nfx = npx - nx0, nfy = npy - ny0;
      const ns = (nf * W + (ny0 + P - 1)) * W + (nx0 + P - 1);
      const nh = H[map[ns]] * (1 - nfx) * (1 - nfy) + H[map[ns + 1]] * nfx * (1 - nfy)
        + H[map[ns + W]] * (1 - nfx) * nfy + H[map[ns + W + 1]] * nfx * nfy;
      const dh = nh - h;

      if (nh < seaK) {
        // Reached the sea: drop the load at the coast (spread with the brush) and stop.
        const amt = Math.min(sed, Math.max(0, h) + 0.002);
        if (amt > 0) {
          const cslot = (f * W + (Math.round(py) + P - 1)) * W + (Math.round(px) + P - 1);
          for (let b = 0; b < BN; b++) H[map[cslot + brushOff[b]]] += amt * brushW[b];
        }
        break;
      }

      const cap = Math.max(-dh * speed * water * capF, minCap);
      if (sed > cap || dh > 0) {
        const amt = dh > 0 ? Math.min(dh, sed) : (sed - cap) * depR;
        sed -= amt;
        H[i00] += amt * (1 - fx) * (1 - fy);
        H[i10] += amt * fx * (1 - fy);
        H[i01] += amt * (1 - fx) * fy;
        H[i11] += amt * fx * fy;
      } else {
        const amt = Math.min((cap - sed) * erodeR, -dh);
        const cslot = (f * W + (Math.round(py) + P - 1)) * W + (Math.round(px) + P - 1);
        for (let b = 0; b < BN; b++) H[map[cslot + brushOff[b]]] -= amt * brushW[b];
        sed += amt;
      }

      speed = Math.sqrt(Math.max(0, speed * speed - dh * gravity));
      if (speed > 8) speed = 8;
      water *= 1 - evap;
      f = nf; px = npx; py = npy;
      if (water < 0.01) break;
    }
  }
  if (onProgress) onProgress(1);
  const ik = 1 / k;
  for (let i = 0; i < H.length; i++) H[i] = H[i] * ik + off;
  return count;
}

/** Talus relaxation: material slides from texels steeper than the talus angle to their lowest neighbour. */
function thermalErosion(H: Float32Array, pm: PadMap, p: ErosionSettings): void {
  const { N, T, P, W, map } = pm;
  const maxDiff = Math.tan((p.talusAngle * Math.PI) / 180) * texelMeters(N, p.radius);
  const offs = [-1, 1, -W, W];
  for (let it = 0; it < p.thermalIterations; it++) {
    for (let f = 0; f < 6; f++) {
      for (let y = 1; y <= N; y++) {
        let slot = (f * W + (y + P - 1)) * W + P;
        let idx = (f * T + y) * T + 1;
        for (let x = 1; x <= N; x++, slot++, idx++) {
          const h = H[idx];
          let best = -1, bestD = maxDiff;
          for (let o = 0; o < 4; o++) {
            const ni = map[slot + offs[o]];
            const d = h - H[ni];
            if (d > bestD) { bestD = d; best = ni; }
          }
          if (best >= 0) {
            const move = (bestD - maxDiff) * 0.4;
            H[idx] -= move;
            H[best] += move;
          }
        }
      }
    }
  }
}

// ---- flow routing ---------------------------------------------------------------------------------

/**
 * Flow accumulation by priority-flood: starting from the coast, land texels are visited in increasing (filled)
 * elevation; each texel drains into the neighbour that reached it. Every land texel therefore drains to the sea
 * (or to the global minimum on ocean-less worlds) and the drainage tree yields clean river networks.
 * Returns the upstream area (in texel units) per texel and the depression depth (filled level − height, m),
 * both 6·T·T with refilled gutters. Sea texels (below `seaLevel`) get 0. `seaLevel` = -Infinity: no sea.
 */
export function flowAccumulation(H: Float32Array, N: number, padMap?: PadMap, seaLevel = 0): { acc: Float32Array; fill: Float32Array } {
  const pm = padMap ?? buildPadMap(N, 4);
  const { T, P, W, map } = pm;
  const total = 6 * T * T;
  const visited = new Uint8Array(total);
  const parent = new Int32Array(total).fill(-1);
  const order = new Int32Array(6 * N * N);
  let orderLen = 0;
  const area = texelAreaWeights(N);
  let areaMean = 0;
  for (let y = 1; y <= N; y++) for (let x = 1; x <= N; x++) areaMean += area[y * T + x];
  areaMean /= N * N;

  // Mark gutters visited (they are aliases), and push coastal ocean texels as seeds.
  for (let f = 0; f < 6; f++)
    for (let y = 0; y < T; y++)
      for (let x = 0; x < T; x++)
        if (x === 0 || y === 0 || x === T - 1 || y === T - 1) visited[(f * T + y) * T + x] = 1;

  const heap = new MinHeap(1 << 16);
  const n8 = [-1, 1, -W, W, -W - 1, -W + 1, W - 1, W + 1];
  let anyOcean = false;
  let gmin = Infinity, gminIdx = -1;
  for (let f = 0; f < 6; f++)
    for (let y = 1; y <= N; y++)
      for (let x = 1; x <= N; x++) {
        const idx = (f * T + y) * T + x;
        const h = H[idx];
        if (h < gmin) { gmin = h; gminIdx = idx; }
        if (h < seaLevel) {
          anyOcean = true;
          visited[idx] = 1;
          const slot = (f * W + (y + P - 1)) * W + (x + P - 1);
          for (let o = 0; o < 8; o++) {
            if (H[map[slot + n8[o]]] >= seaLevel) { heap.push(h, idx); break; }
          }
        }
      }
  if (!anyOcean && gminIdx >= 0) {
    visited[gminIdx] = 1;
    heap.push(gmin, gminIdx);
  }

  const TT = T * T;
  const fill = new Float32Array(total);
  while (heap.size > 0) {
    const level = heap.topKey();
    const idx = heap.pop();
    if (H[idx] >= seaLevel) { order[orderLen++] = idx; fill[idx] = Math.max(0, level - H[idx]); }
    const f = Math.floor(idx / TT);
    const rem = idx - f * TT;
    const y = Math.floor(rem / T);
    const x = rem - y * T;
    const slot = (f * W + (y + P - 1)) * W + (x + P - 1);
    for (let o = 0; o < 8; o++) {
      const ni = map[slot + n8[o]];
      if (visited[ni]) continue;
      visited[ni] = 1;
      parent[ni] = idx;
      const nh = H[ni];
      heap.push(nh > level ? nh : level + 1e-4, ni);
    }
  }

  // Accumulation by multiple flow directions on the filled surface: each texel hands its catchment to every
  // lower neighbour in proportion to the slope towards it, so a smooth slope carries a sheet and only real
  // valleys concentrate flow. Single-direction routing (each texel to the one neighbour that discovered it)
  // threaded planar slopes and flats with parallel ruler-straight chains that drew as dark lines. On a flat
  // (no lower neighbour) the discovery parent still takes the flow, so it reaches the spill point.
  const acc = new Float32Array(total);
  for (let i = 0; i < orderLen; i++) {
    const idx = order[i];
    const rem = idx % TT;
    acc[idx] = area[rem] / areaMean;
  }
  const invDist = [1, 1, 1, 1, Math.SQRT1_2, Math.SQRT1_2, Math.SQRT1_2, Math.SQRT1_2];
  const wgt = new Float64Array(8);
  for (let i = orderLen - 1; i >= 0; i--) {
    const idx = order[i];
    const a = acc[idx];
    const L = H[idx] + fill[idx];
    const f = Math.floor(idx / TT);
    const rem = idx - f * TT;
    const y = Math.floor(rem / T);
    const x = rem - y * T;
    const slot = (f * W + (y + P - 1)) * W + (x + P - 1);
    let sum = 0;
    for (let o = 0; o < 8; o++) {
      const ni = map[slot + n8[o]];
      const d = H[ni] < seaLevel ? L - H[ni] : L - (H[ni] + fill[ni]);
      const w = d > 0 ? d * invDist[o] : 0;
      wgt[o] = w;
      sum += w;
    }
    if (sum > 0) {
      const k = a / sum;
      for (let o = 0; o < 8; o++) {
        if (wgt[o] <= 0) continue;
        const ni = map[slot + n8[o]];
        if (H[ni] >= seaLevel) acc[ni] += wgt[o] * k;
      }
    } else {
      const pa = parent[idx];
      if (pa >= 0 && H[pa] >= seaLevel) acc[pa] += a;
    }
  }
  refillGutters(acc, N);
  refillGutters(fill, N);
  return { acc, fill };
}

function smoothstepF(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Binary min-heap of (float key, int value) with typed-array storage. */
class MinHeap {
  keys: Float64Array;
  vals: Int32Array;
  size = 0;
  constructor(cap: number) {
    this.keys = new Float64Array(cap);
    this.vals = new Int32Array(cap);
  }
  push(k: number, v: number): void {
    if (this.size === this.keys.length) {
      const nk = new Float64Array(this.keys.length * 2); nk.set(this.keys); this.keys = nk;
      const nv = new Int32Array(this.vals.length * 2); nv.set(this.vals); this.vals = nv;
    }
    const keys = this.keys, vals = this.vals;
    let i = this.size++;
    while (i > 0) {
      const pIdx = (i - 1) >> 1;
      if (keys[pIdx] <= k) break;
      keys[i] = keys[pIdx]; vals[i] = vals[pIdx];
      i = pIdx;
    }
    keys[i] = k; vals[i] = v;
  }
  topKey(): number {
    return this.keys[0];
  }
  pop(): number {
    const keys = this.keys, vals = this.vals;
    const top = vals[0];
    const n = --this.size;
    if (n > 0) {
      const k = keys[n], v = vals[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= k) break;
        keys[i] = keys[c]; vals[i] = vals[c];
        i = c;
      }
      keys[i] = k; vals[i] = v;
    }
    return top;
  }
}

/**
 * Log-scaled flow (0..1): 0 for a single texel, 1 for a catchment of ~5% of a face.
 * Plus a blurred version used as soil wetness near rivers.
 *
 * `fill` (from flowAccumulation) hides the flow across ponded ground: inside a filled depression the routing
 * has no slope to follow and the priority flood threads the whole catchment through one texel-wide chain,
 * which drew ruler-straight dark lines across every lava plain and basin floor. Water that reaches such a
 * flat spreads out as a sheet, so the channel fades in over the first metre of ponding and the flow reappears
 * only at the spill point, where the ground descends again.
 */
export function flowToWetness(acc: Float32Array, N: number, padMap?: PadMap, fill?: Float32Array): { flow01: Float32Array; wet01: Float32Array } {
  const pm = padMap ?? buildPadMap(N, 4);
  const { T, P, W, map } = pm;
  const ref = Math.log(1 + N * N * 0.05);
  const flow01 = new Float32Array(acc.length);
  for (let i = 0; i < acc.length; i++) {
    const v = Math.log(1 + Math.max(0, acc[i] - 1)) / ref;
    flow01[i] = v > 1 ? 1 : v;
  }
  if (fill) {
    // Ponding depth is a chain of 1e-4 steps on a true flat and metres in a bowl; both are sheet flow.
    for (let i = 0; i < acc.length; i++) {
      const d = fill[i];
      if (d > 0) flow01[i] *= 1 - smoothstepF(0, 1, d);
    }
  }
  // Wetness: rivers only (flow above a threshold), widened by a few blur passes across faces.
  let a = new Float32Array(acc.length);
  for (let i = 0; i < acc.length; i++) a[i] = Math.max(0, (flow01[i] - 0.35) / 0.65);
  let b = new Float32Array(acc.length);
  const passes = Math.max(2, Math.round(N / 128));
  for (let it = 0; it < passes; it++) {
    for (let f = 0; f < 6; f++)
      for (let y = 1; y <= N; y++) {
        let slot = (f * W + (y + P - 1)) * W + P;
        let idx = (f * T + y) * T + 1;
        for (let x = 1; x <= N; x++, slot++, idx++) {
          const s = a[map[slot - 1]] + a[map[slot + 1]] + a[map[slot - W]] + a[map[slot + W]];
          b[idx] = Math.max(a[idx], (a[idx] * 2 + s) / 6 * 1.15);
        }
      }
    const t = a; a = b; b = t;
  }
  refillGutters(a, N);
  return { flow01, wet01: a };
}
