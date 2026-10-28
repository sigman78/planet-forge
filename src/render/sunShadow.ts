import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import terrainCommon from '../shaders/terrain_common.glsl?raw';
import { COMMON } from './planetView.ts';
import type { PlanetView } from './planetView.ts';

/**
 * Sun shadow-height map for volumetric haze. For every column of the cube sphere it stores the elevation (km
 * above the datum) above which the air is sunlit (R), and how far that sits above the ground (G, used to stretch
 * the shafts). For a heightfield under a parallel sun, "lit" is monotonic in
 * altitude, so one number per column is enough: a haze sample is lit when it sits above it. On a curved body
 * that is an approximation (horizon mapping), good at haze altitudes.
 *
 * Six faces are tiled 3 x 2 in one half-float target. It is rebuilt only when the sun, the planet or the
 * vertical exaggeration changes (a few ms at 512² per face).
 */
const FRAG = /* glsl */ `
uniform vec3 uSun;
uniform float uMaxElev;   // km, highest terrain elevation (with exaggeration)
varying vec2 vUv;

// Face grid (s, t) in [-1,1] -> unit direction (inverse of dirToFace in cube.glsl).
vec3 faceDir(float face, vec2 st) {
  vec2 c = tan(st * 0.78539816);
  vec3 d;
  if (face < 0.5) d = vec3(1.0, c.y, -c.x);
  else if (face < 1.5) d = vec3(-1.0, c.y, c.x);
  else if (face < 2.5) d = vec3(c.x, 1.0, -c.y);
  else if (face < 3.5) d = vec3(c.x, -1.0, c.y);
  else if (face < 4.5) d = vec3(c.x, c.y, 1.0);
  else d = vec3(-c.x, c.y, -1.0);
  return normalize(d);
}

void main() {
  vec2 a = vUv * vec2(3.0, 2.0);
  vec2 cell = min(floor(a), vec2(2.0, 1.0));
  vec2 st = (a - cell) * 2.0 - 1.0;
  vec3 n = faceDir(cell.x + 3.0 * cell.y, st);
  float R = uRadius;
  float e0 = elevationKm(bakedHeightM(n));
  float cz = dot(n, uSun);
  // Far past the terminator the planet itself shadows everything.
  if (cz < -0.45) { gl_FragColor = vec4(1e4, 0.0, 0.0, 1.0); return; }
  vec3 p0 = n * (R + e0);
  // March until the ray has risen above the highest terrain (t cz + t^2 / 2R = dh).
  float dh = max(uMaxElev - e0, 0.05);
  float tMax = min(R * (-cz + sqrt(cz * cz + 2.0 * dh / R)), 1.2 * R);
  float t = R * 1.5707963 / uN * 0.7;
  float k = pow(max(tMax / t, 1.0001), 1.0 / 63.0);
  float lift = 0.0;
  for (int i = 0; i < 64; i++) {
    vec3 q = p0 + uSun * t;
    float rq = length(q);
    vec3 d = q / rq;
    float need = R + elevationKm(bakedHeightM(d)) - rq;
    // A radial lift at the start raises the ray at q by about lift * cos(angle between n and d).
    lift = max(lift, need / max(dot(n, d), 0.3));
    t *= k;
  }
  gl_FragColor = vec4(e0 + lift, lift, 0.0, 1.0);   // R: lit above (km over the datum), G: height of the shadow over the ground
}
`;

export class SunShadowMap {
  readonly rt: THREE.WebGLRenderTarget;
  private mat: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  private lastSun = new THREE.Vector3();
  private lastKey = '';

  constructor(private view: PlanetView, size = 512) {
    this.rt = new THREE.WebGLRenderTarget(size * 3, size * 2, {
      type: THREE.HalfFloatType,
      format: THREE.RGFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      generateMipmaps: false,
    });
    const U = view.terrainMat.uniforms;
    this.mat = new THREE.ShaderMaterial({
      // Share the terrain's height uniforms (texture, radius, exaggeration) by reference.
      uniforms: { ...U, uSun: { value: new THREE.Vector3() }, uMaxElev: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: COMMON + terrainCommon + FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.mat);
  }

  get size() {
    return this.rt.height / 2;
  }

  /** Rebuild when anything that moves the shadows changed. Returns true when it rendered. */
  update(renderer: THREE.WebGLRenderer, sunDir: THREE.Vector3): boolean {
    const d = this.view.data;
    if (!d) return false;
    const U = this.view.terrainMat.uniforms;
    const key = `${d.radius}|${d.maxHeight}|${d.minHeight}|${U.uHeightScale.value}|${U.uSeaFloorScale.value}|${U.uN.value}`;
    if (key === this.lastKey && this.lastSun.angleTo(sunDir) < 0.002) return false;
    this.lastKey = key;
    this.lastSun.copy(sunDir);
    (this.mat.uniforms.uSun.value as THREE.Vector3).copy(sunDir).normalize();
    this.mat.uniforms.uMaxElev.value = Math.max(d.maxHeight, 0) * U.uHeightScale.value;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    this.quad.render(renderer);
    renderer.setRenderTarget(prev);
    return true;
  }

  dispose() {
    this.rt.dispose();
    this.mat.dispose();
    this.quad.dispose();
  }
}
