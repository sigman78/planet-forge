import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { dirToFace, faceST, faceToDir } from '../core/cube.ts';
import { COMMON, splitShader, type PlanetView } from './planetView.ts';
import { depthMaterial } from './nearShadow.ts';
import { fullScreenTriangle } from './hqTerrain.ts';
import terrainCommon from '../shaders/terrain_common.glsl?raw';
import terrainLight from '../shaders/terrain_light.glsl?raw';
import terrainFine from '../shaders/terrain_fine.glsl?raw';
import terrainHq from '../shaders/terrain_hq.glsl?raw';
import placeFrag from '../shaders/rocks_place.frag.glsl?raw';
import rocksGlsl from '../shaders/rocks.glsl?raw';
import shadowGlsl from '../shaders/rock_shadow.glsl?raw';

const GRID = 96;
/** Windows per level: one per cube face the rock area touches (three meet at a corner). */
const MAX_WINDOWS = 3;

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

// A block of radius r is 2 px at about 540 r (45 deg fov at ~850 px). Each level's window (GRID cells across,
// centred on the nadir) reaches GRID / 2 cells from the camera, and its largest block must be under 2 px by
// then (rMax <= reach / 540, i.e. cell >= 8.5 rMax), or blocks visibly grow in at the window's edge as the
// camera moves. The level itself comes on at that same height, so it also arrives under 2 px. Nothing under
// 3 m: with the camera floored at 500 m such pebbles are specks, and a level of them cost as much as the rest.
const LEVELS: RockLevel[] = [
  { cellKm: 0.06, rMin: 0.003, rMax: 0.0053, maxAlt: 2.9, density: 0.8, clusterKm: 1.5 },
  { cellKm: 0.24, rMin: 0.0053, rMax: 0.021, maxAlt: 11.5, density: 0.5, clusterKm: 6 },
  { cellKm: 0.9, rMin: 0.021, rMax: 0.08, maxAlt: 43, density: 0.35, clusterKm: 20 },
];

// Blocks per layer: dust, highland, basalt, sand, rock, gravel, ice, salt.
const ROCK_DENSITY = [0.08, 0.3, 0.45, 0, 1, 0.7, 0.25, 0.05];

/** Real-scale tiling of the layer textures on the rocks (tiles per metre). */
const ROCK_TILE = 0.35;

function instanced(base: THREE.BufferGeometry | THREE.InstancedBufferGeometry): THREE.InstancedBufferGeometry {
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
  /** The blocks drawn from the sun into the near shadow map. */
  readonly depth: THREE.Mesh;
  private cellS = 0;
  /** What the last placement pass was run for; the pass is skipped while nothing in it changes. */
  private placedKey = '';
  private placedData: unknown = null;
  private placedAge = 0;
  /** Ground distance (km) from the nadir to the window edge; shared by the block and shadow materials. */
  private reach = { value: 1 };
  // Per-level views of the shared buffers: each level draws as many windows as it uses.
  private geo: THREE.InstancedBufferGeometry;
  private quadGeo: THREE.InstancedBufferGeometry;

  constructor(readonly cfg: RockLevel, readonly index: number, view: PlanetView, geo: THREE.InstancedBufferGeometry, quad: THREE.InstancedBufferGeometry) {
    this.geo = geo = instanced(geo);
    this.quadGeo = quad = instanced(quad);
    // Windows stacked vertically: window w holds rows [w * GRID, (w + 1) * GRID).
    this.rt = new THREE.WebGLRenderTarget(GRID * 3, GRID * MAX_WINDOWS, {
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
        uAnchor: { value: Array.from({ length: MAX_WINDOWS }, () => new THREE.Vector3()) },
        uWindows: { value: 1 },
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
      fragmentShader: COMMON + terrainCommon + terrainFine + terrainHq + terrainLight + placeFrag,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.place);
    const [vs, fs] = splitShader(rocksGlsl);
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...T, tRock: { value: this.rt.texture }, uRockTile: { value: ROCK_TILE }, uReach: this.reach },
      vertexShader: COMMON + terrainCommon + vs,
      fragmentShader: COMMON + terrainCommon + terrainLight + fs,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 0.6;
    this.depth = new THREE.Mesh(geo, depthMaterial(mat, mat.vertexShader));
    this.depth.frustumCulled = false;
    // Shadow decals multiply the lit ground (dst *= src) after the terrain and before the rocks.
    const [svs, sfs] = splitShader(shadowGlsl);
    const smat = new THREE.ShaderMaterial({
      uniforms: { ...T, tRock: { value: this.rt.texture }, uReach: this.reach },
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

  /**
   * Window centred on the camera's nadir, snapped to world cells. Cells belong to the face they lie on and are
   * hashed in that face's grid, so when the rock area reaches over a cube edge the neighbour face gets a window
   * of its own instead of the anchor face's grid running on (which reshuffled every rock as the centre crossed
   * the edge). The window is not pushed ahead along the heading: that made every turn of the camera move the
   * window, and the blocks fading at its edge grew, shrank and vanished as the view swung.
   */
  update(renderer: THREE.WebGLRenderer, view: PlanetView, camera: THREE.PerspectiveCamera, groundAlt: number, density: number) {
    const on = density > 0 && groundAlt < this.cfg.maxAlt && view.data !== null;
    this.mesh.visible = this.shadow.visible = this.depth.visible = on;
    if (!on) return;
    const R = view.shared.uPlanetRadius.value;
    this.cellS = 2 / Math.round((R * Math.PI * 0.5) / this.cfg.cellKm);
    this.reach.value = (GRID / 2) * this.cfg.cellKm;
    const c = camera.position.clone().normalize();
    const fc = dirToFace(c.x, c.y, c.z);
    const half = (GRID / 2) * this.cellS * 1.05;
    const faces = [fc.face];
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        const d = faceToDir(fc.face, fc.s + a * half, fc.t + b * half);
        const f = dirToFace(d[0], d[1], d[2]).face;
        if (!faces.includes(f) && faces.length < MAX_WINDOWS) faces.push(f);
      }
    }
    const U = this.place.uniforms;
    faces.forEach((f, k) => {
      const st = k === 0 ? fc : faceST(f, c.x, c.y, c.z);
      U.uAnchor.value[k].set(f, Math.floor((st.s + 1) / this.cellS), Math.floor((st.t + 1) / this.cellS));
    });
    U.uWindows.value = faces.length;
    this.geo.instanceCount = this.quadGeo.instanceCount = GRID * GRID * faces.length;
    U.uCellS.value = this.cellS;
    U.uSegments.value = view.segments;
    U.uOcean.value = view.seaSolid ? 1 : 0;
    U.uDensity.value = this.cfg.density * density;
    U.uCamPos.value.copy(camera.position);
    // Placement depends on the windows, the camera (within 10 cm), the sun and the rings' state; a still camera
    // keeps last frame's rocks.
    const T = view.terrainMat.uniforms;
    const K = T.uHQK.value as number;
    const hqKey = Array.from({ length: K }, (_, k) => {
      const o = (T.uHQOriginA.value as THREE.Vector2[])[k], n = (T.uHQNadirA.value as THREE.Vector2[])[k];
      return `${o.x},${o.y},${n.x.toFixed(4)},${n.y.toFixed(4)},${(T.uHQBlendA.value as number[])[k].toFixed(4)}`;
    }).join(';');
    const p = camera.position, sun = T.uSunDir.value as THREE.Vector3, morph = T.uHQMorph.value as THREE.Vector2;
    const key = `${faces.join()}|${U.uAnchor.value.map((a: THREE.Vector3) => `${a.x},${a.y},${a.z}`).join()}|${this.cellS}|${view.segments}|${U.uOcean.value}|${U.uDensity.value}|${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)}|${sun.x.toFixed(3)},${sun.y.toFixed(3)},${sun.z.toFixed(3)}|${K}|${T.uHQFace.value}|${T.uHQN.value}|${morph.x},${morph.y}|${hqKey}`;
    // Height sliders and the like change the ground without touching the key: a still camera re-places every
    // 30 frames anyway.
    if (key === this.placedKey && view.data === this.placedData && ++this.placedAge < 30) return;
    this.placedKey = key;
    this.placedData = view.data;
    this.placedAge = 0;
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
    (this.depth.material as THREE.Material).dispose();
    this.geo.dispose();
    this.quadGeo.dispose();
  }
}

/**
 * Ejecta blocks and talus near the camera. Placement runs on the GPU every frame: a rock's place, size, layer
 * and the slope it sits on come from the height field at its world cell and never change, but its height follows
 * the footprint the terrain is drawn at there, which refines with the camera. Each level then draws GRID²
 * instanced blocks; empty cells collapse to nothing in the vertex shader.
 */
export class Rocks {
  readonly group = new THREE.Group();
  /** Depth-only blocks for the near shadow map; shown only while that renders. */
  readonly shadowGroup = new THREE.Group();
  private levels: Level[];
  private geo = rockGeometry();
  private quad = instanced(new THREE.PlaneGeometry(2, 2));

  constructor(private view: PlanetView) {
    this.levels = LEVELS.map((cfg, i) => new Level(cfg, i, view, this.geo, this.quad));
    for (const l of this.levels) {
      this.group.add(l.shadow, l.mesh);
      this.shadowGroup.add(l.depth);
    }
    this.shadowGroup.visible = false;
    this.group.add(this.shadowGroup);
  }

  update(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, groundAlt: number, density: number, debug: number) {
    const d = debug === 0 ? density : 0;
    for (const l of this.levels) l.update(renderer, this.view, camera, groundAlt, d);
  }

  /**
   * Throwaway meshes carrying every material a rock level uses (placement, blocks, shadow decal, depth), for
   * compiling their programs ahead of the first descent (see `warmPrograms` in main.ts). The levels share them.
   */
  programObjects(): THREE.Object3D[] {
    const l = this.levels[0];
    return [
      new THREE.Mesh(fullScreenTriangle(), l.place),
      new THREE.Mesh(this.geo, l.mesh.material),
      new THREE.Mesh(this.quad, l.shadow.material),
      new THREE.Mesh(this.geo, l.depth.material),
    ];
  }

  dispose() {
    for (const l of this.levels) l.dispose();
    this.geo.dispose();
    this.quad.dispose();
  }
}
