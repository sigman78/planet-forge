// Tiny stand-in planet used only while developing the renderer (no erosion/climate). Not used in production.
import { faceToDir, texelToS } from '../core/cube.ts';
import type { PlanetData } from '../core/types.ts';

function hash(x: number, y: number, z: number) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x: number, y: number, z: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(
    l(l(hash(xi, yi, zi), hash(xi + 1, yi, zi), u), l(hash(xi, yi + 1, zi), hash(xi + 1, yi + 1, zi), u), v),
    l(l(hash(xi, yi, zi + 1), hash(xi + 1, yi, zi + 1), u), l(hash(xi, yi + 1, zi + 1), hash(xi + 1, yi + 1, zi + 1), u), v),
    w,
  ) * 2 - 1;
}
function fbm(x: number, y: number, z: number, oct: number) {
  let a = 0.5, f = 1, s = 0;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x * f, y * f, z * f); a *= 0.5; f *= 2.03; }
  return s;
}

export function makeStubPlanet(N = 256): PlanetData {
  const T = N + 2;
  const height = new Float32Array(6 * T * T);
  const splat0 = new Uint8Array(6 * T * T * 4);
  const splat1 = new Uint8Array(6 * T * T * 4);
  const climate = new Uint8Array(6 * T * T * 4);
  let mn = 1e9, mx = -1e9;
  for (let f = 0; f < 6; f++)
    for (let y = 0; y < T; y++)
      for (let x = 0; x < T; x++) {
        const d = faceToDir(f, texelToS(x, N), texelToS(y, N));
        const c = fbm(d[0] * 2 + 5, d[1] * 2, d[2] * 2, 7);
        const h = c > 0 ? c * 14000 + Math.abs(fbm(d[0] * 8, d[1] * 8, d[2] * 8, 5)) * 3000 * c * 4 : c * 12000;
        const i = (f * T + y) * T + x;
        height[i] = h;
        mn = Math.min(mn, h); mx = Math.max(mx, h);
        const lat = Math.abs(d[1]);
        const temp = 1 - lat - Math.max(h, 0) / 12000;
        const w = new Float32Array(8);
        if (h < 30) w[0] = 1;
        else if (temp < 0.25) w[7] = 1;
        else if (h > 3000) w[5] = 1;
        else if (lat < 0.35 && fbm(d[0] * 3, d[1] * 3, d[2] * 3, 3) > 0) w[4] = 1;
        else if (lat < 0.5) w[1] = 0.6, w[2] = 0.4;
        else w[3] = 0.5, w[6] = 0.5;
        for (let k = 0; k < 4; k++) { splat0[i * 4 + k] = w[k] * 255; splat1[i * 4 + k] = w[k + 4] * 255; }
        climate[i * 4] = Math.max(0, Math.min(255, temp * 255));
        climate[i * 4 + 1] = 128;
        climate[i * 4 + 2] = 0;
      }
  return { N, T, radius: 800000, height, minHeight: mn, maxHeight: mx, splat0, splat1, climate };
}
