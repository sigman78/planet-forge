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
import cloudsGlsl from '../shaders/clouds.glsl?raw';

export const COMMON = `${cubeGlsl}\n${noiseGlsl}\n${atmoCommonGlsl}\n`;

export function splitShader(src: string): [string, string] {
  // The marker must sit alone on its own line (comments may mention it).
  const [v, f] = src.split(/^\/\/#FRAGMENT[ \t]*\r?$/m);
  return [v, f];
}

const u = <T>(value: T) => ({ value });

/** Uniforms shared (by reference) between terrain, ocean, clouds and the atmosphere pass. */
export function createSharedUniforms() {
  return {
    uPlanetRadius: u(800),
    uAtmoRadius: u(860),
    uRayleigh: u(new THREE.Vector3(5.8e-3, 13.5e-3, 33.1e-3)),
    uRayleighH: u(8),
    uMie: u(4e-3),
    uMieH: u(1.6),
    uMieG: u(0.76),
    uAtmoDensity: u(1),
    uSunDir: u(new THREE.Vector3(1, 0.3, 0.4).normalize()),
    uSunColor: u(new THREE.Color(1, 0.97, 0.92).multiplyScalar(6)),
    uTime: u(0),
    uCloudRot: u(new THREE.Matrix3()),
    uCloudAlt: u(9),
    uCloudCover: u(0.5),
    uCloudShadow: u(0.6),
    uSkyAmbient: u(new THREE.Color(0.1, 0.16, 0.28)),
    uAmbient: u(0.003),
  };
}
export type SharedUniforms = ReturnType<typeof createSharedUniforms>;

// Debug colours per splat layer.
const LAYER_DEBUG = [0xe8d38c, 0x5fb33a, 0x1f5c25, 0xb59a4a, 0xe07b2f, 0x7a6d64, 0x3b3b40, 0xffffff];
const BIOME_PALETTE = [
  0x1b3d8f, 0x3d7fd1, 0xe8d38c, 0xffffff, 0xa0a8a0, 0x6d8f6a, 0x2d6b3a, 0x5fb33a, 0xb5c25a, 0xd9c27a, 0xe07b2f,
  0x1f5c25, 0x0d4020, 0x8a7a5a, 0x7a6d64, 0x3b3b40, 0xc04020, 0x9050c0, 0x50c0c0, 0xc0c050, 0x808080, 0x404080,
  0x804040, 0x408040,
];

export interface LookParams {
  heightExaggeration: number;
  seaFloorScale: number;
  detailAmp: number;          // metres of procedural detail relief
  detailScale: number;        // km
  textureScale: number;        // world-scale multiplier for texture tiles (stylised: >1 = bigger tiles)
  normalStrength: number;
  macroNormal: number;
  heightBlend: number;
  triSharp: number;
  macroVar: number;
  climateTint: number;
  wetness: number;
  rivers: number;
  cityLights: number;
  vegTint: string;
  debug: number;
  oceanMode: number;           // 0 water, 1 lava, 2 ice, 3 none
  deepColor: string;
  shallowColor: string;
  clarity: number;
  waveScale: number;
  waveStrength: number;
  foam: number;
  lavaColor: string;
  lavaGlow: number;
  cloudsVisible: boolean;
  cloudOpacity: number;
  cloudTint: string;
  wireframe: boolean;
}

export const DEFAULT_LOOK: LookParams = {
  heightExaggeration: 1,
  seaFloorScale: 0.6,
  detailAmp: 350,
  detailScale: 6,
  textureScale: 250,
  normalStrength: 1,
  macroNormal: 1,
  heightBlend: 0.6,
  triSharp: 6,
  macroVar: 0.25,
  climateTint: 0.6,
  wetness: 0.6,
  rivers: 1,
  cityLights: 0,
  vegTint: '#ffffff',
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
  cloudsVisible: true,
  cloudOpacity: 0.95,
  cloudTint: '#ffffff',
  wireframe: false,
};

export class PlanetView {
  readonly group = new THREE.Group();
  readonly terrain: THREE.Mesh;
  readonly ocean: THREE.Mesh;
  readonly clouds: THREE.Mesh;
  readonly terrainMat: THREE.ShaderMaterial;
  readonly oceanMat: THREE.ShaderMaterial;
  readonly cloudMat: THREE.ShaderMaterial;
  data: PlanetData | null = null;
  private tex: PlanetTextures | null = null;
  private meshSegments = 0;
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
      tClouds: u<THREE.Texture>(this.placeholder),
      uN: u(1),
      uCloudN: u(1),
      uRadius: shared.uPlanetRadius,
      uHeightScale: u(0.001),
      uSeaFloorScale: u(DEFAULT_LOOK.seaFloorScale),
      uDetailAmp: u(DEFAULT_LOOK.detailAmp),
      uDetailScale: u(DEFAULT_LOOK.detailScale),
    };

    const tilesPerKm = layers.layers.map(() => 1);
    this.terrainMat = new THREE.ShaderMaterial({
      uniforms: {
        ...shared,
        ...planetU,
        tAlbedo: u(layers.albedoHeight),
        tNormal: u(layers.normal),
        tOrm: u(layers.orm),
        uLayerScale: u(tilesPerKm),
        uLayerTint: u(layers.layers.map(() => new THREE.Vector3(1, 1, 1))),
        uNormalStrength: u(1),
        uMacroNormal: u(1),
        uHeightBlend: u(0.6),
        uTriSharp: u(6),
        uMacroVar: u(0.25),
        uClimateTint: u(0.6),
        uWetness: u(0.6),
        uRiverAmount: u(1),
        uRiverColor: u(new THREE.Color(0.02, 0.05, 0.08)),
        uCityLights: u(0),
        uDebug: u(0),
        uLayerDebugColor: u(LAYER_DEBUG.map((c) => new THREE.Color(c))),
        uBiomeColors: u(BIOME_PALETTE.map((c) => new THREE.Color(c))),
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

    const [cv, cf] = splitShader(cloudsGlsl);
    this.cloudMat = new THREE.ShaderMaterial({
      uniforms: {
        ...shared,
        tClouds: planetU.tClouds,
        uCloudN: planetU.uCloudN,
        uRadius: shared.uPlanetRadius,
        uCloudOpacity: u(0.95),
        uCloudTint: u(new THREE.Color(1, 1, 1)),
      },
      vertexShader: COMMON + cv,
      fragmentShader: COMMON + cf,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.terrain = new THREE.Mesh(new THREE.BufferGeometry(), this.terrainMat);
    this.ocean = new THREE.Mesh(createCubeSphereGeometry(160), this.oceanMat);
    this.clouds = new THREE.Mesh(createCubeSphereGeometry(96), this.cloudMat);
    for (const m of [this.terrain, this.ocean, this.clouds]) m.frustumCulled = false;
    this.ocean.renderOrder = 1;
    this.clouds.renderOrder = 2;
    this.group.add(this.terrain, this.ocean, this.clouds);
  }

  setMeshSegments(segments: number) {
    if (segments === this.meshSegments) return;
    this.meshSegments = segments;
    this.terrain.geometry.dispose();
    this.terrain.geometry = createCubeSphereGeometry(segments);
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
    U.tClouds.value = this.tex.clouds;
    U.uN.value = data.N;
    U.uCloudN.value = data.cloudN;
    this.shared.uPlanetRadius.value = data.radius / 1000;
    old?.dispose();
  }

  applyLook(look: LookParams) {
    const U = this.terrainMat.uniforms;
    const R = this.shared.uPlanetRadius.value;
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
    U.uClimateTint.value = look.climateTint;
    U.uWetness.value = look.wetness;
    U.uRiverAmount.value = look.rivers;
    U.uCityLights.value = look.cityLights;
    const veg = new THREE.Color(look.vegTint);
    (U.uLayerTint.value as THREE.Vector3[]).forEach((v, i) => {
      if (i >= 1 && i <= 3) v.set(veg.r, veg.g, veg.b);
      else v.set(1, 1, 1);
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

    const C = this.cloudMat.uniforms;
    C.uCloudOpacity.value = look.cloudOpacity;
    (C.uCloudTint.value as THREE.Color).set(look.cloudTint);
    this.clouds.visible = look.cloudsVisible && look.debug === 0;
    void R;
  }

  /** Terrain surface radius (km, displaced) under a world direction — used for camera collision. */
  surfaceRadiusKm(dir: THREE.Vector3, sampler: (x: number, y: number, z: number) => number): number {
    const R = this.shared.uPlanetRadius.value;
    const hM = sampler(dir.x, dir.y, dir.z);
    const U = this.terrainMat.uniforms;
    const ex = (hM < 0 ? hM * U.uSeaFloorScale.value : hM) * U.uHeightScale.value;
    // Margin for the procedural detail relief that the CPU heightmap does not contain.
    const detail = U.uDetailAmp.value * 1.6 * U.uHeightScale.value;
    return Math.max(R, R + ex + detail);
  }
}
