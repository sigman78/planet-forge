import * as THREE from 'three';
import type { PlanetView } from './planetView.ts';
import type { HQTerrain } from './hqTerrain.ts';
import type { Rocks } from './rocks.ts';

/** Depth map size (texels per side). */
const SIZE = 2048;
/** Finest ring levels drawn into the map (the outermost of them sets the map's reach). */
export const NEAR_SHADOW_LEVELS = 6;

/**
 * Near shadow map: the sun's view of the ground around the camera. The baked heightmap's shadow march (terrain_light)
 * only knows relief at its 512-texel resolution, so crater rims and boulders close to the camera cast nothing.
 * This renders the finest HQ ring levels and the surface rocks from the sun into an orthographic depth map fitted
 * to the ground disc the rings cover, and every surface shader samples it (nearShadow in terrain_light.glsl), so
 * the detail that is drawn is the detail that shadows.
 */
export class NearShadow {
  readonly rt: THREE.WebGLRenderTarget;
  readonly cam = new THREE.OrthographicCamera();
  /** 1 while the map is in use this frame (0 = surfaces ignore it). */
  weight = 0;
  private readonly basis = { t1: new THREE.Vector3(), t2: new THREE.Vector3(), n: new THREE.Vector3(), g: new THREE.Vector3() };
  private readonly tmp = new THREE.Vector3();

  constructor() {
    const depthTexture = new THREE.DepthTexture(SIZE, SIZE, THREE.FloatType);
    this.rt = new THREE.WebGLRenderTarget(SIZE, SIZE, { depthTexture, type: THREE.UnsignedByteType, generateMipmaps: false });
  }

  /**
   * Fit the map to the rings around the camera and render the casters. Sets the shared uniforms the surface
   * shaders read. `on` false, no rings, or the sun below the horizon leave the map off.
   */
  update(renderer: THREE.WebGLRenderer, view: PlanetView, hq: HQTerrain, rocks: Rocks, camera: THREE.Camera, groundAltKm: number, on: boolean) {
    const T = view.terrainMat.uniforms;
    const K = hq.activeLevels;
    const sun = T.uSunDir.value as THREE.Vector3;
    const n = this.basis.n.copy(camera.position).normalize();
    const elev = n.dot(sun);
    const extent = hq.shadowExtentKm;
    if (!on || K === 0 || !view.group.visible || elev < 0.02 || extent <= 0) {
      this.weight = 0;
      T.uNearShadow.value = 0;
      return;
    }
    // Ground disc under the camera: the outermost mapped ring is a square of side `extent` on the nadir.
    const Rd = 0.6 * extent;
    const h = 0.5 * Rd + 0.1;   // relief half-range the box allows for (slopes up to 2:1 plus a little)
    const r = camera.position.length();
    const g = this.basis.g.copy(n).multiplyScalar(r - groundAltKm);
    const t1 = this.basis.t1.crossVectors(n, Math.abs(n.y) < 0.9 ? Y : X).normalize();
    const t2 = this.basis.t2.crossVectors(n, t1);
    // Sun camera: looking down the sun direction at the ground point, up along the local vertical.
    const cam = this.cam;
    cam.position.copy(g).addScaledVector(sun, 3 * Rd + 2 * h);
    cam.up.copy(Math.abs(elev) < 0.98 ? n : t1);
    cam.lookAt(g);
    cam.updateMatrixWorld(true);
    const inv = cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    // Bounds of the disc's box in the sun's frame: a thin band at a low sun, so the texels go where the ground is.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const p = this.tmp;
    for (let i = 0; i < 8; i++) {
      p.copy(g).addScaledVector(t1, i & 1 ? Rd : -Rd).addScaledVector(t2, i & 2 ? Rd : -Rd).addScaledVector(n, i & 4 ? h : -h);
      p.applyMatrix4(inv);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    cam.left = minX; cam.right = maxX; cam.bottom = minY; cam.top = maxY;
    // Reach back toward the sun by the disc size, so what shadows the disc from outside it still renders.
    cam.near = Math.max(0.01, -maxZ - extent);
    cam.far = -minZ + 0.1;
    // The renderer flips a camera to reversed depth when it first draws with it; do it here so the matrix the
    // surfaces sample with is the one the map was drawn with.
    (cam as unknown as { _reversedDepth: boolean })._reversedDepth = renderer.state.buffers.depth.getReversed();
    cam.updateProjectionMatrix();
    (T.uNearShadowVP.value as THREE.Matrix4).multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    T.uNearShadowKm.value = Math.max(maxX - minX, maxY - minY) / SIZE;
    const e = cam.matrixWorld.elements;
    (T.uNearShadowU.value as THREE.Vector3).set(e[0], e[1], e[2]).multiplyScalar((maxX - minX) / SIZE);
    (T.uNearShadowV.value as THREE.Vector3).set(e[4], e[5], e[6]).multiplyScalar((maxY - minY) / SIZE);
    T.uNearShadowRange.value = cam.far - cam.near;
    T.tNearShadow.value = this.rt.depthTexture;
    // Fade in from the horizon: at a grazing sun the map is a sliver and the baked march's shadows take over.
    this.weight = THREE.MathUtils.smoothstep(elev, 0.02, 0.1);
    T.uNearShadow.value = this.weight;

    const prev = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.autoClear = false;
    hq.shadowGroup.visible = true;
    renderer.render(hq.shadowGroup, cam);
    hq.shadowGroup.visible = false;
    rocks.shadowGroup.visible = true;
    renderer.render(rocks.shadowGroup, cam);
    rocks.shadowGroup.visible = false;
    renderer.autoClear = autoClear;
    renderer.setRenderTarget(prev);
  }

  dispose() {
    this.rt.dispose();
  }
}

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);

/** Depth-only material that drives the same vertex program as `mat` with its uniforms (shared by reference). */
export function depthMaterial(mat: THREE.ShaderMaterial, vertexShader: string) {
  return new THREE.ShaderMaterial({
    uniforms: mat.uniforms,
    vertexShader,
    fragmentShader: 'void main() { gl_FragColor = vec4(1.0); }',
    colorWrite: false,
    side: THREE.DoubleSide,
  });
}
