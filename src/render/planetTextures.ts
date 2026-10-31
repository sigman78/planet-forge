import * as THREE from 'three';
import type { PlanetData } from '../core/types.ts';
import { faceToDir, padFaces, texelToS } from '../core/cube.ts';

/**
 * Gutter (texels per side) of the GPU copies. PlanetData carries 1; the GPU copies are repacked with 8 so
 * that the mip chain stays seamless across cube faces (see `padFaces`). The shader's `cubeTexCoord` and
 * this constant must agree.
 */
export const GPU_GUTTER = 8;

/** GPU-side copies of a PlanetData: 6-layer array textures (one layer per cube face). */
export interface PlanetTextures {
  N: number;
  height: THREE.DataArrayTexture;
  splat0: THREE.DataArrayTexture;
  splat1: THREE.DataArrayTexture;
  climate: THREE.DataArrayTexture;
  ao: THREE.DataArrayTexture;
  /** World-space surface gradient of the height (m per km of arc at the mean radius), RGBA16F, mipmapped. */
  grad: THREE.DataArrayTexture;
  dispose(): void;
}

function arrayTex(
  data: Float32Array | Uint8Array | Uint16Array,
  size: number,
  format: THREE.AnyPixelFormat,
  type: THREE.TextureDataType,
  mips: boolean,
  anisotropy: number,
): THREE.DataArrayTexture {
  const tex = new THREE.DataArrayTexture(data, size, size, 6);
  tex.format = format;
  tex.type = type;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.generateMipmaps = mips;
  tex.anisotropy = anisotropy;
  tex.colorSpace = THREE.NoColorSpace;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Terrain ambient occlusion from the heightmap: how far each texel sits below its surroundings at two
 * scales (box blurs via summed-area tables), turned into an occlusion angle. Cheap (a few ms) and
 * makes crater floors, rilles and valleys read at every zoom level.
 */
export function aoBlurRadii(N: number): [number, number] {
  return [Math.max(2, Math.round(N / 160)), Math.max(6, Math.round(N / 40))];
}

/**
 * `height` is a face array with a `G`-texel gutter (6 faces of (N + 2G)^2). The box windows reach `radii[1]`
 * texels, so with G >= that radius every texel's window holds real neighbour data and the AO is seamless
 * across faces; a 1-texel gutter truncated the windows at the face border and left a band of wrong AO
 * along every edge. Output has the same layout as the input.
 */
export function computeTerrainAO(height: Float32Array, N: number, radiusM: number, G = 1): Uint8Array {
  const T = N + 2 * G;
  const out = new Uint8Array(T * T * 6);
  const texelM = (radiusM * Math.PI * 0.5) / N;
  const sat = new Float64Array((T + 1) * (T + 1));
  const radii = aoBlurRadii(N);
  const occ = new Float32Array(T * T);
  for (let f = 0; f < 6; f++) {
    const base = f * T * T;
    for (let y = 0; y < T; y++) {
      let row = 0;
      for (let x = 0; x < T; x++) {
        row += height[base + y * T + x];
        sat[(y + 1) * (T + 1) + x + 1] = sat[y * (T + 1) + x + 1] + row;
      }
    }
    occ.fill(1);
    for (const r of radii) {
      const scale = 1 / (r * texelM);
      for (let y = 0; y < T; y++) {
        const y0 = Math.max(0, y - r), y1 = Math.min(T, y + r + 1);
        for (let x = 0; x < T; x++) {
          const x0 = Math.max(0, x - r), x1 = Math.min(T, x + r + 1);
          const sum = sat[y1 * (T + 1) + x1] - sat[y0 * (T + 1) + x1] - sat[y1 * (T + 1) + x0] + sat[y0 * (T + 1) + x0];
          const mean = sum / ((x1 - x0) * (y1 - y0));
          const depth = (mean - height[base + y * T + x]) * scale; // ~ tan of the surrounding rise
          occ[y * T + x] *= 1 - Math.min(Math.max(depth * 2.2, 0), 0.7);
        }
      }
    }
    for (let i = 0; i < T * T; i++) out[base + i] = Math.round(occ[i] * 255);
  }
  return out;
}

/**
 * Bakes the tangential gradient of the height field (metres of height per km along the surface) for every
 * texel, as a world-space vector (RGB; A unused). The shader turns it into the relief normal with the current
 * exaggeration: N = normalize(n - G * scale).
 * Unlike finite differences of bilinear heights in the shader, bilinear filtering of per-texel gradients is
 * continuous (no per-texel facets), and the mip chain averages the slopes instead of aliasing from orbit.
 */
export function computeHeightGradient(height: Float32Array, N: number, radiusM: number, G = 1): Uint16Array {
  const T = N + 2 * G;
  const Rk = radiusM / 1000;
  const out = new Uint16Array(T * T * 6 * 4);
  const dirs = new Float32Array(T * T * 3);
  const d: [number, number, number] = [0, 0, 0];
  const half = THREE.DataUtils.toHalfFloat;
  for (let f = 0; f < 6; f++) {
    for (let y = 0; y < T; y++)
      for (let x = 0; x < T; x++) {
        faceToDir(f, texelToS(x - G + 1, N), texelToS(y - G + 1, N), d);
        const i = (y * T + x) * 3;
        dirs[i] = d[0]; dirs[i + 1] = d[1]; dirs[i + 2] = d[2];
      }
    const base = f * T * T;
    for (let y = 0; y < T; y++) {
      const yl = y > 0 ? y - 1 : y, yr = y < T - 1 ? y + 1 : y;
      for (let x = 0; x < T; x++) {
        const xl = x > 0 ? x - 1 : x, xr = x < T - 1 ? x + 1 : x;
        const il = y * T + xl, ir = y * T + xr, id = yl * T + x, iu = yr * T + x;
        // Tangent steps (km) and height differences (m) along the two grid axes; solve for the gradient G
        // in their plane: G.a = da, G.b = db.
        const ax = (dirs[ir * 3] - dirs[il * 3]) * Rk, ay = (dirs[ir * 3 + 1] - dirs[il * 3 + 1]) * Rk, az = (dirs[ir * 3 + 2] - dirs[il * 3 + 2]) * Rk;
        const bx = (dirs[iu * 3] - dirs[id * 3]) * Rk, by = (dirs[iu * 3 + 1] - dirs[id * 3 + 1]) * Rk, bz = (dirs[iu * 3 + 2] - dirs[id * 3 + 2]) * Rk;
        const da = height[base + ir] - height[base + il], db = height[base + iu] - height[base + id];
        const aa = ax * ax + ay * ay + az * az, bb = bx * bx + by * by + bz * bz, ab = ax * bx + ay * by + az * bz;
        const det = aa * bb - ab * ab;
        let gx = 0, gy = 0, gz = 0;
        if (det > 1e-12) {
          const al = (da * bb - db * ab) / det;
          const be = (db * aa - da * ab) / det;
          gx = al * ax + be * bx; gy = al * ay + be * by; gz = al * az + be * bz;
        }
        const o = (base + y * T + x) * 4;
        out[o] = half(gx); out[o + 1] = half(gy); out[o + 2] = half(gz); out[o + 3] = 0;
      }
    }
  }
  return out;
}

/** Narrow a face array's gutter from `from` to `to` texels per side. */
function cropGutter<A extends Uint8Array | Uint16Array | Float32Array>(data: A, N: number, channels: number, from: number, to: number): A {
  if (from === to) return data;
  const Tf = N + 2 * from, Tt = N + 2 * to, d = from - to;
  const out = new (data.constructor as new (n: number) => A)(6 * Tt * Tt * channels);
  for (let f = 0; f < 6; f++)
    for (let y = 0; y < Tt; y++) {
      const src = ((f * Tf + y + d) * Tf + d) * channels;
      out.set(data.subarray(src, src + Tt * channels) as unknown as ArrayLike<number>, ((f * Tt + y) * Tt) * channels);
    }
  return out;
}

export function createPlanetTextures(planet: PlanetData, renderer: THREE.WebGLRenderer): PlanetTextures {
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const N = planet.N, G = GPU_GUTTER, T = N + 2 * G;
  const heightG = padFaces(planet.height, N, 1, G);
  // R32F: no mipmaps (not renderable everywhere); linear filtering needs OES_texture_float_linear.
  const height = arrayTex(heightG, T, THREE.RedFormat, THREE.FloatType, false, 1);
  const splat0 = arrayTex(padFaces(planet.splat0, N, 4, G), T, THREE.RGBAFormat, THREE.UnsignedByteType, true, aniso);
  const splat1 = arrayTex(padFaces(planet.splat1, N, 4, G), T, THREE.RGBAFormat, THREE.UnsignedByteType, true, aniso);
  const climate = arrayTex(padFaces(planet.climate, N, 4, G), T, THREE.RGBAFormat, THREE.UnsignedByteType, true, aniso);
  // AO on a pad as wide as its largest blur window, then cropped to the GPU gutter.
  const Pao = Math.max(G, aoBlurRadii(N)[1] + 1);
  const aoWide = computeTerrainAO(Pao === G ? heightG : padFaces(planet.height, N, 1, Pao), N, planet.radius, Pao);
  const ao = arrayTex(cropGutter(aoWide, N, 1, Pao, G), T, THREE.RedFormat, THREE.UnsignedByteType, true, aniso);
  const grad = arrayTex(computeHeightGradient(heightG, N, planet.radius, G), T, THREE.RGBAFormat, THREE.HalfFloatType, true, aniso);
  return {
    N: planet.N,
    height,
    splat0,
    splat1,
    climate,
    ao,
    grad,
    dispose() {
      ao.dispose();
      grad.dispose();
      height.dispose();
      splat0.dispose();
      splat1.dispose();
      climate.dispose();
    },
  };
}
