// Debug renderers: equirectangular and orthographic-globe RGB images from the cube data (pure, no Node APIs).

import { dirToFace, sampleDir, sToTexel } from '../core/cube.ts';
import type { FaceCoord } from '../core/cube.ts';
import type { PlanetData } from '../core/types.ts';
import { BIOMES } from './climate.ts';

/** Debug colours per splat layer (index = layer). */
export const LAYER_COLORS: ReadonlyArray<[number, number, number]> = [
  [226, 210, 160], // beach_sand
  [96, 150, 60], // grass
  [38, 88, 40], // forest
  [170, 160, 90], // dry_grass
  [214, 150, 84], // desert
  [120, 112, 106], // rock
  [78, 74, 72], // gravel
  [245, 248, 252], // snow
];

export type ColorMode = 'biome' | 'splat' | 'height';

/** Same convention as three.js equirect: u = atan2(z,x)/2π + 0.5, v = asin(y)/π + 0.5, row 0 = +Y. */
function equirectDir(i: number, j: number, W: number, Hh: number, out: Float64Array): void {
  const lon = ((i + 0.5) / W - 0.5) * Math.PI * 2;
  const lat = Math.PI / 2 - ((j + 0.5) / Hh) * Math.PI;
  out[0] = Math.cos(lat) * Math.cos(lon);
  out[1] = Math.sin(lat);
  out[2] = Math.cos(lat) * Math.sin(lon);
}

/** Per-channel float views of the RGBA cubes, so bilinear `sampleDir` can be used per channel. */
interface Views { splat: Float32Array[]; }
const _views = new WeakMap<PlanetData, Views>();
function views(pd: PlanetData): Views {
  let v = _views.get(pd);
  if (!v) {
    const n = pd.splat0.length / 4;
    const splat: Float32Array[] = [];
    for (let l = 0; l < 8; l++) {
      const src = l < 4 ? pd.splat0 : pd.splat1;
      const a = new Float32Array(n);
      for (let i = 0; i < n; i++) a[i] = src[i * 4 + (l & 3)];
      splat.push(a);
    }
    v = { splat };
    _views.set(pd, v);
  }
  return v;
}

const _fc: FaceCoord = { face: 0, s: 0, t: 0 };
/** Nearest-texel read of one channel of an RGBA cube (for ids). */
function nearestRGBA(data: Uint8Array, N: number, x: number, y: number, z: number, c: number): number {
  const T = N + 2;
  dirToFace(x, y, z, _fc);
  const px = Math.min(N, Math.max(1, Math.round(sToTexel(_fc.s, N))));
  const py = Math.min(N, Math.max(1, Math.round(sToTexel(_fc.t, N))));
  return data[((_fc.face * T + py) * T + px) * 4 + c];
}

function oceanColor(h: number, maxDepth: number, out: Float64Array): void {
  const t = Math.min(1, -h / Math.max(1, maxDepth));
  const s = Math.pow(t, 0.5);
  out[0] = 40 * (1 - s) + 8 * s;
  out[1] = 110 * (1 - s) + 24 * s;
  out[2] = 160 * (1 - s) + 70 * s;
}

function hypsoColor(h: number, maxH: number, out: Float64Array): void {
  const stops: [number, number, number, number][] = [
    [0, 70, 120, 60], [0.05, 110, 150, 70], [0.15, 170, 170, 100], [0.3, 160, 130, 90], [0.55, 130, 115, 105], [0.8, 200, 200, 200], [1, 255, 255, 255],
  ];
  const t = Math.max(0, Math.min(1, h / Math.max(1, maxH)));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const a = stops[i - 1], b = stops[i];
      const k = (t - a[0]) / (b[0] - a[0]);
      out[0] = a[1] + (b[1] - a[1]) * k;
      out[1] = a[2] + (b[2] - a[2]) * k;
      out[2] = a[3] + (b[3] - a[3]) * k;
      return;
    }
  }
}

function surfaceColor(pd: PlanetData, mode: ColorMode, x: number, y: number, z: number, h: number, out: Float64Array, showOcean: boolean): void {
  if (h < 0 && showOcean && mode !== 'splat') { oceanColor(h, Math.max(1, -pd.minHeight), out); return; }
  if (mode === 'height' || (mode === 'biome' && !pd.climate)) { hypsoColor(Math.max(h, 0), pd.maxHeight, out); if (h < 0) { out[0] *= 0.7; out[1] *= 0.7; out[2] *= 0.8; } return; }
  if (mode === 'biome') {
    const id = nearestRGBA(pd.climate, pd.N, x, y, z, 3);
    const b = BIOMES[Math.max(0, Math.min(BIOMES.length - 1, id))];
    out[0] = b.color[0]; out[1] = b.color[1]; out[2] = b.color[2];
    return;
  }
  // splat: weighted blend of layer colours.
  out[0] = 0; out[1] = 0; out[2] = 0;
  let tot = 0;
  const sv = views(pd).splat;
  for (let l = 0; l < 8; l++) {
    const w = sampleDir(sv[l], pd.N, x, y, z);
    tot += w;
    out[0] += LAYER_COLORS[l][0] * w; out[1] += LAYER_COLORS[l][1] * w; out[2] += LAYER_COLORS[l][2] * w;
  }
  if (tot > 0) { out[0] /= tot; out[1] /= tot; out[2] /= tot; }
  if (h < 0 && showOcean) { out[0] *= 0.55; out[1] *= 0.65; out[2] *= 0.85; }
}

/** Lambert hillshade factor from the height gradient around direction d (light from the north-west, high). */
function hillshade(pd: PlanetData, x: number, y: number, z: number, step: number, exaggerate: number): number {
  // Local east/north tangent frame (Y is the spin axis).
  let ex = -z, ez = x;
  const el = Math.hypot(ex, ez) || 1;
  ex /= el; ez /= el;
  const nx = -ez * y, ny = ez * x - ex * z, nz = ex * y;
  const N = pd.N, H = pd.height;
  const he = sampleDir(H, N, x + ex * step, y, z + ez * step);
  const hw = sampleDir(H, N, x - ex * step, y, z - ez * step);
  const hn = sampleDir(H, N, x + nx * step, y + ny * step, z + nz * step);
  const hs = sampleDir(H, N, x - nx * step, y - ny * step, z - nz * step);
  const dist = 2 * step * pd.radius;
  const gx = ((he - hw) / dist) * exaggerate;
  const gy = ((hn - hs) / dist) * exaggerate;
  // Normal = (-gx, -gy, 1); light from NW.
  const lx = -0.5, ly = 0.6, lz = 0.62;
  const inv = 1 / Math.sqrt(gx * gx + gy * gy + 1);
  const d = (-gx * lx - gy * ly + lz) * inv;
  return Math.max(0, d) / lz;
}

export interface PreviewOptions {
  mode: ColorMode;
  showOcean?: boolean;
  exaggerate?: number;
  /** Draw clouds over the surface (0..1 opacity). */
  clouds?: number;
}

/** Equirectangular RGB preview (W×H). */
export function renderEquirect(pd: PlanetData, W: number, Hh: number, opt: PreviewOptions): Uint8Array {
  const out = new Uint8Array(W * Hh * 3);
  const d = new Float64Array(3);
  const col = new Float64Array(3);
  const step = (Math.PI / 2) / pd.N * 0.75;
  const showOcean = opt.showOcean ?? true;
  const ex = opt.exaggerate ?? 4;
  for (let j = 0; j < Hh; j++) {
    for (let i = 0; i < W; i++) {
      equirectDir(i, j, W, Hh, d);
      const x = d[0], y = d[1], z = d[2];
      const h = sampleDir(pd.height, pd.N, x, y, z);
      surfaceColor(pd, opt.mode, x, y, z, h, col, showOcean);
      let shade = 1;
      if (!(h < 0 && showOcean) || opt.mode === 'splat') shade = 0.35 + 0.65 * hillshade(pd, x, y, z, step, ex);
      let r = col[0] * shade, g = col[1] * shade, b = col[2] * shade;
      if (opt.clouds && pd.clouds) {
        const c = (sampleDir(pd.clouds, pd.cloudN, x, y, z) / 255) * opt.clouds;
        r += (250 - r) * c; g += (250 - g) * c; b += (252 - b) * c;
      }
      const o = (j * W + i) * 3;
      out[o] = Math.min(255, r); out[o + 1] = Math.min(255, g); out[o + 2] = Math.min(255, b);
    }
  }
  return out;
}

/** Cloud coverage as greyscale over dark blue (equirect). */
export function renderCloudsEquirect(pd: PlanetData, W: number, Hh: number): Uint8Array {
  const out = new Uint8Array(W * Hh * 3);
  const d = new Float64Array(3);
  for (let j = 0; j < Hh; j++)
    for (let i = 0; i < W; i++) {
      equirectDir(i, j, W, Hh, d);
      const c = sampleDir(pd.clouds, pd.cloudN, d[0], d[1], d[2]) / 255;
      const o = (j * W + i) * 3;
      out[o] = 10 + 245 * c; out[o + 1] = 20 + 235 * c; out[o + 2] = 45 + 210 * c;
    }
  return out;
}

/**
 * Two orthographic globe views side by side (size 2S×S), lit by a sun from the upper left,
 * with height-exaggerated shading, ocean and optional clouds. Gives an "from orbit" impression.
 */
export function renderGlobes(pd: PlanetData, S: number, opt: PreviewOptions & { yaw?: number }): Uint8Array {
  const out = new Uint8Array(2 * S * S * 3);
  const col = new Float64Array(3);
  const step = (Math.PI / 2) / pd.N * 0.75;
  const showOcean = opt.showOcean ?? true;
  const ex = opt.exaggerate ?? 4;
  const tilt = 0.35;
  for (let view = 0; view < 2; view++) {
    const yaw = (opt.yaw ?? 0.6) + view * Math.PI;
    const cy = Math.cos(yaw), sy = Math.sin(yaw), ct = Math.cos(tilt), st = Math.sin(tilt);
    for (let j = 0; j < S; j++)
      for (let i = 0; i < S; i++) {
        const o = (j * 2 * S + view * S + i) * 3;
        const u = ((i + 0.5) / S) * 2 - 1;
        const v = 1 - ((j + 0.5) / S) * 2;
        const r2 = u * u + v * v;
        if (r2 >= 1) { out[o] = 4; out[o + 1] = 5; out[o + 2] = 10; continue; }
        const w = Math.sqrt(1 - r2);
        // View space (u right, v up, w toward viewer) -> world: tilt about X, then yaw about Y.
        const vy = v * ct + w * st;
        const vz = -v * st + w * ct;
        const x = u * cy + vz * sy;
        const z = -u * sy + vz * cy;
        const y = vy;
        const h = sampleDir(pd.height, pd.N, x, y, z);
        surfaceColor(pd, opt.mode, x, y, z, h, col, showOcean);
        // Sun from upper left, in view space.
        const sun = Math.max(0, (-0.55 * u + 0.5 * v + 0.67 * w));
        let shade = 0.08 + 0.92 * sun;
        if (!(h < 0 && showOcean)) shade *= 0.45 + 0.55 * hillshade(pd, x, y, z, step, ex);
        let r = col[0] * shade, g = col[1] * shade, b = col[2] * shade;
        if (opt.clouds && pd.clouds) {
          const c = (sampleDir(pd.clouds, pd.cloudN, x, y, z) / 255) * opt.clouds;
          const cl = 255 * (0.1 + 0.9 * sun);
          r += (cl - r) * c; g += (cl - g) * c; b += (cl * 1.02 - b) * c;
        }
        // Thin atmosphere rim.
        const rim = Math.pow(1 - w, 3) * 0.6;
        r += (90 - r) * rim * (0.3 + sun); g += (140 - g) * rim * (0.3 + sun); b += (255 - b) * rim * (0.3 + sun);
        out[o] = Math.min(255, r); out[o + 1] = Math.min(255, g); out[o + 2] = Math.min(255, b);
      }
  }
  return out;
}
