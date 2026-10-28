import * as THREE from 'three';
import type { PlanetData } from '../core/types.ts';

/** GPU-side copies of a PlanetData: 6-layer array textures (one layer per cube face). */
export interface PlanetTextures {
  N: number;
  height: THREE.DataArrayTexture;
  splat0: THREE.DataArrayTexture;
  splat1: THREE.DataArrayTexture;
  climate: THREE.DataArrayTexture;
  ao: THREE.DataArrayTexture;
  dispose(): void;
}

function arrayTex(
  data: Float32Array | Uint8Array,
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

export function createPlanetTextures(planet: PlanetData, renderer: THREE.WebGLRenderer): PlanetTextures {
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const T = planet.T;
  // R32F: no mipmaps (not renderable everywhere); linear filtering needs OES_texture_float_linear.
  const height = arrayTex(planet.height, T, THREE.RedFormat, THREE.FloatType, false, 1);
  const splat0 = arrayTex(planet.splat0, T, THREE.RGBAFormat, THREE.UnsignedByteType, true, aniso);
  const splat1 = arrayTex(planet.splat1, T, THREE.RGBAFormat, THREE.UnsignedByteType, true, aniso);
  const climate = arrayTex(planet.climate, T, THREE.RGBAFormat, THREE.UnsignedByteType, true, aniso);
  const ao = arrayTex(computeTerrainAO(planet.height, planet.N, planet.radius), T, THREE.RedFormat, THREE.UnsignedByteType, true, aniso);
  return {
    N: planet.N,
    height,
    splat0,
    splat1,
    climate,
    ao,
    dispose() {
      ao.dispose();
      height.dispose();
      splat0.dispose();
      splat1.dispose();
      climate.dispose();
    },
  };
}
