import * as THREE from 'three';
import type { PlanetData } from '../core/types.ts';

/** GPU-side copies of a PlanetData: 6-layer array textures (one layer per cube face). */
export interface PlanetTextures {
  N: number;
  height: THREE.DataArrayTexture;
  splat0: THREE.DataArrayTexture;
  splat1: THREE.DataArrayTexture;
  climate: THREE.DataArrayTexture;
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

export function createPlanetTextures(planet: PlanetData, renderer: THREE.WebGLRenderer): PlanetTextures {
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const T = planet.T;
  // R32F: no mipmaps (not renderable everywhere); linear filtering needs OES_texture_float_linear.
  const height = arrayTex(planet.height, T, THREE.RedFormat, THREE.FloatType, false, 1);
  const splat0 = arrayTex(planet.splat0, T, THREE.RGBAFormat, THREE.UnsignedByteType, true, aniso);
  const splat1 = arrayTex(planet.splat1, T, THREE.RGBAFormat, THREE.UnsignedByteType, true, aniso);
  const climate = arrayTex(planet.climate, T, THREE.RGBAFormat, THREE.UnsignedByteType, true, aniso);
  return {
    N: planet.N,
    height,
    splat0,
    splat1,
    climate,
    dispose() {
      height.dispose();
      splat0.dispose();
      splat1.dispose();
      climate.dispose();
    },
  };
}
