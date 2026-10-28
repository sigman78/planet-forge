import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import starsGlsl from '../shaders/stars.glsl?raw';
import sunGlsl from '../shaders/sun.glsl?raw';
import { splitShader, type SharedUniforms } from './planetView.ts';

export interface Sky {
  stars: THREE.Points;
  sun: THREE.Mesh;
  background: THREE.Texture | null;
  setStarIntensity(v: number): void;
  setSunSize(v: number): void;
  update(camera: THREE.PerspectiveCamera, pixelRatio: number): void;
}

export async function createSky(scene: THREE.Scene, shared: SharedUniforms, base = `${import.meta.env.BASE_URL}sky/`): Promise<Sky> {
  const manifest = await (await fetch(base + 'manifest.json')).json();
  let background: THREE.Texture | null = null;
  try {
    background = await new HDRLoader().loadAsync(base + manifest.hdr);
    background.mapping = THREE.EquirectangularReflectionMapping;
    scene.background = background;
    scene.backgroundIntensity = 1;
  } catch (e) {
    console.warn('Sky HDR failed to load', e);
    scene.background = new THREE.Color(0x000000);
  }

  const buf = await (await fetch(base + manifest.stars)).arrayBuffer();
  const rec = new Float32Array(buf);
  const count = rec.length / 6;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos.set(rec.subarray(i * 6, i * 6 + 3), i * 3);
    col.set(rec.subarray(i * 6 + 3, i * 6 + 6), i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const [sv, sf] = splitShader(starsGlsl);
  const starMat = new THREE.ShaderMaterial({
    uniforms: { uIntensity: { value: 1 }, uPixelRatio: { value: 1 } },
    vertexShader: sv,
    fragmentShader: sf,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    transparent: false,
  });
  const stars = new THREE.Points(geo, starMat);
  stars.frustumCulled = false;
  stars.renderOrder = -100;
  scene.add(stars);

  const [uv, uf] = splitShader(sunGlsl);
  const sunMat = new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: shared.uSunDir,
      uSunColor: shared.uSunColor,
      uSize: { value: 0.35 },
      uAspect: { value: 1 },
      uDiscIntensity: { value: 400 },
      uDiscRadius: { value: 0.025 },
    },
    vertexShader: uv,
    fragmentShader: uf,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    transparent: true,
  });
  const sun = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), sunMat);
  sun.frustumCulled = false;
  sun.renderOrder = 50;
  scene.add(sun);

  return {
    stars,
    sun,
    background,
    setStarIntensity(v) {
      starMat.uniforms.uIntensity.value = v;
    },
    setSunSize(v) {
      sunMat.uniforms.uSize.value = v;
    },
    update(camera, pixelRatio) {
      sunMat.uniforms.uAspect.value = camera.aspect;
      starMat.uniforms.uPixelRatio.value = pixelRatio;
    },
  };
}
