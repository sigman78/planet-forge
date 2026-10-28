import * as THREE from 'three';
import type { PlanetData } from '../core/types.ts';
import { sampleDir } from '../core/cube.ts';

// Smoothed body figure for the atmosphere: a tiny equirectangular map of the large-scale shape
// (heights averaged over a ~10° cap), so the air follows a lumpy body instead of a perfect sphere.

export const FIG_W = 64;
export const FIG_H = 32;

export function createFigureTexture(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint16Array(FIG_W * FIG_H), FIG_W, FIG_H, THREE.RedFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** Smoothed figure in metres above the datum, FIG_W x FIG_H texels (u: atan(z, x), v: polar angle). */
export function computeFigureM(data: PlanetData): Float32Array {
  const out = new Float32Array(FIG_W * FIG_H);
  const d = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), q = new THREE.Vector3();
  const rings: [number, number, number][] = [
    [0.08, 8, 1],
    [0.17, 12, 0.6],
  ];
  for (let y = 0; y < FIG_H; y++) {
    const theta = ((y + 0.5) / FIG_H) * Math.PI;
    for (let x = 0; x < FIG_W; x++) {
      const phi = ((x + 0.5) / FIG_W - 0.5) * Math.PI * 2;
      d.set(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi));
      t1.set(0, 1, 0).cross(d);
      if (t1.lengthSq() < 1e-6) t1.set(1, 0, 0);
      t1.normalize();
      t2.copy(d).cross(t1);
      let sum = sampleDir(data.height, data.N, d.x, d.y, d.z);
      let wsum = 1;
      for (const [a, n, w] of rings) {
        for (let k = 0; k < n; k++) {
          const b = (k / n) * Math.PI * 2;
          q.copy(d).multiplyScalar(Math.cos(a)).addScaledVector(t1, Math.sin(a) * Math.cos(b)).addScaledVector(t2, Math.sin(a) * Math.sin(b));
          sum += w * sampleDir(data.height, data.N, q.x, q.y, q.z);
          wsum += w;
        }
      }
      out[y * FIG_W + x] = sum / wsum;
    }
  }
  return out;
}

/** Upload the figure in km (with the look's exaggeration). Returns the highest point in km. */
export function updateFigureTexture(tex: THREE.DataTexture, figM: Float32Array, kmPerM: number, seaFloorScale: number): number {
  const arr = tex.image.data as Uint16Array;
  let max = 0;
  for (let i = 0; i < figM.length; i++) {
    const m = figM[i];
    const km = (m < 0 ? m * seaFloorScale : m) * kmPerM;
    max = Math.max(max, km);
    arr[i] = THREE.DataUtils.toHalfFloat(km);
  }
  tex.needsUpdate = true;
  return max;
}
