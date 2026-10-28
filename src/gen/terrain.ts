// Terrain stage: raw height (≈ km, before sea-level shift and scaling) as a pure function of direction,
// evaluated per cube face (gutters included), plus rasterised craters and volcanoes.

import { faceToDir, texelToS, unwarp, FACE_BASIS } from '../core/cube.ts';
import type { Vec3 } from '../core/cube.ts';
import { Noise3, Rng, smoothstep } from './noise.ts';
import type { GenParams } from './params.ts';

export interface TerrainContext {
  p: GenParams;
  N: number;
  noise: Noise3;
  /** Plate centres (unit vectors), K*3. */
  plateC: Float64Array;
  /** Plate rotation vectors (Euler pole * angular speed), K*3. */
  plateW: Float64Array;
  /** Plate crust type: +1 continental … -1 oceanic. */
  plateType: Float64Array;
  K: number;
  /** Continent-value threshold that splits area into ocean/land at the requested coverage. */
  c0: number;
  /** Craters: [x, y, z, radius(rad), depth(raw km), rimHeight, peak] * count. */
  craters: Float64Array;
  craterCount: number;
  /** Volcanoes: [x, y, z, radius(rad), height(raw km), caldera] * count. */
  volcanoes: Float64Array;
  volcanoCount: number;
  // Octave counts derived from resolution.
  octCont: number;
  octRidge: number;
  octHills: number;
  octDetail: number;
}

const CRATER_STRIDE = 7;
const VOLCANO_STRIDE = 6;
/** Ejecta reach in crater radii. */
const EJECTA = 2.4;

/** Octaves so the finest octave of a noise with base frequency F stays above ~2.5 texels. */
function octavesFor(F: number, N: number, max: number): number {
  const texelsPerRadian = N / (Math.PI / 2);
  const o = Math.floor(Math.log2(texelsPerRadian / (2.5 * F))) + 1;
  return Math.max(1, Math.min(max, o));
}

export function prepareTerrain(p: GenParams): TerrainContext {
  const N = p.resolution;
  const noise = new Noise3(p.seed);
  const rng = new Rng(p.seed, 101);

  // --- plates: jittered points on the sphere (best-candidate sampling for even spacing) ---
  const K = p.plateCount;
  const plateC = new Float64Array(K * 3);
  const plateW = new Float64Array(K * 3);
  const plateType = new Float64Array(K);
  const cand = new Float64Array(3);
  for (let k = 0; k < K; k++) {
    let best = -1, bestD = -Infinity;
    for (let c = 0; c < 8; c++) {
      rng.unitVec(cand);
      let minD = Infinity;
      for (let j = 0; j < k; j++) {
        const d = 1 - (cand[0] * plateC[j * 3] + cand[1] * plateC[j * 3 + 1] + cand[2] * plateC[j * 3 + 2]);
        if (d < minD) minD = d;
      }
      if (minD > bestD) { bestD = minD; best = c; plateC[k * 3] = cand[0]; plateC[k * 3 + 1] = cand[1]; plateC[k * 3 + 2] = cand[2]; }
    }
    void best;
    rng.unitVec(plateW, k * 3);
    const speed = 0.4 + rng.next() * 0.8;
    plateW[k * 3] *= speed; plateW[k * 3 + 1] *= speed; plateW[k * 3 + 2] *= speed;
    // Roughly the land fraction of plates is continental.
    const landFrac = 1 - p.oceanCoverage;
    plateType[k] = rng.next() < landFrac * 0.9 + 0.05 ? 0.6 + 0.4 * rng.next() : -(0.6 + 0.4 * rng.next());
  }

  const ctx: TerrainContext = {
    p, N, noise, plateC, plateW, plateType, K, c0: 0,
    craters: new Float64Array(0), craterCount: 0, volcanoes: new Float64Array(0), volcanoCount: 0,
    octCont: octavesFor(p.continentFreq * 2, N, 8),
    octRidge: octavesFor(5, N, 7),
    octHills: octavesFor(7, N, 6),
    octDetail: octavesFor(24, N, 5),
  };

  // --- continent threshold from an area-uniform presample (Fibonacci sphere) ---
  const S = 6000;
  const vals = new Float64Array(S);
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < S; i++) {
    const y = 1 - (2 * (i + 0.5)) / S;
    const r = Math.sqrt(1 - y * y);
    const a = ga * i;
    vals[i] = continentValue(ctx, r * Math.cos(a), y, r * Math.sin(a));
  }
  vals.sort();
  ctx.c0 = vals[Math.min(S - 1, Math.floor(p.oceanCoverage * S))];

  // --- craters: power-law radii, uniform positions ---
  const nc = p.craterCount;
  if (nc > 0) {
    const cr = new Float64Array(nc * CRATER_STRIDE);
    const crng = new Rng(p.seed, 202);
    const rMax = p.craterSize;
    const rMin = rMax * 0.04;
    const alpha = 1.6;
    const q = Math.pow(rMin / rMax, alpha);
    for (let i = 0; i < nc; i++) {
      crng.unitVec(cr, i * CRATER_STRIDE);
      const u = crng.next();
      const R = rMin * Math.pow(1 - u * (1 - q), -1 / alpha);
      const Rkm = R * p.radius / 1000;
      // depth/diameter ≈ 0.2 for small simple craters, shallower for big complex ones.
      const depth = p.craterDepth * 0.4 * Rkm / (1 + Rkm / 25) * (0.8 + 0.4 * crng.next());
      const o = i * CRATER_STRIDE;
      cr[o + 3] = R;
      cr[o + 4] = depth;
      cr[o + 5] = depth * (0.22 + 0.1 * crng.next());
      cr[o + 6] = Rkm > 30 ? depth * (0.25 + 0.2 * crng.next()) : 0;
    }
    // Draw big (old) craters first so small ones land on top.
    const order = Array.from({ length: nc }, (_, i) => i).sort((a, b) => cr[b * CRATER_STRIDE + 3] - cr[a * CRATER_STRIDE + 3] || a - b);
    const sorted = new Float64Array(nc * CRATER_STRIDE);
    order.forEach((src, dst) => sorted.set(cr.subarray(src * CRATER_STRIDE, src * CRATER_STRIDE + CRATER_STRIDE), dst * CRATER_STRIDE));
    ctx.craters = sorted;
    ctx.craterCount = nc;
  }

  // --- volcanoes: prefer land / plate boundaries is too costly to search; place randomly with land bias ---
  const nv = p.volcanoCount;
  if (nv > 0) {
    const vv = new Float64Array(nv * VOLCANO_STRIDE);
    const vrng = new Rng(p.seed, 303);
    for (let i = 0; i < nv; i++) {
      const o = i * VOLCANO_STRIDE;
      // Rejection-sample towards land (continent value above threshold) for most volcanoes.
      for (let tries = 0; tries < 12; tries++) {
        vrng.unitVec(vv, o);
        if (continentValue(ctx, vv[o], vv[o + 1], vv[o + 2]) > ctx.c0 - 0.05 || vrng.next() < 0.15) break;
      }
      const R = p.volcanoSize * (0.25 + 0.75 * Math.pow(vrng.next(), 2));
      const Rkm = R * p.radius / 1000;
      vv[o + 3] = R;
      vv[o + 4] = Math.min(9, 0.12 * Rkm) * (0.6 + 0.6 * vrng.next());
      vv[o + 5] = 0.08 + 0.1 * vrng.next();
    }
    ctx.volcanoes = vv;
    ctx.volcanoCount = nv;
  }
  return ctx;
}

/** Continent value (domain-warped fbm + plate crust type). Land where value > ctx.c0. */
export function continentValue(ctx: TerrainContext, x: number, y: number, z: number): number {
  const p = ctx.p;
  const n = ctx.noise;
  const f = p.continentFreq;
  const w = n.warp3(x * f * 0.7, y * f * 0.7, z * f * 0.7, 3);
  const ws = p.warpStrength * 0.45;
  const qx = x + ws * w[0], qy = y + ws * w[1], qz = z + ws * w[2];
  let c = n.fbm(qx * f + 3.1, qy * f - 1.7, qz * f + 0.3, ctx.octCont, 2, 0.52);
  c += plateBlend(ctx, qx, qy, qz) * p.plateInfluence * 0.32;
  return c;
}

// Scratch for plate queries (module-level: one terrain evaluation at a time per worker).
const _pl = { i: 0, j: 0, k: 0, di: 0, dj: 0, dk: 0, type: 0 };

/** Finds the 3 nearest plates to (x,y,z) (not necessarily unit) and returns the soft crust type. */
function plateBlend(ctx: TerrainContext, x: number, y: number, z: number): number {
  const C = ctx.plateC;
  const inv = 1 / Math.sqrt(x * x + y * y + z * z);
  x *= inv; y *= inv; z *= inv;
  let i = 0, j = 0, k = 0, di = -2, dj = -2, dk = -2;
  for (let m = 0; m < ctx.K; m++) {
    const d = x * C[m * 3] + y * C[m * 3 + 1] + z * C[m * 3 + 2];
    if (d > di) { k = j; dk = dj; j = i; dj = di; i = m; di = d; }
    else if (d > dj) { k = j; dk = dj; j = m; dj = d; }
    else if (d > dk) { k = m; dk = d; }
  }
  _pl.i = i; _pl.j = j; _pl.k = k; _pl.di = di; _pl.dj = dj; _pl.dk = dk;
  // Softmax-style membership so the crust type is continuous across plate switches.
  const sharp = 18;
  const wj = Math.exp((dj - di) * sharp);
  const wk = Math.exp((dk - di) * sharp);
  const T = ctx.plateType;
  const t = (T[i] + wj * T[j] + wk * T[k]) / (1 + wj + wk);
  _pl.type = t;
  return t;
}

/** Closing speed between plates a and b at point (x,y,z): >0 convergent, <0 divergent. */
function convergence(ctx: TerrainContext, a: number, b: number, x: number, y: number, z: number): number {
  const C = ctx.plateC, W = ctx.plateW;
  // Boundary normal pointing from b to a.
  let nx = C[a * 3] - C[b * 3], ny = C[a * 3 + 1] - C[b * 3 + 1], nz = C[a * 3 + 2] - C[b * 3 + 2];
  const nl = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) + 1e-9);
  nx *= nl; ny *= nl; nz *= nl;
  // v = w × p for each plate; relative velocity of b w.r.t. a.
  const wx = W[b * 3] - W[a * 3], wy = W[b * 3 + 1] - W[a * 3 + 1], wz = W[b * 3 + 2] - W[a * 3 + 2];
  const vx = wy * z - wz * y, vy = wz * x - wx * z, vz = wx * y - wy * x;
  // b moving towards a (along +n) means closing.
  const c = (vx * nx + vy * ny + vz * nz) / 1.2;
  return c < -1 ? -1 : c > 1 ? 1 : c;
}

/** Raw terrain height (≈ km) at a unit direction. Does not include craters/volcanoes (rasterised separately). */
export function terrainHeight(ctx: TerrainContext, x: number, y: number, z: number): number {
  const p = ctx.p;
  const n = ctx.noise;
  const f = p.continentFreq;

  // --- continents (shared with the presample) ---
  const w = n.warp3(x * f * 0.7, y * f * 0.7, z * f * 0.7, 3);
  const ws = p.warpStrength * 0.45;
  const w0 = w[0], w1 = w[1], w2 = w[2];
  const qx = x + ws * w0, qy = y + ws * w1, qz = z + ws * w2;
  let c = n.fbm(qx * f + 3.1, qy * f - 1.7, qz * f + 0.3, ctx.octCont, 2, 0.52);
  const crust = plateBlend(ctx, qx, qy, qz);
  c += crust * p.plateInfluence * 0.32;
  const e = c - ctx.c0; // > 0 land

  const sw = p.shelfWidth;
  const land = smoothstep(-0.015, 0.05, e);
  const ocean = 1 - smoothstep(-0.06, 0.0, e);

  // --- base: lowlands rising inland, continental shelf, slope and abyssal plain ---
  let h: number;
  if (e >= 0) {
    h = 0.7 * (1 - Math.exp(-e / 0.18));
  } else {
    const d = -e;
    h = -0.12 * smoothstep(0, sw, d) - 3.6 * smoothstep(sw * 0.8, sw * 2.2, d) - 0.8 * smoothstep(sw * 2, sw * 6, d);
    // Abyssal hills.
    h += 0.25 * smoothstep(sw, sw * 3, d) * n.fbm(x * 9 + 7.7, y * 9, z * 9 - 3.3, 3);
  }

  // --- plateaus with escarpment edges ---
  if (p.plateaus > 0 && land > 0) {
    const pm = n.fbm(x * 2.3 + 11.1, y * 2.3 - 4.4, z * 2.3 + 8.8, 4, 2, 0.55);
    const pl = smoothstep(0.08, 0.16, pm + 0.1 * e);
    h += p.plateaus * 1.3 * pl * land;
  }

  // --- tectonics: plate boundary belts (using the 3 nearest plates from plateBlend at the warped point) ---
  const i = _pl.i, j = _pl.j, k = _pl.k;
  const bij = (_pl.di - _pl.dj) / 0.9; // ≈ angular distance to the i|j boundary
  const bik = (_pl.di - _pl.dk) / 0.9;
  const wjk = smoothstep(-0.03, 0.03, _pl.dj - _pl.dk); // j vs k as "the" neighbour, continuous
  const cij = convergence(ctx, i, j, x, y, z);
  const cik = convergence(ctx, i, k, x, y, z);
  // Width varies along the belt.
  const wMod = 0.65 + 0.7 * (0.5 + 0.5 * n.simplex(x * 3 + 5.5, y * 3 - 2.2, z * 3 + 9.9));
  const W = p.mountainWidth * wMod;
  const bandJ = Math.exp(-(bij * bij) / (W * W));
  const bandK = Math.exp(-(bik * bik) / (W * W));
  const conv = cij * wjk + cik * (1 - wjk);
  const band = bandJ * wjk + bandK * (1 - wjk);
  const convPos = (Math.max(0, cij) * bandJ * wjk + Math.max(0, cik) * bandK * (1 - wjk));
  const convNeg = (Math.max(0, -cij) * bandJ * wjk + Math.max(0, -cik) * bandK * (1 - wjk));
  void conv;

  if (p.mountainStrength > 0) {
    // Collision ranges on land, island arcs at sea.
    const where = land + 0.35 * (1 - land);
    // Gaps along belts.
    const gate = smoothstep(-0.35, 0.25, n.fbm(x * 4.1 - 9.1, y * 4.1 + 2.7, z * 4.1 + 6.3, 2));
    const m = p.mountainStrength * Math.pow(convPos, 0.75) * where * gate;
    if (m > 0.004) {
      const rf = 6.5;
      const r = n.ridged(x * rf + w0 * 0.25, y * rf + w1 * 0.25, z * rf + w2 * 0.25, ctx.octRidge, p.ridgeSharpness);
      h += m * (1.1 * band + 4.6 * r * (0.35 + 0.65 * band));
    }
    // Old, worn ranges inside continents (Appalachian / Urals style).
    const om = smoothstep(0.12, 0.3, n.fbm(x * 1.7 - 21.3, y * 1.7 + 3.3, z * 1.7 + 12.2, 3)) * land;
    if (om > 0.004) {
      const r = n.ridged(x * 9 - 4.4, y * 9 + 1.1, z * 9 + 2.2, ctx.octRidge, p.ridgeSharpness * 0.8);
      h += p.mountainStrength * om * 1.6 * r;
    }
    // Ocean trenches at convergent boundaries.
    const tb = (bij * wjk + bik * (1 - wjk));
    const tw = W * 0.35;
    h -= 2.8 * p.mountainStrength * ocean * Math.max(0, cij * wjk + cik * (1 - wjk)) * Math.exp(-(tb * tb) / (tw * tw));
    // Mid-ocean ridges with a central rift; rift valleys on land.
    if (convNeg > 0.004) {
      const rw = W * 0.12;
      const rift = Math.exp(-(tb * tb) / (rw * rw));
      h += ocean * convNeg * (1.6 - 1.0 * rift) * (0.8 + 0.4 * n.ridged(x * 14, y * 14, z * 14, 2, 1.5));
      h -= land * convNeg * 0.9 * rift;
    }
  }

  // --- hills ---
  if (p.hills > 0) {
    const hm = 0.35 + 0.65 * smoothstep(-0.25, 0.35, n.fbm(x * 2.1 + 40.1, y * 2.1, z * 2.1 - 13.7, 3));
    const hv = n.fbm(x * 7 - 2.9, y * 7 + 6.6, z * 7 + 1.4, ctx.octHills, 2, 0.5);
    h += p.hills * 0.55 * hv * hm * (0.15 + 0.85 * land);
  }

  // --- fine detail everywhere (makes coastlines fractal) ---
  if (p.detail > 0) {
    h += p.detail * 0.14 * n.fbm(x * 24 + 1.9, y * 24 - 7.3, z * 24 + 3.7, ctx.octDetail, 2, 0.5);
  }

  // --- terraces / mesas on land ---
  if (p.terracing > 0 && h > 0) {
    const step = 0.42;
    const t = h / step;
    const fl = Math.floor(t);
    const fr = t - fl;
    const terr = (fl + 0.12 * fr + 0.88 * smoothstep(0.55, 0.9, fr)) * step;
    h += (terr - h) * p.terracing;
  }

  // --- dunes: transverse ridges, crests running north-south, in lowland ergs ---
  if (p.dunes > 0 && h > -0.05) {
    const erg = smoothstep(0.0, 0.25, n.fbm(x * 3.1 + 70.3, y * 3.1 - 1.1, z * 3.1 + 5.5, 3)) * (1 - smoothstep(0.4, 1.4, h)) * land;
    if (erg > 0.004) {
      const df = ctx.N * 0.14;
      const dn = n.ridged(x * df, y * df * 0.3, z * df, 2, 1.6);
      h += p.dunes * 0.12 * erg * dn;
    }
  }
  return h;
}

/**
 * Raw height for one face, all T×T texels (gutters evaluated from direction).
 * Also rasterises volcanoes and craters onto the face.
 */
export function generateTerrainFace(ctx: TerrainContext, face: number): Float32Array {
  const N = ctx.N;
  const T = N + 2;
  const out = new Float32Array(T * T);
  const dirs = new Float32Array(T * T * 3);
  const d: Vec3 = [0, 0, 0];
  for (let y = 0; y < T; y++) {
    const t = texelToS(y, N);
    for (let x = 0; x < T; x++) {
      faceToDir(face, texelToS(x, N), t, d);
      const idx = y * T + x;
      dirs[idx * 3] = d[0]; dirs[idx * 3 + 1] = d[1]; dirs[idx * 3 + 2] = d[2];
      out[idx] = terrainHeight(ctx, d[0], d[1], d[2]);
    }
  }
  if (ctx.volcanoCount > 0) rasterVolcanoes(ctx, face, out, dirs);
  if (ctx.craterCount > 0) rasterCraters(ctx, face, out, dirs);
  return out;
}

// ---- rasterised features ------------------------------------------------------------------------

interface Box { x0: number; x1: number; y0: number; y1: number }
const _box: Box = { x0: 0, x1: 0, y0: 0, y1: 0 };

/** Texel bounding box on `face` of the spherical cap (centre c, angular radius A). Returns false if it misses. */
function capBox(face: number, N: number, cx: number, cy: number, cz: number, A: number, box: Box): boolean {
  const T = N + 2;
  const b = FACE_BASIS[face];
  const n = b.n, u = b.u, v = b.v;
  const cn = cx * n[0] + cy * n[1] + cz * n[2];
  // Face (with gutter) spans < 56° from its centre.
  if (Math.acos(Math.max(-1, Math.min(1, cn))) > A + 0.99) return false;
  // Orthonormal frame around c.
  let ex: number, ey: number, ez: number;
  if (Math.abs(cx) < 0.9) { ex = 0; ey = -cz; ez = cy; } else { ex = cz; ey = 0; ez = -cx; }
  let l = 1 / Math.hypot(ex, ey, ez);
  ex *= l; ey *= l; ez *= l;
  const fx = cy * ez - cz * ey, fy = cz * ex - cx * ez, fz = cx * ey - cy * ex;
  const ca = Math.cos(A), sa = Math.sin(A);
  let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
  const STEPS = 32;
  for (let i = -1; i < STEPS; i++) {
    let px: number, py: number, pz: number;
    if (i < 0) { px = cx; py = cy; pz = cz; }
    else {
      const a = (i / STEPS) * Math.PI * 2;
      const co = Math.cos(a) * sa, si = Math.sin(a) * sa;
      px = ca * cx + co * ex + si * fx; py = ca * cy + co * ey + si * fy; pz = ca * cz + co * ez + si * fz;
    }
    const dn = px * n[0] + py * n[1] + pz * n[2];
    if (dn <= 0.08) { s0 = -2; s1 = 2; t0 = -2; t1 = 2; break; }
    const su = unwarp((px * u[0] + py * u[1] + pz * u[2]) / dn);
    const sv = unwarp((px * v[0] + py * v[1] + pz * v[2]) / dn);
    if (su < s0) s0 = su; if (su > s1) s1 = su;
    if (sv < t0) t0 = sv; if (sv > t1) t1 = sv;
  }
  const pad = 2;
  box.x0 = Math.max(0, Math.floor(((s0 + 1) * 0.5) * N + 0.5) - pad);
  box.x1 = Math.min(T - 1, Math.ceil(((s1 + 1) * 0.5) * N + 0.5) + pad);
  box.y0 = Math.max(0, Math.floor(((t0 + 1) * 0.5) * N + 0.5) - pad);
  box.y1 = Math.min(T - 1, Math.ceil(((t1 + 1) * 0.5) * N + 0.5) + pad);
  l = 0;
  return box.x0 <= box.x1 && box.y0 <= box.y1;
}

/** Crater profile at normalised distance x = angle / R (0..EJECTA). Returns height in units of depth. */
export function craterProfile(x: number, rim: number, peak: number, floorFrac: number): number {
  if (x < 1) {
    // Parabolic bowl rising to the rim, floor flattened for large craters, optional central peak.
    let h = -1 + (1 + rim) * x * x * (0.6 + 0.4 * x);
    if (h < -floorFrac) h = -floorFrac + (h + floorFrac) * 0.15;
    if (peak > 0) h += peak * Math.exp(-(x * x) / 0.018);
    return h;
  }
  // Ejecta blanket: falls off with ~x^-3, reaching 0 at EJECTA.
  const tail = Math.pow(EJECTA, -3);
  return (rim * (Math.pow(x, -3) - tail)) / (1 - tail);
}

function rasterCraters(ctx: TerrainContext, face: number, out: Float32Array, dirs: Float32Array): void {
  const N = ctx.N, T = N + 2;
  const C = ctx.craters;
  const n = ctx.noise;
  for (let c = 0; c < ctx.craterCount; c++) {
    const o = c * CRATER_STRIDE;
    const cx = C[o], cy = C[o + 1], cz = C[o + 2], R = C[o + 3], D = C[o + 4];
    const rim = C[o + 5] / D, peak = C[o + 6] / D;
    const A = R * EJECTA;
    if (!capBox(face, N, cx, cy, cz, A, _box)) continue;
    const cosA = Math.cos(A);
    const floorFrac = R * ctx.p.radius / 1000 > 20 ? 0.75 : 1.5;
    for (let y = _box.y0; y <= _box.y1; y++) {
      for (let x = _box.x0; x <= _box.x1; x++) {
        const idx = y * T + x;
        const dx = dirs[idx * 3], dy = dirs[idx * 3 + 1], dz = dirs[idx * 3 + 2];
        const dot = dx * cx + dy * cy + dz * cz;
        if (dot <= cosA) continue;
        const ang = Math.acos(Math.min(1, dot));
        // Slightly irregular rims.
        const irr = 1 + 0.08 * n.simplex(dx * 40 / (R * 6 + 0.05), dy * 40 / (R * 6 + 0.05), dz * 40 / (R * 6 + 0.05) + c);
        const xn = ang / (R * irr);
        if (xn >= EJECTA) continue;
        out[idx] += D * craterProfile(xn, rim, peak, floorFrac);
      }
    }
  }
}

function rasterVolcanoes(ctx: TerrainContext, face: number, out: Float32Array, dirs: Float32Array): void {
  const N = ctx.N, T = N + 2;
  const V = ctx.volcanoes;
  const n = ctx.noise;
  for (let c = 0; c < ctx.volcanoCount; c++) {
    const o = c * VOLCANO_STRIDE;
    const cx = V[o], cy = V[o + 1], cz = V[o + 2], R = V[o + 3], H = V[o + 4], cal = V[o + 5];
    if (!capBox(face, N, cx, cy, cz, R, _box)) continue;
    const cosA = Math.cos(R);
    for (let y = _box.y0; y <= _box.y1; y++) {
      for (let x = _box.x0; x <= _box.x1; x++) {
        const idx = y * T + x;
        const dx = dirs[idx * 3], dy = dirs[idx * 3 + 1], dz = dirs[idx * 3 + 2];
        const dot = dx * cx + dy * cy + dz * cz;
        if (dot <= cosA) continue;
        const xn = Math.acos(Math.min(1, dot)) / R;
        // Concave shield/strato profile with radial gullies and a summit caldera.
        let prof = Math.pow(1 - xn, 2.2) * (1 - 0.15 * xn);
        const gul = n.ridged(dx * 60 + c, dy * 60, dz * 60 - c, 2, 2);
        prof *= 1 - 0.18 * gul * xn;
        const calD = smoothstep(cal, cal * 0.6, xn);
        out[idx] += H * (prof - 0.35 * calD * Math.pow(1 - cal, 2.2));
      }
    }
  }
}
