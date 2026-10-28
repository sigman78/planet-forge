import * as THREE from 'three';
import noiseGlsl from '../shaders/noise.glsl?raw';

// "Cyber-space" stand-in while a world is forging: a faceted wireframe globe that flickers, fills in
// facet by facet as generation progresses and grows rough relief, then dissolves when the real
// planet arrives.

const VERT = /* glsl */ `
attribute vec3 aBary;
attribute float aFace;
uniform float uTime;
uniform float uShape;      // 0 = smooth ball, 1 = full faceted relief
uniform float uSeed;
varying vec3 vBary;
varying float vFace;
varying vec3 vWorld;
varying vec3 vDir;
void main() {
  vec3 d = normalize(position);
  // Low-order lumps + ridges, quantised into terraces so the facets read as crystalline.
  float h = 0.6 * snoise(d * 1.6 + uSeed) + 0.3 * snoise(d * 3.7 - uSeed) + 0.15 * (1.0 - abs(snoise(d * 7.0 + 3.1)));
  h = floor(h * 6.0 + 0.5) / 6.0;
  float breathe = 0.006 * sin(uTime * 2.3 + d.y * 6.0);
  vec3 p = d * (1.0 + uShape * 0.085 * h + breathe);
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  vDir = d;
  vBary = aBary;
  vFace = aFace;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform float uProgress;   // generation progress 0..1
uniform float uFade;       // 1 = fully visible, 0 = dissolved
uniform float uGain;
uniform vec3 uColor;
uniform vec3 uAccent;
uniform vec3 uSunDir;
varying vec3 vBary;
varying float vFace;
varying vec3 vWorld;
varying vec3 vDir;
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
void main() {
  float r = hash11(vFace);
  // Dissolve: each facet drops out at its own threshold.
  if (r > uFade * 1.05) discard;
  vec3 N = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  vec3 V = normalize(cameraPosition - vWorld);
  float facing = abs(dot(N, V));
  // Edges from barycentrics, constant width in pixels.
  vec3 fw = fwidth(vBary);
  vec3 e3 = smoothstep(vec3(0.0), fw * 1.1, vBary);
  float edge = 1.0 - min(min(e3.x, e3.y), e3.z);
  // Facets fill in along a sweep from pole to pole as the forge progresses.
  float lat = vDir.y * 0.5 + 0.5;
  float sweep = smoothstep(lat - 0.04, lat + 0.04, uProgress * 1.15 - 0.05 + 0.1 * r);
  // Random blinking facets, faster while forging.
  float blink = step(0.965, hash11(vFace * 1.37 + floor(uTime * 4.0 + r * 5.0)));
  // Scan band racing around the globe.
  float band = exp(-pow((fract(vDir.y * 0.5 + 0.5 - uTime * 0.35) - 0.5) * 18.0, 2.0));
  float lit = 0.35 + 0.65 * max(dot(N, uSunDir), 0.0);
  vec3 fill = uColor * (0.003 + 0.025 * sweep * lit) + uAccent * (blink * 0.06 + band * 0.006);
  vec3 col = fill * (0.4 + 0.6 * facing) + uColor * edge * (0.05 + 0.16 * band + 0.06 * sweep);
  // Rim glow.
  col += uColor * pow(1.0 - facing, 4.0) * 0.03;
  // Far side shows through faintly.
  col *= gl_FrontFacing ? 1.0 : 0.25;
  // Facets about to drop out glow faintly during the dissolve.
  col += uColor * 0.12 * smoothstep(uFade * 1.05 - 0.06, uFade * 1.05, r) * step(uFade, 0.999);
  gl_FragColor = vec4(col * uFade * uGain, 1.0);
}`;

function faceted(detail: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, detail).toNonIndexed();
  const n = g.attributes.position.count;
  const bary = new Float32Array(n * 3);
  const face = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    bary[i * 3 + (i % 3)] = 1;
    face[i] = Math.floor(i / 3) + 1;
  }
  g.setAttribute('aBary', new THREE.BufferAttribute(bary, 3));
  g.setAttribute('aFace', new THREE.BufferAttribute(face, 1));
  return g;
}

export class Hologram {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private state: 'off' | 'forging' | 'dissolving' = 'off';
  private fade = 0;
  private shape = 0;
  private targetRadius = 1;

  constructor(sunDir: { value: THREE.Vector3 }) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uShape: { value: 0 },
        uSeed: { value: 0 },
        uProgress: { value: 0 },
        uFade: { value: 0 },
        uGain: { value: 1 },
        uColor: { value: new THREE.Color(0.2, 0.85, 1.0) },
        uAccent: { value: new THREE.Color(1.0, 0.55, 0.2) },
        uSunDir: sunDir,
      },
      vertexShader: noiseGlsl + VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(faceted(3), this.material);
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
  }

  get active() {
    return this.state !== 'off';
  }

  /** Start (or continue) the forging animation at the given radius (km). */
  begin(radiusKm: number, seed: number, overlay = false) {
    // Overlay mode: drawn faintly over the existing world (no depth test, dimmer).
    this.material.depthTest = !overlay;
    this.material.uniforms.uGain.value = overlay ? 0.35 : 1;
    if (this.state !== 'forging') {
      this.shape = 0;
      this.material.uniforms.uSeed.value = (seed % 997) * 0.37;
    }
    this.state = 'forging';
    this.targetRadius = radiusKm;
    if (!this.mesh.visible) this.mesh.scale.setScalar(radiusKm);
    this.mesh.visible = true;
  }

  setProgress(frac: number) {
    this.material.uniforms.uProgress.value = Math.max(this.material.uniforms.uProgress.value, frac);
  }

  /** The real planet is ready: settle onto its radius and dissolve. */
  finish(radiusKm: number) {
    if (this.state === 'off') return;
    this.state = 'dissolving';
    this.targetRadius = radiusKm * 1.01;
  }

  update(dt: number, time: number) {
    if (this.state === 'off') return;
    const U = this.material.uniforms;
    U.uTime.value = time;
    if (this.state === 'forging') {
      this.fade = Math.min(1, this.fade + dt * 4);
      this.shape = Math.min(1, this.shape + dt * 0.25);
      U.uShape.value = Math.max(this.shape, U.uProgress.value);
    } else {
      this.fade = Math.max(0, this.fade - dt * 1.6);
      U.uShape.value = Math.min(1, U.uShape.value + dt);
      if (this.fade <= 0) {
        this.state = 'off';
        this.mesh.visible = false;
        U.uProgress.value = 0;
      }
    }
    U.uFade.value = this.fade;
    const s = this.mesh.scale.x;
    this.mesh.scale.setScalar(s + (this.targetRadius - s) * Math.min(1, dt * 5));
  }
}
