import { describe, expect, it } from 'vitest';
import { dirToFace, faceToDir, sToTexel, texelToS } from '../core/cube.ts';
import type { FaceCoord, Vec3 } from '../core/cube.ts';
import type { PlanetData } from '../core/types.ts';
import { erodeCube } from './erosion.ts';
import { texelAreaWeights } from './heightfield.ts';
import { Noise3 } from './noise.ts';
import { GEN_PRESETS, presetParams } from './params.ts';
import { generatePlanetSync, solveSeaLevelByVolume, worldPlan } from './pipeline.ts';

const N = 48;
const cache = new Map<string, PlanetData>();
function planet(preset: string, seed = 7, res = N): PlanetData {
  const key = `${preset}/${seed}/${res}`;
  let pd = cache.get(key);
  if (!pd) {
    pd = generatePlanetSync(presetParams(preset, { seed, resolution: res }));
    cache.set(key, pd);
  }
  return pd;
}

function hashBytes(a: ArrayBufferView): number {
  const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let h = 2166136261;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 16777619);
  return h >>> 0;
}

const ARCHS = Object.keys(GEN_PRESETS);

describe('generator', () => {
  it('is deterministic for a given seed', () => {
    const a = generatePlanetSync(presetParams('rust', { seed: 3, resolution: 32 }));
    const b = generatePlanetSync(presetParams('rust', { seed: 3, resolution: 32 }));
    expect(hashBytes(a.height)).toBe(hashBytes(b.height));
    expect(hashBytes(a.splat0)).toBe(hashBytes(b.splat0));
    expect(hashBytes(a.splat1)).toBe(hashBytes(b.splat1));
    expect(hashBytes(a.climate)).toBe(hashBytes(b.climate));
    expect(JSON.stringify(a.info)).toBe(JSON.stringify(b.info));
    const c = generatePlanetSync(presetParams('rust', { seed: 4, resolution: 32 }));
    expect(hashBytes(c.height)).not.toBe(hashBytes(a.height));
  });

  it.each(ARCHS)('%s: splat weights sum to 255 (interior exact, gutters ±4)', (arch) => {
    const pd = planet(arch);
    const T = pd.T;
    let worstGutter = 0;
    for (let f = 0; f < 6; f++)
      for (let y = 0; y < T; y++)
        for (let x = 0; x < T; x++) {
          const i = ((f * T + y) * T + x) * 4;
          const s = pd.splat0[i] + pd.splat0[i + 1] + pd.splat0[i + 2] + pd.splat0[i + 3]
            + pd.splat1[i] + pd.splat1[i + 1] + pd.splat1[i + 2] + pd.splat1[i + 3];
          const interior = x >= 1 && x <= pd.N && y >= 1 && y <= pd.N;
          if (interior) expect(s).toBe(255);
          else worstGutter = Math.max(worstGutter, Math.abs(s - 255));
        }
    expect(worstGutter).toBeLessThanOrEqual(4);
  });

  it.each(ARCHS)('%s: heights are finite and the total relief stays within 13%% of the radius', (arch) => {
    const pd = planet(arch);
    for (let i = 0; i < pd.height.length; i++) expect(Number.isFinite(pd.height[i])).toBe(true);
    expect(pd.maxHeight - pd.minHeight).toBeLessThan(0.13 * pd.radius);
    expect(pd.maxHeight - pd.minHeight).toBeGreaterThan(500);
  });

  it.each(ARCHS)('%s: fills PlanetInfo, no water sea, sea coverage under 10%%', (arch) => {
    const pd = planet(arch);
    const info = pd.info!;
    expect(info).toBeTruthy();
    expect(info.history.length).toBeGreaterThan(3);
    expect(info.units.length).toBeGreaterThanOrEqual(30);
    expect(info.look.layerTints.length).toBe(8);
    expect(info.look.atmoDensity).toBeGreaterThan(0);
    expect(info.look.rayleighH).toBeLessThanOrEqual(info.look.atmoHeightKm / 5);
    expect(info.look.mieH).toBeLessThanOrEqual(info.look.atmoHeightKm / 7);
    for (const v of Object.values(info.bulk)) if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
    if (arch !== 'wild') expect(info.bulk.seaKind).not.toBe('water');
    const T = pd.T, w = texelAreaWeights(pd.N);
    let below = 0, tot = 0;
    for (let f = 0; f < 6; f++)
      for (let y = 1; y <= pd.N; y++)
        for (let x = 1; x <= pd.N; x++) {
          tot += w[y * T + x];
          if (pd.height[(f * T + y) * T + x] < 0) below += w[y * T + x];
        }
    if (info.look.seaKind !== 'none') expect(below / tot).toBeLessThan(0.1);
  });

  it('places the sea level at the planned coverage (ice shell)', () => {
    const p = presetParams('ice shell', { seed: 11, resolution: N });
    const plan = worldPlan(p);
    const pd = planet('ice shell', 11);
    expect(plan.seaMode).toBe('coverage');
    const T = pd.T, w = texelAreaWeights(pd.N);
    let below = 0, tot = 0;
    for (let f = 0; f < 6; f++)
      for (let y = 1; y <= pd.N; y++)
        for (let x = 1; x <= pd.N; x++) {
          tot += w[y * T + x];
          if (pd.height[(f * T + y) * T + x] < 0) below += w[y * T + x];
        }
    expect(Math.abs(below / tot - plan.seaValue)).toBeLessThan(0.01);
  });

  it('solves the sea level by volume', () => {
    const n = 32, T = n + 2;
    const h = new Float32Array(6 * T * T);
    const noise = new Noise3(5);
    const d: Vec3 = [0, 0, 0];
    for (let f = 0; f < 6; f++)
      for (let y = 0; y < T; y++)
        for (let x = 0; x < T; x++) {
          faceToDir(f, texelToS(x, n), texelToS(y, n), d);
          h[(f * T + y) * T + x] = 3000 * noise.fbm(d[0] * 2, d[1] * 2, d[2] * 2, 4);
        }
    const w = texelAreaWeights(n);
    const gel = 150;
    const L = solveSeaLevelByVolume(h, n, gel, w);
    let vol = 0;
    for (let f = 0; f < 6; f++)
      for (let y = 1; y <= n; y++)
        for (let x = 1; x <= n; x++) vol += Math.max(0, L - h[(f * T + y) * T + x]) * w[y * T + x];
    expect(vol / (4 * Math.PI)).toBeCloseTo(gel, 0);
  });

  it('erosion stays bounded (no NaN, no new extremes beyond a small margin)', () => {
    const n = 32, T = n + 2;
    const h = new Float32Array(6 * T * T);
    const noise = new Noise3(9);
    const d: Vec3 = [0, 0, 0];
    for (let f = 0; f < 6; f++)
      for (let y = 0; y < T; y++)
        for (let x = 0; x < T; x++) {
          faceToDir(f, texelToS(x, n), texelToS(y, n), d);
          h[(f * T + y) * T + x] = 4000 * noise.ridged(d[0] * 3, d[1] * 3, d[2] * 3, 4) - 1500;
        }
    let mn0 = Infinity, mx0 = -Infinity;
    for (const v of h) { mn0 = Math.min(mn0, v); mx0 = Math.max(mx0, v); }
    erodeCube(h, n, {
      seed: 1, radius: 500e3, droplets: 2, erosionRate: 0.3, depositionRate: 0.3, inertia: 0.35, evaporation: 0.02,
      capacity: 8, brushRadius: 2, thermalIterations: 4, talusAngle: 42, seaLevel: 0,
    });
    let mn = Infinity, mx = -Infinity;
    for (const v of h) { expect(Number.isFinite(v)).toBe(true); mn = Math.min(mn, v); mx = Math.max(mx, v); }
    const span = mx0 - mn0;
    expect(mx).toBeLessThanOrEqual(mx0 + 0.05 * span);
    expect(mn).toBeGreaterThanOrEqual(mn0 - 0.05 * span);
  });
});

/**
 * Face-edge continuity: for every one of the 24 face sides, the mean difference between an edge texel and its
 * across-edge neighbour (on the adjacent face) must look like the difference between two interior neighbours.
 * A seam (a face missing a feature, a culled raster, stale gutters) makes the across-edge term jump.
 * The gutter texels must also agree with the adjacent face.
 */
describe('face-edge continuity', () => {
  const fc: FaceCoord = { face: 0, s: 0, t: 0 };
  const d: Vec3 = [0, 0, 0];
  function across(n: number, f: number, gx: number, gy: number): number {
    const T = n + 2;
    faceToDir(f, texelToS(gx, n), texelToS(gy, n), d);
    dirToFace(d[0], d[1], d[2], fc);
    const px = Math.min(n, Math.max(1, Math.round(sToTexel(fc.s, n))));
    const py = Math.min(n, Math.max(1, Math.round(sToTexel(fc.t, n))));
    return (fc.face * T + py) * T + px;
  }

  it.each(['rust', 'cinder', 'sulfur', 'ice shell', 'old ice', 'cryo'])('%s: height and splat continuous across face edges', (arch) => {
    const n = 96;
    const pd = planet(arch, 59329, n);
    const T = n + 2, H = pd.height;
    const splatL1 = (i: number, j: number) => {
      let s = 0;
      for (let c = 0; c < 4; c++) s += Math.abs(pd.splat0[i * 4 + c] - pd.splat0[j * 4 + c]) + Math.abs(pd.splat1[i * 4 + c] - pd.splat1[j * 4 + c]);
      return s;
    };
    let totA = 0, totB = 0, totSA = 0, totSB = 0;
    for (let f = 0; f < 6; f++)
      for (let side = 0; side < 4; side++) {
        let ah = 0, bh = 0, as = 0, bs = 0, cnt = 0;
        for (let k = 3; k <= n - 2; k++) {
          const [x, y, gx, gy, ix, iy] = side === 0 ? [1, k, 0, k, 2, k] : side === 1 ? [n, k, n + 1, k, n - 1, k]
            : side === 2 ? [k, 1, k, 0, k, 2] : [k, n, k, n + 1, k, n - 1];
          const i = (f * T + y) * T + x, j = across(n, f, gx, gy), m = (f * T + iy) * T + ix;
          ah += Math.abs(H[i] - H[j]); bh += Math.abs(H[i] - H[m]);
          as += splatL1(i, j); bs += splatL1(i, m);
          cnt++;
        }
        // Per side: generous bound (few samples), catches a whole-edge seam.
        expect(ah / cnt).toBeLessThan(3 * (bh / cnt) + 30);
        expect(as / cnt).toBeLessThan(3 * (bs / cnt) + 8);
        totA += ah; totB += bh; totSA += as; totSB += bs;
      }
    // Globally: across-edge differences statistically match interior ones.
    expect(totA).toBeLessThan(1.35 * totB + 1);
    expect(totSA).toBeLessThan(1.35 * totSB + 1);
  });

  it('gutters match the adjacent face (height within interior-step tolerance)', () => {
    const n = 96;
    const pd = planet('rust', 59329, n);
    const T = n + 2, H = pd.height;
    let gut = 0, inner = 0;
    for (let f = 0; f < 6; f++)
      for (let k = 2; k < n; k++) {
        const g = (f * T + k) * T + 0, j = across(n, f, 0, k);
        gut += Math.abs(H[g] - H[j]);
        inner += Math.abs(H[(f * T + k) * T + 1] - H[(f * T + k) * T + 2]);
      }
    expect(gut).toBeLessThan(1.2 * inner + 1);
  });
});
