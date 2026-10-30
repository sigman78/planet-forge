import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { dirToFace } from '../core/cube.ts';
import { COMMON, splitShader, type PlanetView } from './planetView.ts';
import terrainCommon from '../shaders/terrain_common.glsl?raw';
import terrainLight from '../shaders/terrain_light.glsl?raw';
import placeFrag from '../shaders/rocks_place.frag.glsl?raw';
import rocksGlsl from '../shaders/rocks.glsl?raw';
import shadowGlsl from '../shaders/rock_shadow.glsl?raw';

const GRID = 96;

/**
 * One level of surface rocks: a GRID x GRID window of world cells that follows the camera.
 * Sizes are in km. Blocks below ~4 px never show, so each level only runs low enough for its sizes.
 */
interface RockLevel {
  cellKm: number;
  rMin: number;
  rMax: number;
  /** Ground altitude (km) above which the level is skipped. */
  maxAlt: number;
  density: number;
  clusterKm: number;
}

// A block of radius r stays above ~2 px out to about r * 1000 (45 deg fov at ~850 px), so each level's window
// (GRID cells across) is sized to that reach: cell ~ 20 r.
const LEVELS: RockLevel[] = [
  { cellKm: 0.03, rMin: 0.002, rMax: 0.008, maxAlt: 3, density: 0.9, clusterKm: 0.8 },
  { cellKm: 0.12, rMin: 0.006, rMax: 0.025, maxAlt: 9, density: 0.7, clusterKm: 3 },
  { cellKm: 0.45, rMin: 0.02, rMax: 0.08, maxAlt: 30, density: 0.45, clusterKm: 10 },
];

// Blocks per layer: dust, highland, basalt, sand, rock, gravel, ice, salt.
const ROCK_DENSITY = [0.08, 0.3, 0.45, 0, 1, 0.7, 0.25, 0.05];

/** Real-scale tiling of the layer textures on the rocks (tiles per metre). */
const ROCK_TILE = 0.35;

function instanced(base: THREE.BufferGeometry): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  g.setAttribute('position', base.getAttribute('position'));
  g.instanceCount = GRID * GRID;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  return g;
}

function rockGeometry(): THREE.InstancedBufferGeometry {
  const ico = new THREE.IcosahedronGeometry(1, 1);
  ico.deleteAttribute('normal');
  ico.deleteAttribute('uv');
  return instanced(mergeVertices(ico));
}

class Level {
  readonly rt: THREE.WebGLRenderTarget;
  readonly place: THREE.ShaderMaterial;
  readonly quad: FullScreenQuad;
  readonly mesh: THREE.Mesh;
  readonly shadow: THREE.Mesh;
  private cellS = 0;

  constructor(readonly cfg: RockLevel, readonly index: number, view: PlanetView, geo: THREE.InstancedBufferGeometry, quad: THREE.InstancedBufferGeometry) {
    this.rt = new THREE.WebGLRenderTarget(GRID * 3, GRID, {
      type: THREE.FloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      generateMipmaps: false,
    });
    const T = view.terrainMat.uniforms;
    this.place = new THREE.ShaderMaterial({
      uniforms: {
        ...T,
        uAnchor: { value: new THREE.Vector3() },
        uCellS: { value: 1 },
        uRMin: { value: cfg.rMin },
        uRMax: { value: cfg.rMax },
        uDensity: { value: cfg.density },
        uLevel: { value: index },
        uSegments: { value: 384 },
        uOcean: { value: 0 },
        uClusterKm: { value: cfg.clusterKm },
        uCamPos: { value: new THREE.Vector3() },
        uRockDensity: { value: ROCK_DENSITY },
      },
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: COMMON + terrainCommon + terrainLight + placeFrag,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.place);
    const [vs, fs] = splitShader(rocksGlsl);
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...T, tRock: { value: this.rt.texture }, uRockTile: { value: ROCK_TILE } },
      vertexShader: COMMON + terrainCommon + vs,
      fragmentShader: COMMON + terrainCommon + terrainLight + fs,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 0.6;
    // Shadow decals multiply the lit ground (dst *= src) after the terrain and before the rocks.
    const [svs, sfs] = splitShader(shadowGlsl);
    const smat = new THREE.ShaderMaterial({
      uniforms: { ...T, tRock: { value: this.rt.texture } },
      vertexShader: COMMON + terrainCommon + svs,
      fragmentShader: sfs,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcColorFactor,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.shadow = new THREE.Mesh(quad, smat);
    this.shadow.frustumCulled = false;
    this.shadow.renderOrder = 0.5;
  }

  /** Window centre on the ground ahead of the camera, snapped to world cells. */
  update(renderer: THREE.WebGLRenderer, view: PlanetView, camera: THREE.PerspectiveCamera, groundAlt: number, density: number) {
    const on = density > 0 && groundAlt < this.cfg.maxAlt && view.data !== null;
    this.mesh.visible = this.shadow.visible = on;
    if (!on) return;
    const R = view.shared.uPlanetRadius.value;
    this.cellS = 2 / Math.round((R * Math.PI * 0.5) / this.cfg.cellKm);
    const up = camera.position.clone().normalize();
    const fwd = camera.getWorldDirection(new THREE.Vector3());
    fwd.addScaledVector(up, -fwd.dot(up));
    if (fwd.lengthSq() < 1e-8) fwd.set(0, 0, 0);
    else fwd.normalize();
    const windowKm = GRID * this.cfg.cellKm;
    // Most of the window ahead of the camera, where the ground is on screen.
    const ahead = windowKm * 0.3;
    const c = camera.position.clone().addScaledVector(fwd, ahead).normalize();
    const fc = dirToFace(c.x, c.y, c.z);
    const U = this.place.uniforms;
    U.uAnchor.value.set(fc.face, Math.floor((fc.s + 1) / this.cellS), Math.floor((fc.t + 1) / this.cellS));
    U.uCellS.value = this.cellS;
    U.uSegments.value = view.segments;
    U.uOcean.value = view.ocean.visible ? 1 : 0;
    U.uDensity.value = this.cfg.density * density;
    U.uCamPos.value.copy(camera.position);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    this.quad.render(renderer);
    renderer.setRenderTarget(prev);
  }

  dispose() {
    this.rt.dispose();
    this.place.dispose();
    this.quad.dispose();
    (this.mesh.material as THREE.Material).dispose();
    (this.shadow.material as THREE.Material).dispose();
  }
}

/**
 * Ejecta blocks and talus near the camera. Placement runs on the GPU every frame (the terrain mesh, and so the
 * ground the rocks sit on, changes with the camera), then each level draws GRID² instanced blocks; empty cells
 * collapse to nothing in the vertex shader.
 */
export class Rocks {
  readonly group = new THREE.Group();
  private levels: Level[];
  private geo = rockGeometry();
  private quad = instanced(new THREE.PlaneGeometry(2, 2));

  constructor(private view: PlanetView) {
    this.levels = LEVELS.map((cfg, i) => new Level(cfg, i, view, this.geo, this.quad));
    for (const l of this.levels) this.group.add(l.shadow, l.mesh);
  }

  update(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, groundAlt: number, density: number, debug: number) {
    const d = debug === 0 ? density : 0;
    for (const l of this.levels) l.update(renderer, this.view, camera, groundAlt, d);
  }

  dispose() {
    for (const l of this.levels) l.dispose();
    this.geo.dispose();
    this.quad.dispose();
  }
}
