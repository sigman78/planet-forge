// Baked colour map ("tone"): a per-world RGBA8 face array that tints the terrain albedo by region. Computed on
// the CPU when a world loads from what PlanetData already carries (geologic unit id, height, latitude) plus a
// few low-order noise fields and a palette drawn per world from the archetype's gamut, so cached planets get
// it without regeneration. Blurred over a few texels so no unit edge becomes a drawn line. RGB = tone / 2
// (128 is neutral); the shaders multiply the albedo by tone * 2. Pure function of the data.
import type { PlanetData } from './types.ts';
import { faceToDir, padFaces, texelToS } from './cube.ts';
import { Noise3, Rng } from '../gen/noise.ts';

type RGB = [number, number, number];
type Family = 'rocky' | 'ice' | 'volcanic';

const FAMILY: Record<string, Family> = {
  rust: 'rocky', cinder: 'rocky', 'grey moon': 'rocky', basalt: 'volcanic', sulfur: 'volcanic',
  'ice shell': 'ice', 'old ice': 'ice', cryo: 'ice', cryovolcanic: 'ice',
};

/**
 * Base tint per geologic unit id (GEO_UNITS order), linear multipliers around 1: how that unit differs from
 * the highlands of the same world. Maria and flows dark and a little blue, ejecta and rays bright, dunes warm,
 * canyon floors dark, caps neutral (their own layer is already white).
 */
const UNIT_TINT: RGB[] = [
  [1.0, 1.0, 1.0],      // 0 highlands
  [0.985, 0.985, 0.99], // 1 basin floor (a disk mask: a stronger tint draws a circle)
  [1.02, 1.02, 1.01],   // 2 basin massifs
  [0.74, 0.74, 0.8],    // 3 mare
  [0.78, 0.78, 0.8],    // 4 shield: lava like the mare it sits in (its footprint is a disk; a contrast draws a circle)
  [0.97, 0.96, 0.95],   // 5 rise
  [0.62, 0.61, 0.63],   // 6 lava flows / patera
  [0.86, 0.85, 0.84],   // 7 rift canyon
  [0.9, 0.89, 0.88],    // 8 chaos
  [1.08, 1.07, 1.06],   // 9 ejecta
  [1.2, 1.19, 1.18],    // 10 fresh rayed crater
  [1.05, 0.99, 0.9],    // 11 dune field
  [1.0, 1.0, 1.0],      // 12 polar cap
  [1.0, 1.0, 1.0],      // 13 frozen sea
  [1.0, 1.0, 1.0],      // 14 brine sea
  [1.12, 1.1, 1.06],    // 15 playa
  [1.0, 1.0, 1.0],      // 16 lineated ice
  [0.95, 0.95, 0.95],   // 17 graben / scarps
  [0.95, 0.95, 0.97],   // 18 smooth lowland
  [0.6, 0.6, 0.6],      // 19 lava lake
  [1.06, 1.0, 0.9],     // 20 plume / frost deposits
  [1.0, 1.0, 1.0],      // 21 cryodome
  [0.96, 0.96, 0.97],   // 22 cryolava
  [1.05, 1.05, 1.05],   // 23 grooved
  [1.07, 1.07, 1.07],   // 24 palimpsest
  [0.97, 0.96, 0.95],   // 25 cantaloupe
  [1.12, 1.12, 1.12],   // 26 facula
  [1.02, 1.02, 1.02],   // 27 block mountain
  [0.9, 0.92, 0.98],    // 28 fissure
  [0.78, 0.72, 0.66],   // 29 dark dirty ice
];

/** Family overrides: the same unit means a different material on an ice shell or a volcanic world. */
const FAMILY_TINT: Record<Family, Partial<Record<number, RGB>>> = {
  rocky: {},
  ice: { 8: [0.9, 0.85, 0.8], 7: [0.88, 0.9, 1.0], 28: [0.86, 0.9, 1.0], 18: [1.0, 1.0, 1.0], 11: [1.0, 1.0, 1.0] },
  volcanic: { 3: [0.8, 0.78, 0.76], 4: [0.66, 0.65, 0.64], 6: [0.55, 0.52, 0.5], 9: [1.04, 1.02, 1.0], 20: [1.08, 1.02, 0.86] },
};

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** The world's palette: unit tints jittered per world, plus the strengths of the large-scale fields. */
export function tonePalette(planet: PlanetData): { units: RGB[]; seed: number; dichotomy: number; regional: number; polar: number; hue: number } {
  const info = planet.info;
  const arch = info?.archetype ?? 'rust';
  const fam: Family = FAMILY[arch] ?? 'rocky';
  const seed = hashString(`${arch}|${info?.name ?? ''}|${Math.round(planet.radius)}`);
  const rng = new Rng(seed, 3);
  const units = UNIT_TINT.map((base, id) => {
    const t = FAMILY_TINT[fam][id] ?? base;
    // Brightness jitter ±10%, hue jitter ±4% per channel; neutral units (caps, seas, ice) keep their colour.
    const neutral = t[0] === 1 && t[1] === 1 && t[2] === 1;
    const b = neutral ? 1 : 1 + (rng.next() - 0.5) * 0.2;
    const j = neutral ? [0, 0, 0] : [(rng.next() - 0.5) * 0.08, (rng.next() - 0.5) * 0.08, (rng.next() - 0.5) * 0.08];
    return [t[0] * b * (1 + j[0]), t[1] * b * (1 + j[1]), t[2] * b * (1 + j[2])] as RGB;
  });
  // Field strengths per world: some worlds are nearly uniform, some strongly two-faced.
  const dichotomy = (fam === 'ice' ? 0.06 : 0.1) * (0.4 + 1.2 * rng.next());
  const regional = 0.05 + 0.05 * rng.next();
  const polar = fam === 'ice' ? 0.03 : 0.04 + 0.08 * rng.next();
  const hue = 0.03 + 0.03 * rng.next();
  return { units, seed, dichotomy, regional, polar, hue };
}

/**
 * Compute the tone map at the GPU layout (6 faces of (N + 2G)^2 RGBA8 texels). The per-texel field is built
 * on the data's own layout (N + 2, its gutters hold valid unit ids), padded bilinearly to the blur radius,
 * box-blurred per face and cropped to G.
 */
export function computeToneMap(planet: PlanetData, G: number): Uint8Array {
  const N = planet.N, T = N + 2;
  const pal = tonePalette(planet);
  const n = new Noise3(pal.seed);
  const cl = planet.climate;
  const raw = new Uint8Array(6 * T * T * 4);
  const d: [number, number, number] = [0, 0, 0];
  // Dichotomy axis: a random direction per world.
  const ar = new Rng(pal.seed, 5);
  const az = ar.next() * Math.PI * 2, el = Math.asin(ar.next() * 2 - 1);
  const ax = Math.cos(el) * Math.cos(az), ay = Math.sin(el), azz = Math.cos(el) * Math.sin(az);
  const o1 = ar.next() * 50, o2 = ar.next() * 50;
  for (let f = 0; f < 6; f++) {
    for (let y = 0; y < T; y++) {
      const t = texelToS(y, N);
      for (let x = 0; x < T; x++) {
        faceToDir(f, texelToS(x, N), t, d);
        const i = (f * T + y) * T + x;
        const u = pal.units[cl[i * 4 + 3]] ?? pal.units[0];
        // Hemispheric dichotomy: smooth cosine against the axis, warped a little so the boundary meanders.
        const c = d[0] * ax + d[1] * ay + d[2] * azz + 0.35 * n.simplex(d[0] * 1.5 + o1, d[1] * 1.5, d[2] * 1.5);
        const dich = Math.max(-1, Math.min(1, c * 1.4));
        // Regional drift: two octaves of low-order noise.
        const reg = n.simplex(d[0] * 3 + o2, d[1] * 3, d[2] * 3) + 0.5 * n.simplex(d[0] * 7 - o2, d[1] * 7, d[2] * 7);
        // Poleward brightening (dust and frost settle where it is cold).
        const lat = Math.abs(d[1]);
        const pole = 1 + pal.polar * lat * lat * lat;
        const k = (1 + pal.dichotomy * dich) * (1 + pal.regional * reg) * pole;
        // Hue tilt with the dichotomy: one face a little redder, the other a little bluer.
        const r = u[0] * k * (1 + pal.hue * dich), g = u[1] * k, b = u[2] * k * (1 - pal.hue * dich);
        raw[i * 4] = Math.round(255 * Math.min(0.99, Math.max(0.1, r * 0.5)));
        raw[i * 4 + 1] = Math.round(255 * Math.min(0.99, Math.max(0.1, g * 0.5)));
        raw[i * 4 + 2] = Math.round(255 * Math.min(0.99, Math.max(0.1, b * 0.5)));
        raw[i * 4 + 3] = 255;
      }
    }
  }
  const radius = Math.max(2, Math.round(N / 128));
  const P = Math.max(G, radius + 1);
  const blurred = boxBlurFaces(padFaces(raw, N, 4, P), N + 2 * P, 4, radius);
  return P === G ? blurred : cropGutter4(blurred, N, P, G);
}

/** Box blur (radius r) of every face of a (6, S, S, channels) array, per channel, via summed-area tables. */
function boxBlurFaces(data: Uint8Array, S: number, channels: number, r: number): Uint8Array {
  const out = new Uint8Array(data.length);
  const sat = new Float64Array((S + 1) * (S + 1));
  for (let f = 0; f < 6; f++) {
    const base = f * S * S;
    for (let c = 0; c < channels; c++) {
      for (let y = 0; y < S; y++) {
        let row = 0;
        for (let x = 0; x < S; x++) {
          row += data[(base + y * S + x) * channels + c];
          sat[(y + 1) * (S + 1) + x + 1] = sat[y * (S + 1) + x + 1] + row;
        }
      }
      for (let y = 0; y < S; y++) {
        const y0 = Math.max(0, y - r), y1 = Math.min(S, y + r + 1);
        for (let x = 0; x < S; x++) {
          const x0 = Math.max(0, x - r), x1 = Math.min(S, x + r + 1);
          const s = sat[y1 * (S + 1) + x1] - sat[y0 * (S + 1) + x1] - sat[y1 * (S + 1) + x0] + sat[y0 * (S + 1) + x0];
          out[(base + y * S + x) * channels + c] = Math.round(s / ((y1 - y0) * (x1 - x0)));
        }
      }
    }
  }
  return out;
}

function cropGutter4(data: Uint8Array, N: number, from: number, to: number): Uint8Array {
  const Tf = N + 2 * from, Tt = N + 2 * to, d = from - to;
  const out = new Uint8Array(6 * Tt * Tt * 4);
  for (let f = 0; f < 6; f++)
    for (let y = 0; y < Tt; y++) {
      const src = ((f * Tf + y + d) * Tf + d) * 4;
      out.set(data.subarray(src, src + Tt * 4), (f * Tt + y) * Tt * 4);
    }
  return out;
}
