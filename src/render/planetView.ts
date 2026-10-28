import * as THREE from 'three';
import type { PlanetData } from '../core/types.ts';
import { createCubeSphereGeometry } from './geometry.ts';
import { createPlanetTextures, type PlanetTextures } from './planetTextures.ts';
import type { TerrainTextureSet } from './terrainTextures.ts';

import cubeGlsl from '../shaders/cube.glsl?raw';
import noiseGlsl from '../shaders/noise.glsl?raw';
import atmoCommonGlsl from '../shaders/atmosphere_common.glsl?raw';
import terrainCommon from '../shaders/terrain_common.glsl?raw';
import terrainVert from '../shaders/terrain.vert.glsl?raw';
import terrainFrag from '../shaders/terrain.frag.glsl?raw';
import oceanGlsl from '../shaders/ocean.glsl?raw';

export const COMMON = `${cubeGlsl}\n${noiseGlsl}\n${atmoCommonGlsl}\n`;

export function splitShader(src: string): [string, string] {
  // The marker must sit alone on its own line (comments may mention it).
  const [v, f] = src.split(/^\/\/#FRAGMENT[ \t]*\r?$/m);
  return [v, f];
}

const u = <T>(value: T) => ({ value });

/** Uniforms shared (by reference) between terrain, ocean and the atmosphere pass. */
export function createSharedUniforms() {
  return {
    uPlanetRadius: u(1200),
    uAtmoRadius: u(1260),
    uRayleigh: u(new THREE.Vector3(5.8e-3, 13.5e-3, 33.1e-3)),
    uRayleighH: u(8),
    uMie: u(4e-3),
    uMieH: u(1.6),
    uMieG: u(0.76),
    uAtmoDensity: u(1),
    uSunDir: u(new THREE.Vector3(1, 0.3, 0.4).normalize()),
    uSunColor: u(new THREE.Color(1, 0.97, 0.92).multiplyScalar(6)),
    uTime: u(0),
    uSkyAmbient: u(new THREE.Color(0.1, 0.16, 0.28)),
    uAmbient: u(0.003),
  };
}
export type SharedUniforms = ReturnType<typeof createSharedUniforms>;

// Debug colours per splat layer: dust, highland, basalt, sand, rock, gravel, ice, salt.
const LAYER_DEBUG = [0xc08a5a, 0xd8d0c0, 0x2a2a30, 0xe8b860, 0x8a6a5a, 0x6a6a70, 0xe8f4ff, 0xf0e070];
const MAX_UNITS = 32;

export interface LookParams {
  heightExaggeration: number;
  seaFloorScale: number;
  detailAmp: number; // metres of procedural detail relief
  detailScale: number; // km
  textureScale: number; // world-scale multiplier for texture tiles (stylised: >1 = bigger tiles)
  normalStrength: number;
  macroNormal: number;
  heightBlend: number;
  triSharp: number;
  macroVar: number;
  antiTile: number; // 0 = plain tiling, 1 = hex-tiling (no visible repetition)
  tintStrength: number; // 0 = raw textures, 1 = full per-world layer tints from the generator
  wetness: number;
  channels: number; // darkening of erosion channels / outflow beds
  debug: number;
  oceanMode: number; // 0 water, 1 lava, 2 ice, 3 none
  deepColor: string;
  shallowColor: string;
  clarity: number;
  waveScale: number;
  waveStrength: number;
  foam: number;
  lavaColor: string;
  lavaGlow: number;
  wireframe: boolean;
}

export const DEFAULT_LOOK: LookParams = {
  heightExaggeration: 1,
  seaFloorScale: 0.8,
  detailAmp: 350,
  detailScale: 6,
  textureScale: 250,
  normalStrength: 0.7,
  macroNormal: 1,
  heightBlend: 0.6,
  triSharp: 6,
  macroVar: 0.25,
  antiTile: 1,
  tintStrength: 1,
  wetness: 0.5,
  channels: 0.6,
  debug: 0,
  oceanMode: 0,
  deepColor: '#03142e',
  shallowColor: '#0f6c7a',
  clarity: 45,
  waveScale: 0.6,
  waveStrength: 0.35,
  foam: 1,
  lavaColor: '#ff4a10',
  lavaGlow: 14,
  wireframe: false,
};

export class PlanetView {
  readonly group = new THREE.Group();
  readonly terrain: THREE.Mesh;
  readonly ocean: THREE.Mesh;
  readonly terrainMat: THREE.ShaderMaterial;
  readonly oceanMat: THREE.ShaderMaterial;
  data: PlanetData | null = null;
  private tex: PlanetTextures | null = null;
  private meshSegments = 0;
  private geoCache = new Map<number, THREE.BufferGeometry>();
  private placeholder: THREE.DataArrayTexture;

  constructor(
    private renderer: THREE.WebGLRenderer,
    readonly shared: SharedUniforms,
    private layers: TerrainTextureSet,
  ) {
    const p = new Float32Array(9 * 6);
    this.placeholder = new THREE.DataArrayTexture(p, 3, 3, 6);
    this.placeholder.format = THREE.RedFormat;
    this.placeholder.type = THREE.FloatType;
    this.placeholder.needsUpdate = true;

    const planetU = {
      tHeight: u<THREE.Texture>(this.placeholder),
      tSplat0: u<THREE.Texture>(this.placeholder),
      tSplat1: u<THREE.Texture>(this.placeholder),
      tClimate: u<THREE.Texture>(this.placeholder),
      uN: u(1),
      uRadius: shared.uPlanetRadius,
      uHeightScale: u(0.001),
      uSeaFloorScale: u(DEFAULT_LOOK.seaFloorScale),
      uDetailAmp: u(DEFAULT_LOOK.detailAmp),
      uDetailScale: u(DEFAULT_LOOK.detailScale),
      uPixelAngle: u(0.001),
      uVertexSpacing: u(3),
    };

    this.terrainMat = new THREE.ShaderMaterial({
      uniforms: {
        ...shared,
        ...planetU,
        tAlbedo: u(layers.albedoHeight),
        tNormal: u(layers.normal),
        tOrm: u(layers.orm),
        uLayerScale: u(layers.layers.map(() => 1)),
        uLayerTint: u(layers.layers.map(() => new THREE.Vector3(1, 1, 1))),
        uNormalStrength: u(1),
        uMacroNormal: u(1),
        uHeightBlend: u(0.6),
        uTriSharp: u(6),
        uMacroVar: u(0.25),
        uAntiTile: u(1),
        uWetness: u(0.5),
        uChannels: u(0.6),
        uDebug: u(0),
        uLayerDebugColor: u(LAYER_DEBUG.map((c) => new THREE.Color(c))),
        uUnitColors: u(Array.from({ length: MAX_UNITS }, () => new THREE.Color(0.5, 0.5, 0.5))),
      },
      vertexShader: COMMON + terrainCommon + terrainVert,
      fragmentShader: COMMON + terrainCommon + terrainFrag,
    });

    const [ov, of] = splitShader(oceanGlsl);
    this.oceanMat = new THREE.ShaderMaterial({
      uniforms: {
        ...shared,
        ...planetU,
        tWaterNormal: u(layers.waterNormal),
        uMode: u(0),
        uDeepColor: u(new THREE.Color(DEFAULT_LOOK.deepColor)),
        uShallowColor: u(new THREE.Color(DEFAULT_LOOK.shallowColor)),
        uClarity: u(45),
        uWaveScale: u(0.6),
        uWaveStrength: u(0.35),
        uFoam: u(1),
        uLavaColor: u(new THREE.Color(DEFAULT_LOOK.lavaColor)),
        uLavaGlow: u(14),
      },
      vertexShader: COMMON + ov,
      fragmentShader: COMMON + of,
      transparent: true,
      depthWrite: true,
    });

    this.terrain = new THREE.Mesh(new THREE.BufferGeometry(), this.terrainMat);
    this.ocean = new THREE.Mesh(createCubeSphereGeometry(160), this.oceanMat);
    for (const m of [this.terrain, this.ocean]) m.frustumCulled = false;
    this.ocean.renderOrder = 1;
    this.group.add(this.terrain, this.ocean);
  }

  /** Per-frame filtering inputs: how much ground one pixel / one mesh quad covers. */
  updateFootprint(camera: THREE.PerspectiveCamera, viewportHeightPx: number) {
    const U = this.terrainMat.uniforms;
    U.uPixelAngle.value = THREE.MathUtils.degToRad(camera.fov) / Math.max(viewportHeightPx, 1);
    U.uVertexSpacing.value = (this.shared.uPlanetRadius.value * Math.PI * 0.5) / Math.max(this.meshSegments, 1);
  }

  setMeshSegments(segments: number) {
    if (segments === this.meshSegments) return;
    this.meshSegments = segments;
    let g = this.geoCache.get(segments);
    if (!g) {
      g = createCubeSphereGeometry(segments);
      this.geoCache.set(segments, g);
    }
    this.terrain.geometry = g;
  }

  /**
   * Pick the mesh density from how big the ground near the camera appears on screen: about
   * `pxPerQuad` pixels per quad. Pixel-sized triangles are very slow on GPUs (2x2 quad shading),
   * and the fragment shader already carries all detail finer than the mesh.
   */
  autoMeshSegments(camera: THREE.PerspectiveCamera, viewportHeightPx: number, altitudeKm: number, pxPerQuad = 5, maxSegments = 384) {
    const R = this.shared.uPlanetRadius.value;
    const pxPerKm = viewportHeightPx / (2 * Math.max(altitudeKm, 1) * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    const want = (R * Math.PI * 0.5 * pxPerKm) / pxPerQuad;
    const buckets = [96, 128, 192, 256, 384, 512, 768].filter((b) => b <= maxSegments);
    let pick = buckets[buckets.length - 1];
    for (const b of buckets) {
      if (b >= want) {
        pick = b;
        break;
      }
    }
    // Hysteresis: only step down once the coarser level is clearly enough.
    if (pick < this.meshSegments && want > this.meshSegments * 0.8) return;
    this.setMeshSegments(pick);
  }

  get segments() {
    return this.meshSegments;
  }

  setPlanet(data: PlanetData) {
    const old = this.tex;
    this.tex = createPlanetTextures(data, this.renderer);
    this.data = data;
    const U = this.terrainMat.uniforms;
    U.tHeight.value = this.tex.height;
    U.tSplat0.value = this.tex.splat0;
    U.tSplat1.value = this.tex.splat1;
    U.tClimate.value = this.tex.climate;
    U.uN.value = data.N;
    this.shared.uPlanetRadius.value = data.radius / 1000;
    const colors = U.uUnitColors.value as THREE.Color[];
    for (const unit of data.info?.units ?? []) {
      if (unit.id >= 0 && unit.id < MAX_UNITS) colors[unit.id].setRGB(unit.color[0], unit.color[1], unit.color[2], THREE.SRGBColorSpace);
    }
    old?.dispose();
  }

  applyLook(look: LookParams) {
    const U = this.terrainMat.uniforms;
    U.uHeightScale.value = 0.001 * look.heightExaggeration;
    U.uSeaFloorScale.value = look.seaFloorScale;
    U.uDetailAmp.value = look.detailAmp;
    U.uDetailScale.value = look.detailScale;
    // Tiles per km: the texture's real tile size scaled up by textureScale (stylised macro tiling).
    U.uLayerScale.value = this.layers.layers.map((l) => 1000 / (l.tileMeters * look.textureScale));
    U.uNormalStrength.value = look.normalStrength;
    U.uMacroNormal.value = look.macroNormal;
    U.uHeightBlend.value = look.heightBlend;
    U.uTriSharp.value = look.triSharp;
    U.uMacroVar.value = look.macroVar;
    U.uAntiTile.value = look.antiTile;
    U.uWetness.value = look.wetness;
    U.uChannels.value = look.channels;
    const tints = this.data?.info?.look.layerTints;
    (U.uLayerTint.value as THREE.Vector3[]).forEach((v, i) => {
      const t = tints?.[i] ?? [1, 1, 1];
      const k = look.tintStrength;
      v.set(1 + (t[0] - 1) * k, 1 + (t[1] - 1) * k, 1 + (t[2] - 1) * k);
    });
    U.uDebug.value = look.debug;
    this.terrainMat.wireframe = look.wireframe;

    const O = this.oceanMat.uniforms;
    O.uMode.value = look.oceanMode;
    (O.uDeepColor.value as THREE.Color).set(look.deepColor);
    (O.uShallowColor.value as THREE.Color).set(look.shallowColor);
    O.uClarity.value = look.clarity;
    O.uWaveScale.value = look.waveScale;
    O.uWaveStrength.value = look.waveStrength;
    O.uFoam.value = look.foam;
    (O.uLavaColor.value as THREE.Color).set(look.lavaColor);
    O.uLavaGlow.value = look.lavaGlow;
    this.ocean.visible = look.oceanMode !== 3 && look.debug === 0;
  }

  /** Terrain surface radius (km, displaced) under a world direction, used for camera collision. */
  surfaceRadiusKm(dir: THREE.Vector3, sampler: (x: number, y: number, z: number) => number): number {
    const R = this.shared.uPlanetRadius.value;
    const hM = sampler(dir.x, dir.y, dir.z);
    const U = this.terrainMat.uniforms;
    const ex = (hM < 0 ? hM * U.uSeaFloorScale.value : hM) * U.uHeightScale.value;
    // Margin for the procedural detail relief that the CPU heightmap does not contain.
    const detail = U.uDetailAmp.value * 1.6 * U.uHeightScale.value;
    const sea = this.ocean.visible ? R : -Infinity;
    return Math.max(sea, R + ex + detail);
  }
}
