import { describe, expect, it } from 'vitest';
import { dirToFace, faceToDir, FACE_BASIS, refillGutters, sampleDir, texelToS, sToTexel } from './cube';

describe('cube mapping', () => {
  it('basis is right handed (u x v = n)', () => {
    for (const { n, u, v } of FACE_BASIS) {
      const c = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      expect(c.map((x) => x + 0)).toEqual(n.map((x) => x + 0));
    }
  });

  it('face -> dir -> face round trips', () => {
    for (let f = 0; f < 6; f++) {
      for (let i = 0; i <= 20; i++) {
        for (let j = 0; j <= 20; j++) {
          const s = -0.999 + (1.998 * i) / 20;
          const t = -0.999 + (1.998 * j) / 20;
          const d = faceToDir(f, s, t);
          const fc = dirToFace(d[0], d[1], d[2]);
          expect(fc.face).toBe(f);
          expect(fc.s).toBeCloseTo(s, 9);
          expect(fc.t).toBeCloseTo(t, 9);
        }
      }
    }
  });

  it('texel <-> s', () => {
    const N = 64;
    for (let i = 0; i < N + 2; i++) expect(sToTexel(texelToS(i, N), N)).toBeCloseTo(i, 9);
    expect(texelToS(1, N)).toBeCloseTo(-1 + 1 / N, 12);
    expect(texelToS(N, N)).toBeCloseTo(1 - 1 / N, 12);
  });

  it('gutter refill makes a smooth field sample continuously across face edges', () => {
    const N = 64;
    const T = N + 2;
    const data = new Float32Array(6 * T * T);
    const f = (x: number, y: number, z: number) => Math.sin(3 * x) + Math.cos(2 * y + z) + x * z;
    for (let face = 0; face < 6; face++)
      for (let y = 1; y <= N; y++)
        for (let x = 1; x <= N; x++) {
          const d = faceToDir(face, texelToS(x, N), texelToS(y, N));
          data[(face * T + y) * T + x] = f(d[0], d[1], d[2]);
        }
    refillGutters(data, N);
    // Walk along a great circle crossing several faces; compare to analytic function.
    let maxErr = 0;
    for (let k = 0; k < 2000; k++) {
      const a = (k / 2000) * Math.PI * 2;
      const d = [Math.cos(a) * 0.8, 0.6 * Math.sin(a * 0.5), Math.sin(a) * 0.8];
      const l = Math.hypot(d[0], d[1], d[2]);
      const v = sampleDir(data, N, d[0] / l, d[1] / l, d[2] / l);
      maxErr = Math.max(maxErr, Math.abs(v - f(d[0] / l, d[1] / l, d[2] / l)));
    }
    expect(maxErr).toBeLessThan(0.01);
  });
});
