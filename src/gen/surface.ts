// Surface stage (per face): temperature, volatile wetness, geologic unit id and the 8 geological splat layers.
// Layers: 0 dust, 1 highland, 2 basalt, 3 sand, 4 rock, 5 gravel, 6 ice, 7 salt.

import { faceToDir, texelToS } from '../core/cube.ts';
import type { Vec3 } from '../core/cube.ts';
import { Noise3, smoothstep } from './noise.ts';
import { TECT, VK } from './terrain.ts';
import { U } from './world.ts';
import type { WorldPlan } from './world.ts';

export interface SurfaceFaceInput {
  face: number;
  N: number;
  /** Final height (m, datum 0), T×T with refilled gutters. */
  height: Float32Array;
  featA: Uint8Array;
  featB: Uint8Array;
  vkind: Uint8Array;
  /** Cube-stage masks, RGBA: R flood basalt, G dunes, B closed-basin deposits, A unused. */
  aux: Uint8Array;
  /** Log flow 0..1. */
  flow: Float32Array;
  /** River / channel wetness 0..1. */
  wet: Float32Array;
}

export interface SurfaceFaceOutput {
  splat0: Uint8Array;
  splat1: Uint8Array;
  climate: Uint8Array;
}

const DUST = 0, HIGH = 1, BASALT = 2, SAND = 3, ROCK = 4, GRAVEL = 5, ICE = 6, SALT = 7;

/** Mean surface temperature (K) at latitude; thick atmospheres flatten the gradient. */
export function surfaceTemperature(plan: WorldPlan, lat: number, h: number): number {
  const b = plan.bulk;
  const P = b.atmospherePressureBar;
  const f = Math.pow(Math.max(0.04, Math.cos(lat)), 0.25) / 0.9;
  const smoothing = P / (P + 0.2);
  let T = b.surfaceTempK * (f * (1 - smoothing) + smoothing);
  if (P > 0.005) T -= (b.gravity / 1000) * Math.max(0, h) * 0.8; // dry adiabatic lapse ≈ g/cp
  return T;
}

export function generateSurfaceFace(plan: WorldPlan, inp: SurfaceFaceInput): SurfaceFaceOutput {
  const { face, N, height, featA, featB, vkind, aux, flow, wet } = inp;
  const T = N + 2;
  const R = plan.bulk.radiusKm * 1000;
  const noise = new Noise3(plan.p.seed ^ 0x5eed);
  const splat0 = new Uint8Array(T * T * 4);
  const splat1 = new Uint8Array(T * T * 4);
  const climate = new Uint8Array(T * T * 4);
  const dirs = new Float64Array(T * T * 3);
  const d: Vec3 = [0, 0, 0];
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      faceToDir(face, texelToS(x, N), texelToS(y, N), d);
      const i = (y * T + x) * 3;
      dirs[i] = d[0]; dirs[i + 1] = d[1]; dirs[i + 2] = d[2];
    }

  const w = new Float64Array(8);
  // Final weights per texel (normalised), blurred once before quantising (see below).
  const wAll = new Float32Array(T * T * 8);
  const rockSlope = plan.p.rockSlope;
  const sea = plan.bulk.seaKind;
  const icy = plan.icy;
  const arch = plan.archetype;
  const fam = plan.arch.family;
  const P = plan.bulk.atmospherePressureBar;
  const dustiness = Math.min(1, 0.35 + 0.25 * Math.log10(1 + P * 1000)); // atmospheres mantle everything in dust
  const fluids = plan.s.erosion > 0;
  const salt = plan.s.salt;
  const ax = plan.dichoAxis;

  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const idx = y * T + x;
      const px = dirs[idx * 3], py = dirs[idx * 3 + 1], pz = dirs[idx * 3 + 2];
      const h = height[idx];

      // --- slope (degrees) from the 3D tangent-plane gradient ---
      const xl = x > 0 ? x - 1 : x, xr = x < T - 1 ? x + 1 : x;
      const yl = y > 0 ? y - 1 : y, yr = y < T - 1 ? y + 1 : y;
      const il = y * T + xl, ir = y * T + xr, id = yl * T + x, iu = yr * T + x;
      const ax3 = (dirs[ir * 3] - dirs[il * 3]) * R, ay3 = (dirs[ir * 3 + 1] - dirs[il * 3 + 1]) * R, az3 = (dirs[ir * 3 + 2] - dirs[il * 3 + 2]) * R;
      const bx3 = (dirs[iu * 3] - dirs[id * 3]) * R, by3 = (dirs[iu * 3 + 1] - dirs[id * 3 + 1]) * R, bz3 = (dirs[iu * 3 + 2] - dirs[id * 3 + 2]) * R;
      const da = height[ir] - height[il], db = height[iu] - height[id];
      const aa = ax3 * ax3 + ay3 * ay3 + az3 * az3, bb = bx3 * bx3 + by3 * by3 + bz3 * bz3, ab = ax3 * bx3 + ay3 * by3 + az3 * bz3;
      const det = aa * bb - ab * ab;
      let g2 = 0;
      if (det > 1e-9) {
        const al = (da * bb - db * ab) / det;
        const be = (db * aa - da * ab) / det;
        g2 = Math.max(0, al * da + be * db);
      }
      const slope = (Math.atan(Math.sqrt(g2)) * 180) / Math.PI;

      const lat = Math.asin(py);
      const n1 = noise.fbm(px * 7 + 3.3, py * 7 - 1.2, pz * 7 + 7.7, 4);
      const n2 = noise.fbm(px * 31 - 9.1, py * 31 + 4.4, pz * 31 - 2.2, 3);
      const isSea = sea !== 'none' && h < 0;
      let temp = surfaceTemperature(plan, lat, h);
      // Active lava lakes in calderas above the lava-sea level (on edifices / figure highs): hot, unit LAVA_LAKE.
      const hotCaldera = sea === 'lava' && !isSea && vkind[idx] === VK.CALDERA;
      if (hotCaldera) temp = 1250;

      const ejecta = featA[idx * 4] / 255;
      const edifice = featA[idx * 4 + 1] / 255;
      const tect = featA[idx * 4 + 2];
      const floorV = featA[idx * 4 + 3];
      const rim = featB[idx * 4] / 255;
      const chaosV = featB[idx * 4 + 1];
      const flows = featB[idx * 4 + 2] / 255;
      const rayV = featB[idx * 4 + 3];
      const vk = vkind[idx];
      const flood = aux[idx * 4] / 255;
      const dune = aux[idx * 4 + 1] / 255;
      const playa = aux[idx * 4 + 2] / 255;
      const streakRaw = aux[idx * 4 + 3];
      const streak = streakRaw === 0 ? 0 : (streakRaw - 128) / 127;
      const capLat = py >= 0 ? plan.capLat[0] : plan.capLat[1];
      const cap = smoothstep(capLat - 0.02, capLat + 0.04, Math.abs(lat) + 0.03 * n1);
      const lowland = 0.5 - 0.5 * Math.tanh(3 * (px * ax[0] + py * ax[1] + pz * ax[2]));
      let rise = 0;
      for (const r of plan.rises) {
        const dot = px * r.x + py * r.y + pz * r.z;
        if (dot > 0) { const a = Math.acos(Math.min(1, dot)) / r.r; rise = Math.max(rise, Math.exp(-a * a * 2.2)); }
      }

      // --- splat weights (soft, then normalised to 255) ---
      w.fill(0);
      if (icy) {
        // Ice crust; old ice is darkened by a lag of dust and gravel, brightest on crests and fresh scars.
        const dark = arch === 'old ice' ? 0.55 + 0.35 * n1 + 0.2 * lowland : 0.12 + 0.12 * n1;
        w[ICE] = 1 - Math.max(0, Math.min(0.9, dark));
        w[DUST] = Math.max(0, dark) * 0.7;
        w[GRAVEL] = Math.max(0, dark) * 0.3;
        if (tect === TECT.LINEAE) { w[DUST] += 0.9; w[SALT] += 0.25 * salt; }
        if (tect === TECT.GROOVES) { w[ICE] += 1.2; w[HIGH] += 0.2; }
        if (floorV === 120) { w[ICE] += 1.0; w[SALT] += 0.3; }
      } else if (arch === 'sulfur') {
        // Sulfur plains: yellow-orange dust, frosty SO2 and white/red deposits in noisy patches.
        w[DUST] = 0.6 + 0.4 * n1;
        w[SALT] = (0.3 + 0.5 * smoothstep(-0.1, 0.4, n2)) * salt;
        w[HIGH] = 0.2 + 0.3 * smoothstep(0.1, 0.5, -n1);
      } else {
        const hi = smoothstep(-0.2, 0.3, n1 * 0.6 + (1 - lowland) * 0.6 - 0.3);
        w[HIGH] = (0.4 + 0.6 * hi) * (1.15 - dustiness);
        w[DUST] = dustiness * (0.5 + 0.8 * lowland) + 0.15 * smoothstep(0, 0.4, n2);
        if (fam === 'volcanic') w[BASALT] += 0.6;
      }
      // Volcanic plains and flows.
      if (flood > 0) { w[BASALT] += 2.5 * flood; w[HIGH] *= 1 - flood; w[DUST] *= 1 - 0.6 * flood; }
      if (vk === VK.CRYO || (icy && flows > 0)) { w[ICE] += 1.5 * Math.max(edifice, flows); w[SALT] += 0.6 * flows * salt; }
      else if (vk === VK.BLOCK) { w[HIGH] += 1.2 * edifice; w[GRAVEL] += 0.3; }
      else {
        if (edifice > 0) { w[BASALT] += 1.6 * edifice * (1 - 0.5 * dustiness); w[DUST] += 0.5 * edifice * dustiness; }
        if (flows > 0) w[BASALT] += 2 * flows;
      }
      if (vk === VK.CALDERA) { w[BASALT] += 4; }
      // Impacts: ejecta gravel, bright rim massifs, rays and faculae.
      if (ejecta > 0) w[GRAVEL] += 1.6 * ejecta;
      if (rim > 0) { w[HIGH] += 0.8 * rim; w[GRAVEL] += 0.4 * rim; }
      const darkHalo = rayV >= 245 && rayV < 255 ? (rayV - 244) / 10 : 0;
      if (rayV === 255) w[SALT] += 6;
      else if (darkHalo > 0) { w[BASALT] += 2 * darkHalo; w[GRAVEL] += 0.6 * darkHalo; }
      else if (rayV > 0) { const r = rayV / 240; if (arch === 'sulfur') { w[SALT] += 2.5 * r; w[DUST] += 0.5 * r; } else { w[icy ? ICE : HIGH] += 1.5 * r; w[SALT] += 0.8 * r; } }
      if (floorV === 255 && !icy) w[DUST] += 0.5;
      // Tectonics.
      if (tect === TECT.CANYON) { w[GRAVEL] += 1.0; w[SAND] += 0.4 * dustiness; }
      else if (tect === TECT.FISSURE) { w[SALT] += 2.5 * Math.max(0.4, salt); w[ICE] += 0.5; }
      else if (tect === TECT.FOSSAE) w[GRAVEL] += 0.5;
      if (chaosV === 255 || chaosV > 128) { w[GRAVEL] += 1.2; if (icy) { w[DUST] += 0.8; w[ICE] *= 0.6; } }
      else if (chaosV === 100) { w[DUST] += 0.6; w[GRAVEL] += 0.3; }
      // Cryo worlds: geyser frost snows near fissures and over the domes.
      if (fam === 'cryovolcanic') w[SALT] += salt * 0.35 * smoothstep(0, 0.5, n2 + 0.2 * edifice);
      // Wind and water.
      if (dune > 0) { w[SAND] += 3 * dune; }
      if (streak > 0) { w[DUST] += 2 * streak; w[SALT] += 0.9 * streak; }
      else if (streak < 0) { w[BASALT] += 2.5 * -streak; w[GRAVEL] += 0.6 * -streak; }
      if (playa > 0 && !isSea) w[SALT] += 3 * playa;
      if (fluids && wet[idx] > 0) { w[SAND] += 0.4 * wet[idx]; w[GRAVEL] += 0.4 * wet[idx]; }
      // Slope -> bare rock (crater walls, scarps, canyon walls, volcano flanks).
      const rk = smoothstep(rockSlope - 6, rockSlope + 6, slope + 3 * n2);
      // Cold traps and caps.
      let iceCover = cap;
      if (!icy && plan.bulk.volatileFrac > 0.005 && temp < 160 && sea !== 'lava') iceCover = Math.max(iceCover, 0.4 * smoothstep(160, 120, temp));
      if (isSea) {
        w.fill(0);
        if (sea === 'lava') { w[BASALT] = 1; temp = 1250; }
        else if (sea === 'ice') { w[ICE] = 1; w[SALT] = 0.25; }
        else { w[SAND] = 0.6; w[SALT] = 0.4; }
      } else {
        let tot = 0;
        for (let l = 0; l < 8; l++) tot += w[l];
        if (tot < 1e-6) { w[DUST] = 1; tot = 1; }
        for (let l = 0; l < 8; l++) w[l] /= tot;
        const rockW = rk * (1 - 0.6 * iceCover) * (icy ? 0.75 : 1);
        for (let l = 0; l < 8; l++) w[l] *= 1 - rockW - iceCover * (1 - rockW);
        w[ROCK] += rockW;
        w[ICE] += iceCover * (1 - rockW);
      }

      // --- geologic unit ---
      let unit: number;
      if (isSea || hotCaldera) unit = sea === 'lava' ? U.LAVA_LAKE : sea === 'ice' ? U.FROZEN_SEA : U.SEA;
      else if (cap > 0.5) unit = U.POLAR_CAP;
      else if (rayV === 255) unit = U.FACULA;
      else if (vk === VK.CALDERA) unit = U.FLOWS;
      else if (darkHalo > 0.45) unit = U.DARK_HALO;
      else if (rayV > 120) unit = arch === 'sulfur' ? U.PLUME_DEPOSITS : U.RAYED;
      else if (vk === VK.CRYO) unit = U.CRYO_DOME;
      else if (vk === VK.BLOCK) unit = U.BLOCK_MOUNTAIN;
      else if (vk === VK.EDIFICE && edifice > 0.5) unit = U.SHIELD;
      else if (flows > 0.5) unit = icy ? U.CRYO_FLOWS : U.FLOWS;
      else if (tect === TECT.FISSURE) unit = U.FISSURE;
      else if (tect === TECT.CANYON) unit = U.CANYON;
      else if (chaosV > 128) unit = U.CHAOS;
      else if (chaosV === 100) unit = U.CANTALOUPE;
      else if (dune > 0.5) unit = U.DUNES;
      else if (Math.abs(streak) > 0.35) unit = U.WIND_STREAK;
      else if (playa > 0.5) unit = arch === 'sulfur' || icy ? U.PLUME_DEPOSITS : U.PLAYA;
      else if (flood > 0.5) unit = U.MARE;
      else if (tect === TECT.FOSSAE) unit = U.FOSSAE;
      else if (tect === TECT.GROOVES) unit = U.GROOVED;
      else if (floorV === 120) unit = U.PALIMPSEST;
      else if (ejecta > 0.5) unit = U.EJECTA;
      else if (rim > 0.5) unit = U.BASIN_RIM;
      else if (floorV > 128) unit = U.BASIN_FLOOR;
      else if (rise > 0.45) unit = U.RISE;
      else if (icy) unit = arch === 'old ice' ? U.DIRTY_ICE : U.LINEATED_ICE;
      else if (arch === 'sulfur') unit = U.PLUME_DEPOSITS;
      else unit = lowland > 0.6 && plan.dichoAmp > 300 ? U.SMOOTH_PLAINS : U.HIGHLANDS;

      // Ragged material edges: where layers compete, a per-layer noise decides, so boundaries become irregular
      // instead of following mask contours and texel staircases. Dominant layers barely change.
      let wsum = 0, wmax = 0;
      for (let l = 0; l < 8; l++) {
        wsum += Math.max(w[l], 0);
        wmax = Math.max(wmax, w[l]);
      }
      if (!isSea && wmax < 0.85 * wsum) {
        const na = noise.fbm(px * 90 + 1.7, py * 90 - 8.3, pz * 90 + 4.1, 2);
        const nb = noise.fbm(px * 90 - 6.2, py * 90 + 2.9, pz * 90 - 3.6, 2);
        wsum = 0;
        for (let l = 0; l < 8; l++) {
          w[l] *= Math.exp(RAGGED * (RAG_C[l] * na + RAG_S[l] * nb));
          wsum += Math.max(w[l], 0);
        }
      }
      for (let l = 0; l < 8; l++) wAll[idx * 8 + l] = wsum > 0 ? Math.max(w[l], 0) / wsum : l === 0 ? 1 : 0;
      const o = idx * 4;
      climate[o] = clampByte(temp / 2);
      const wetness = isSea ? 1 : fluids ? Math.max(wet[idx], 0.3 * iceCover) : 0.3 * iceCover;
      climate[o + 1] = clampByte(wetness * 255);
      climate[o + 2] = fluids ? clampByte(flow[idx] * 255) : 0;
      climate[o + 3] = unit;
    }
  }
  // Soften the weights with a 3x3 binomial blur (interior texels; the gutters are refilled after assembly).
  // Mask edges and slope-driven rock otherwise switch within a single texel, which reads as hard spots and
  // pixel staircases on canyon walls.
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      const idx = y * T + x;
      if (x === 0 || y === 0 || x === T - 1 || y === T - 1) {
        for (let l = 0; l < 8; l++) w[l] = wAll[idx * 8 + l];
      } else {
        w.fill(0);
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const k = (dx === 0 ? 2 : 1) * (dy === 0 ? 2 : 1);
            const j = (idx + dy * T + dx) * 8;
            for (let l = 0; l < 8; l++) w[l] += k * wAll[j + l];
          }
      }
      writeSplat(w, splat0, splat1, idx * 4);
    }
  return { splat0, splat1, climate };
}

/** Strength of the per-layer edge noise, and each layer's direction in the (na, nb) noise plane. */
const RAGGED = 0.6;
const RAG_C = Array.from({ length: 8 }, (_, l) => Math.cos(l * 2.39996));
const RAG_S = Array.from({ length: 8 }, (_, l) => Math.sin(l * 2.39996));

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

const _q = new Float64Array(8);
const _r = new Int32Array(8);
/** Normalise 8 weights to integers summing to exactly 255 (largest remainder). */
export function writeSplat(w: Float64Array, s0: Uint8Array, s1: Uint8Array, o: number): void {
  let sum = 0;
  for (let l = 0; l < 8; l++) { const v = w[l] > 0 ? w[l] : 0; _q[l] = v; sum += v; }
  if (sum <= 0) { _q.fill(0); _q[0] = 1; sum = 1; }
  let tot = 0;
  for (let l = 0; l < 8; l++) {
    const v = (_q[l] / sum) * 255;
    const fl = Math.floor(v);
    _r[l] = fl;
    _q[l] = v - fl;
    tot += fl;
  }
  while (tot < 255) {
    let best = 0;
    for (let l = 1; l < 8; l++) if (_q[l] > _q[best]) best = l;
    _r[best]++;
    _q[best] = -1;
    tot++;
  }
  s0[o] = _r[0]; s0[o + 1] = _r[1]; s0[o + 2] = _r[2]; s0[o + 3] = _r[3];
  s1[o] = _r[4]; s1[o + 1] = _r[5]; s1[o + 2] = _r[6]; s1[o + 3] = _r[7];
}
