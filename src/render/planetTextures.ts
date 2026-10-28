import * as THREE from 'three';
import type { PlanetData } from '../core/types.ts';
import { faceToDir, texelToS } from '../core/cube.ts';

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
export function computeTerrainAO(height: Float32Array, N: number, radiusM: number): Uint8Array {
  const T = N + 2;
  const out = new Uint8Array(T * T * 6);
  const texelM = (radiusM * Math.PI * 0.5) / N;
  const sat = new Float64Array((T + 1) * (T + 1));
  const radii = [Math.max(2, Math.round(N / 160)), Math.max(6, Math.round(N / 40))];
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
export function computeHeightGradient(height: Float32Array, N: number, radiusM: number): Uint16Array {
  const T = N + 2;
  const Rk = radiusM / 1000;
  const out = new Uint16Array(T * T * 6 * 4);
  const dirs = new Float32Array(T * T * 3);
  const d: [number, number, number] = [0, 0, 0];
  const half = THREE.DataUtils.toHalfFloat;
  for (let f = 0; f < 6; f++) {
    for (let y = 0; y < T; y++)
      for (let x = 0; x < T; x++) {
        faceToDir(f, texelToS(x, N), texelToS(y, N), d);
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

export function createPlanetTextures(planet: PlanetData, renderer: THREE.WebGLRenderer): PlanetTextures {
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const T = planet.T;
  // R32F: no mipmaps (not renderable everywhere); linear filtering needs OES_texture_float_linear.
  const height = arrayTex(planet.height, T, THREE.RedFormat, THREE.FloatType, false, 1);
  const splat0 = arrayTex(planet.splat0, T, THREE.RGBAFormat, THREE.UnsignedByteType, true, aniso);
  const splat1 = arrayTex(planet.splat1, T, THREE.RGBAFormat, THREE.UnsignedByteType, true, aniso);
  const climate = arrayTex(planet.climate, T, THREE.RGBAFormat, THREE.UnsignedByteType, true, aniso);
  const ao = arrayTex(computeTerrainAO(planet.height, planet.N, planet.radius), T, THREE.RedFormat, THREE.UnsignedByteType, true, aniso);
  const grad = arrayTex(computeHeightGradient(planet.height, planet.N, planet.radius), T, THREE.RGBAFormat, THREE.HalfFloatType, true, aniso);
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
