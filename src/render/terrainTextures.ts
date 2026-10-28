import * as THREE from 'three';

export interface TextureLayerInfo {
  index: number;
  name: string;
  source: string;
  tileMeters: number;
  meanAlbedo: [number, number, number];
  meanRoughness: number;
}

export interface TerrainTextureSet {
  resolution: number;
  layers: TextureLayerInfo[];
  /** sRGB albedo, alpha = height (linear) for height-based blending. */
  albedoHeight: THREE.DataArrayTexture;
  /** OpenGL tangent-space normal in RGB. */
  normal: THREE.DataArrayTexture;
  /** R = AO, G = roughness, B = metalness. */
  orm: THREE.DataArrayTexture;
  waterNormal: THREE.Texture;
  waterTileMeters: number;
}

interface Manifest {
  resolution: number;
  layers: (TextureLayerInfo & { albedo: string; normal: string; orm: string; height: string })[];
  water: { normal: string; tileMeters?: number };
}

async function loadPixels(url: string, size: number): Promise<Uint8ClampedArray> {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob, {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
    resizeWidth: size,
    resizeHeight: size,
    resizeQuality: 'high',
  });
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, size, size).data;
}

function makeArray(data: Uint8Array, size: number, layers: number, srgb: boolean, aniso: number) {
  const tex = new THREE.DataArrayTexture(data, size, size, layers);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = aniso;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Loads public/textures/manifest.json and packs all layers into three 2D array textures.
 * `size` lets low-memory devices downscale (default: manifest resolution).
 */
export async function loadTerrainTextures(
  renderer: THREE.WebGLRenderer,
  base = '/textures/',
  size?: number,
  onProgress?: (frac: number) => void,
): Promise<TerrainTextureSet> {
  const manifest: Manifest = await (await fetch(base + 'manifest.json')).json();
  const res = size ?? manifest.resolution;
  const L = manifest.layers.length;
  const layerBytes = res * res * 4;
  const albedoHeight = new Uint8Array(layerBytes * L);
  const normal = new Uint8Array(layerBytes * L);
  const orm = new Uint8Array(layerBytes * L);
  let done = 0;
  const total = L * 4 + 1;
  const tick = () => onProgress?.(++done / total);

  await Promise.all(
    manifest.layers.map(async (layer) => {
      const i = layer.index;
      const [a, n, o, h] = await Promise.all(
        [layer.albedo, layer.normal, layer.orm, layer.height].map((f) =>
          loadPixels(base + f, res).then((p) => (tick(), p)),
        ),
      );
      const off = i * layerBytes;
      for (let p = 0; p < layerBytes; p += 4) {
        albedoHeight[off + p] = a[p];
        albedoHeight[off + p + 1] = a[p + 1];
        albedoHeight[off + p + 2] = a[p + 2];
        albedoHeight[off + p + 3] = h[p];
        normal[off + p] = n[p];
        normal[off + p + 1] = n[p + 1];
        normal[off + p + 2] = n[p + 2];
        normal[off + p + 3] = 255;
        orm[off + p] = o[p];
        orm[off + p + 1] = o[p + 1];
        orm[off + p + 2] = o[p + 2];
        orm[off + p + 3] = 255;
      }
    }),
  );

  const waterTex = await new THREE.TextureLoader().loadAsync(base + manifest.water.normal);
  tick();
  waterTex.wrapS = waterTex.wrapT = THREE.RepeatWrapping;
  waterTex.colorSpace = THREE.NoColorSpace;
  waterTex.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const aniso = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  return {
    resolution: res,
    layers: manifest.layers.map(({ index, name, source, tileMeters, meanAlbedo, meanRoughness }) => ({
      index, name, source, tileMeters, meanAlbedo, meanRoughness,
    })),
    albedoHeight: makeArray(albedoHeight, res, L, true, aniso),
    normal: makeArray(normal, res, L, false, aniso),
    orm: makeArray(orm, res, L, false, aniso),
    waterNormal: waterTex,
    waterTileMeters: manifest.water.tileMeters ?? 12,
  };
}
