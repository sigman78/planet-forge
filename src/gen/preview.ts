// Debug renderers: equirectangular, orthographic globes and gnomonic close-ups from the cube data
// (pure, no Node APIs). Modes: 'splat' (tinted layer colours), 'units' (geologic map), 'height' (hypsometric).

import { dirToFace, sampleDir, sToTexel } from '../core/cube.ts';
import type { FaceCoord } from '../core/cube.ts';
import type { PlanetData } from '../core/types.ts';
import { GEO_UNITS } from './world.ts';

/**
 * Mean linear albedo of the renderer's texture set per splat layer (public/textures/manifest.json):
 * dust, highland, basalt, sand, rock, gravel, ice, salt. look.layerTints multiply these (linear).
 */
export const LAYER_ALBEDO: ReadonlyArray<[number, number, number]> = [
  [0.213, 0.203, 0.186],
  [0.315, 0.304, 0.282],
  [0.068, 0.066, 0.062],
  [0.339, 0.297, 0.261],
  [0.124, 0.121, 0.113],
  [0.163, 0.152, 0.135],
  [0.617, 0.643, 0.599],
  [0.58, 0.556, 0.515],
];

const toSrgb = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.min(1, v), 1 / 2.4) - 0.055);

/** Untinted debug colour per splat layer (sRGB 0..255), from LAYER_ALBEDO. */
export const LAYER_COLORS: ReadonlyArray<[number, number, number]> = LAYER_ALBEDO.map(
  (c) => [Math.round(toSrgb(c[0])), Math.round(toSrgb(c[1])), Math.round(toSrgb(c[2]))] as [number, number, number],
);

export type ColorMode = 'splat' | 'units' | 'height';

interface Views { splat: Float32Array[]; cols: [number, number, number][] }
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
    const tints = pd.info?.look.layerTints;
    const cols = LAYER_ALBEDO.map((c, l) => {
      const t = tints?.[l] ?? [1, 1, 1];
      return [c[0] * t[0], c[1] * t[1], c[2] * t[2]] as [number, number, number];
    });
    v = { splat, cols };
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

function hexRgb(h: string): [number, number, number] {
  const v = parseInt(h.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function seaColor(pd: PlanetData, h: number, out: Float64Array): boolean {
  const kind = pd.info?.look.seaKind ?? 'none';
  if (kind === 'none' || h >= 0) return false;
  const deep = hexRgb(pd.info!.look.seaDeepColor), sh = hexRgb(pd.info!.look.seaShallowColor);
  const t = Math.min(1, -h / (kind === 'lava' ? 400 : 1500));
  out[0] = sh[0] + (deep[0] - sh[0]) * t; out[1] = sh[1] + (deep[1] - sh[1]) * t; out[2] = sh[2] + (deep[2] - sh[2]) * t;
  return true;
}

function hypsoColor(h: number, lo: number, hi: number, out: Float64Array): void {
  const stops: [number, number, number, number][] = [
    [0, 20, 30, 90], [0.25, 40, 110, 160], [0.45, 90, 160, 90], [0.6, 190, 180, 100], [0.8, 160, 100, 60], [1, 255, 255, 255],
  ];
  const t = Math.max(0, Math.min(1, (h - lo) / Math.max(1, hi - lo)));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const a = stops[i - 1], b = stops[i];
      const k = (t - a[0]) / (b[0] - a[0]);
      out[0] = a[1] + (b[1] - a[1]) * k; out[1] = a[2] + (b[2] - a[2]) * k; out[2] = a[3] + (b[3] - a[3]) * k;
      return;
    }
  }
}

/** Returns true when the texel is sea (no hillshade). */
function surfaceColor(pd: PlanetData, mode: ColorMode, x: number, y: number, z: number, h: number, out: Float64Array): boolean {
  if (mode === 'height') { hypsoColor(h, pd.minHeight, pd.maxHeight, out); return false; }
  if (mode === 'units') {
    const id = nearestRGBA(pd.climate, pd.N, x, y, z, 3);
    const u = GEO_UNITS[id] ?? GEO_UNITS[0];
    out[0] = u.color[0] * 255; out[1] = u.color[1] * 255; out[2] = u.color[2] * 255;
    return false;
  }
  if (seaColor(pd, h, out)) return true;
  const v = views(pd);
  out[0] = 0; out[1] = 0; out[2] = 0;
  let tot = 0;
  for (let l = 0; l < 8; l++) {
    const w = sampleDir(v.splat[l], pd.N, x, y, z);
    tot += w;
    out[0] += v.cols[l][0] * w; out[1] += v.cols[l][1] * w; out[2] += v.cols[l][2] * w;
  }
  if (tot > 0) { out[0] /= tot; out[1] /= tot; out[2] /= tot; }
  // Linear albedo -> sRGB, lifted 1.6x so an albedo-0.1 world is still readable in a preview.
  out[0] = toSrgb(out[0] * 1.6); out[1] = toSrgb(out[1] * 1.6); out[2] = toSrgb(out[2] * 1.6);
  return false;
}

/** Lambert hillshade factor from the height gradient (light from the north-west, fairly low). */
function hillshade(pd: PlanetData, x: number, y: number, z: number, step: number, exaggerate: number): number {
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
  const lx = -0.55, ly = 0.55, lz = 0.63;
  const inv = 1 / Math.sqrt(gx * gx + gy * gy + 1);
  return Math.max(0, (-gx * lx - gy * ly + lz) * inv) / lz;
}

export interface PreviewOptions {
  mode: ColorMode;
  exaggerate?: number;
}

function equirectDir(i: number, j: number, W: number, Hh: number, out: Float64Array): void {
  const lon = ((i + 0.5) / W - 0.5) * Math.PI * 2;
  const lat = Math.PI / 2 - ((j + 0.5) / Hh) * Math.PI;
  out[0] = Math.cos(lat) * Math.cos(lon);
  out[1] = Math.sin(lat);
  out[2] = Math.cos(lat) * Math.sin(lon);
}

/** Equirectangular RGB preview (three.js equirect convention: u = atan2(z,x)/2π + 0.5, row 0 = +Y). */
export function renderEquirect(pd: PlanetData, W: number, Hh: number, opt: PreviewOptions): Uint8Array {
  const out = new Uint8Array(W * Hh * 3);
  const d = new Float64Array(3);
  const col = new Float64Array(3);
  const step = (Math.PI / 2) / pd.N * 0.75;
  const ex = opt.exaggerate ?? 1;
  for (let j = 0; j < Hh; j++) {
    for (let i = 0; i < W; i++) {
      equirectDir(i, j, W, Hh, d);
      const x = d[0], y = d[1], z = d[2];
      const h = sampleDir(pd.height, pd.N, x, y, z);
      const isSea = surfaceColor(pd, opt.mode, x, y, z, h, col);
      const shade = isSea ? 1 : 0.3 + 0.7 * hillshade(pd, x, y, z, step, ex);
      const o = (j * W + i) * 3;
      out[o] = Math.min(255, col[0] * shade); out[o + 1] = Math.min(255, col[1] * shade); out[o + 2] = Math.min(255, col[2] * shade);
    }
  }
  return out;
}

/**
 * Two orthographic globe views side by side (2S×S), sun from the upper left, with the true relief displacing
 * the silhouette (exaggerated by `exaggerate`) and an atmosphere rim tinted by the look hints.
 */
export function renderGlobes(pd: PlanetData, S: number, opt: PreviewOptions & { yaw?: number }): Uint8Array {
  const out = new Uint8Array(2 * S * S * 3);
  const col = new Float64Array(3);
  const step = (Math.PI / 2) / pd.N * 0.75;
  const ex = opt.exaggerate ?? 1;
  const tilt = 0.35;
  const look = pd.info?.look;
  const ray = look ? look.rayleigh : [5.8, 13.5, 33.1];
  const rm = Math.max(ray[0], ray[1], ray[2]);
  const atmoCol = [255 * (ray[0] / rm) * 0.8 + 50 * Math.min(1, (look?.mie ?? 0) / 20), 255 * (ray[1] / rm) * 0.8 + 40 * Math.min(1, (look?.mie ?? 0) / 20), 255 * (ray[2] / rm)];
  const atmoK = Math.min(1, 0.25 + 0.6 * (look?.atmoDensity ?? 0.1));
  // Max relief as a fraction of the radius, to scale the disc so the silhouette fits.
  const reliefMax = (Math.max(pd.maxHeight, -pd.minHeight) / pd.radius) * ex;
  const scale = 1 / (1 + reliefMax + 0.04);
  for (let view = 0; view < 2; view++) {
    const yaw = (opt.yaw ?? 0.6) + view * Math.PI;
    const cy = Math.cos(yaw), sy = Math.sin(yaw), ct = Math.cos(tilt), st = Math.sin(tilt);
    for (let j = 0; j < S; j++)
      for (let i = 0; i < S; i++) {
        const o = (j * 2 * S + view * S + i) * 3;
        const u = (((i + 0.5) / S) * 2 - 1) / scale;
        const v = (1 - ((j + 0.5) / S) * 2) / scale;
        const r2 = u * u + v * v;
        out[o] = 3; out[o + 1] = 4; out[o + 2] = 9;
        // Ray-march the relief silhouette along the view ray (orthographic, w toward viewer).
        const rMax = 1 + reliefMax;
        if (r2 >= rMax * rMax) {
          const rr = Math.sqrt(r2);
          const glow = Math.exp(-(rr - 1) * 40) * atmoK * 0.7;
          out[o] = Math.min(255, 3 + atmoCol[0] * glow); out[o + 1] = Math.min(255, 4 + atmoCol[1] * glow); out[o + 2] = Math.min(255, 9 + atmoCol[2] * glow);
          continue;
        }
        let hit = false, x = 0, y = 0, z = 0, h = 0, w = 0;
        const wTop = Math.sqrt(Math.max(0, rMax * rMax - r2));
        const steps = 48;
        for (let s = 0; s <= steps; s++) {
          w = wTop - (s / steps) * wTop * 2;
          const rr = Math.sqrt(r2 + w * w);
          const vy = (v * ct + w * st) / rr, vz = (-v * st + w * ct) / rr, vx = u / rr;
          x = vx * cy + vz * sy; z = -vx * sy + vz * cy; y = vy;
          h = sampleDir(pd.height, pd.N, x, y, z);
          const surf = 1 + (Math.max(h, look?.seaKind && look.seaKind !== 'none' ? 0 : h) / pd.radius) * ex;
          if (rr <= surf) { hit = true; break; }
        }
        if (!hit) {
          const rr = Math.sqrt(r2);
          const glow = Math.exp(-Math.max(0, rr - 1) * 40) * atmoK * 0.7;
          out[o] = Math.min(255, 3 + atmoCol[0] * glow); out[o + 1] = Math.min(255, 4 + atmoCol[1] * glow); out[o + 2] = Math.min(255, 9 + atmoCol[2] * glow);
          continue;
        }
        const isSea = surfaceColor(pd, opt.mode, x, y, z, h, col);
        const rr = Math.sqrt(r2 + w * w);
        const nz = w / rr;
        const sun = Math.max(0, -0.55 * (u / rr) + 0.5 * (v / rr) + 0.67 * nz);
        let shade = 0.04 + 0.96 * sun;
        if (!isSea) shade *= 0.35 + 0.65 * hillshade(pd, x, y, z, step, ex * 2);
        let r = col[0] * shade, g = col[1] * shade, b = col[2] * shade;
        if (isSea && look?.seaKind === 'lava') { r = col[0] * 0.9; g = col[1] * 0.7; b = col[2] * 0.6; }
        const rim = Math.pow(1 - Math.min(1, nz), 2.5) * atmoK;
        const lit = 0.25 + sun;
        r += (atmoCol[0] - r) * rim * 0.6 * lit; g += (atmoCol[1] - g) * rim * 0.6 * lit; b += (atmoCol[2] - b) * rim * 0.6 * lit;
        out[o] = Math.min(255, Math.max(0, r)); out[o + 1] = Math.min(255, Math.max(0, g)); out[o + 2] = Math.min(255, Math.max(0, b));
      }
  }
  return out;
}

/** Gnomonic close-up (S×S) centred at lon/lat (degrees, equirect convention) with the given field of view (degrees). */
export function renderZoom(pd: PlanetData, S: number, lonDeg: number, latDeg: number, fovDeg: number, opt: PreviewOptions): Uint8Array {
  const out = new Uint8Array(S * S * 3);
  const col = new Float64Array(3);
  const lon = (lonDeg * Math.PI) / 180, lat = (latDeg * Math.PI) / 180;
  const cx = Math.cos(lat) * Math.cos(lon), cy = Math.sin(lat), cz = Math.cos(lat) * Math.sin(lon);
  let ex = -cz, ez = cx;
  const el = Math.hypot(ex, ez) || 1;
  ex /= el; ez /= el;
  const nx = -ez * cy, ny = ez * cx - ex * cz, nz = ex * cy;
  const half = Math.tan((fovDeg * Math.PI) / 360);
  const step = (Math.PI / 2) / pd.N * 0.75;
  for (let j = 0; j < S; j++)
    for (let i = 0; i < S; i++) {
      const u = (((i + 0.5) / S) * 2 - 1) * half, v = (1 - ((j + 0.5) / S) * 2) * half;
      let x = cx + ex * u + nx * v, y = cy + ny * v, z = cz + ez * u + nz * v;
      const l = 1 / Math.hypot(x, y, z);
      x *= l; y *= l; z *= l;
      const h = sampleDir(pd.height, pd.N, x, y, z);
      const isSea = surfaceColor(pd, opt.mode, x, y, z, h, col);
      const shade = isSea ? 1 : 0.25 + 0.75 * hillshade(pd, x, y, z, step, opt.exaggerate ?? 1);
      const o = (j * S + i) * 3;
      out[o] = Math.min(255, col[0] * shade); out[o + 1] = Math.min(255, col[1] * shade); out[o + 2] = Math.min(255, col[2] * shade);
    }
  return out;
}
