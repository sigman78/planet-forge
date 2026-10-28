// Seeded 3D simplex noise and fractal helpers. No allocations in the hot paths.

/** 32-bit integer hash (lowbias32). */
export function hash32(x: number): number {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d);
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b);
  x = (x ^ (x >>> 16)) >>> 0;
  return x;
}

/** Hash of two ints -> uint32. */
export function hash2(a: number, b: number): number {
  return hash32((a ^ hash32(b + 0x9e3779b9)) >>> 0);
}

/** Seeded PRNG (sfc32). `next()` returns a float in [0, 1). */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  constructor(seed: number, stream = 0) {
    this.a = hash2(seed, stream * 4 + 1);
    this.b = hash2(seed, stream * 4 + 2);
    this.c = hash2(seed, stream * 4 + 3);
    this.d = 1;
    for (let i = 0; i < 12; i++) this.nextU32();
  }
  nextU32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t;
  }
  next(): number {
    return this.nextU32() / 4294967296;
  }
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  /** Approximately normal (sum of 4 uniforms). */
  gauss(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.7320508;
  }
  /** Uniform random unit vector written into out[o..o+2]. */
  unitVec(out: Float64Array | number[], o = 0): void {
    const z = this.next() * 2 - 1;
    const a = this.next() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    out[o] = r * Math.cos(a);
    out[o + 1] = r * Math.sin(a);
    out[o + 2] = z;
  }
}

const F3 = 1 / 3;
const G3 = 1 / 6;
// 12 edge gradients, padded to 16 by repeating 4 (cheap mod via & 15).
const GX = new Float64Array([1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0, 1, 0, -1, 0]);
const GY = new Float64Array([1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 1, -1, 1, -1]);
const GZ = new Float64Array([0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1, 0, 1, 0, -1]);

/**
 * Seeded 3D simplex noise with fractal helpers. Output of `simplex` is roughly in [-1, 1].
 * Use one instance per seed and offset coordinates to decorrelate layers.
 */
export class Noise3 {
  private perm: Uint8Array;
  /** Scratch output for warp helpers. */
  readonly w: Float64Array = new Float64Array(3);

  constructor(seed: number) {
    const rng = new Rng(seed, 7);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = rng.int(i + 1);
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  simplex(x: number, y: number, z: number): number {
    const perm = this.perm;
    const s = (x + y + z) * F3;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const k = Math.floor(z + s);
    const t = (i + j + k) * G3;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const z0 = z - (k - t);
    let i1: number, j1: number, k1: number, i2: number, j2: number, k2: number;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
    const ii = i & 255, jj = j & 255, kk = k & 255;
    let n = 0;
    let tt = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (tt > 0) {
      const g = perm[ii + perm[jj + perm[kk]]] & 15;
      tt *= tt;
      n += tt * tt * (GX[g] * x0 + GY[g] * y0 + GZ[g] * z0);
    }
    tt = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (tt > 0) {
      const g = perm[ii + i1 + perm[jj + j1 + perm[kk + k1]]] & 15;
      tt *= tt;
      n += tt * tt * (GX[g] * x1 + GY[g] * y1 + GZ[g] * z1);
    }
    tt = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (tt > 0) {
      const g = perm[ii + i2 + perm[jj + j2 + perm[kk + k2]]] & 15;
      tt *= tt;
      n += tt * tt * (GX[g] * x2 + GY[g] * y2 + GZ[g] * z2);
    }
    tt = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (tt > 0) {
      const g = perm[ii + 1 + perm[jj + 1 + perm[kk + 1]]] & 15;
      tt *= tt;
      n += tt * tt * (GX[g] * x3 + GY[g] * y3 + GZ[g] * z3);
    }
    return 32 * n;
  }

  /** Fractional Brownian motion, normalised so the result is roughly in [-1, 1] (std ≈ 0.3). */
  fbm(x: number, y: number, z: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let sum = 0, amp = 1, norm = 0;
    let f = 1;
    for (let o = 0; o < octaves; o++) {
      // Per-octave offset breaks up the alignment of the lattice between octaves.
      sum += amp * this.simplex(x * f + o * 17.31, y * f - o * 9.73, z * f + o * 5.17);
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    // Fractional last octave so octave counts derived from resolution blend smoothly.
    return sum / norm;
  }

  /**
   * Ridged multifractal (Musgrave style) in [0, ~1]. Sharp crests where the base noise crosses zero.
   * `sharpness` is the exponent applied to each ridge; successive octaves are weighted by the previous one
   * so detail concentrates on the crests.
   */
  ridged(x: number, y: number, z: number, octaves: number, sharpness = 2, lacunarity = 2.1, gain = 0.5): number {
    let sum = 0, amp = 1, norm = 0, weight = 1;
    let f = 1;
    for (let o = 0; o < octaves; o++) {
      let r = 1 - Math.abs(this.simplex(x * f + o * 31.7, y * f + o * 13.1, z * f - o * 7.9));
      r = Math.pow(r, sharpness);
      const v = r * weight;
      sum += v * amp;
      norm += amp;
      weight = Math.min(1, v * 1.6);
      amp *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }

  /** Billow noise in roughly [-1, 1]: rounded bumps and creased valleys. */
  billow(x: number, y: number, z: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let sum = 0, amp = 1, norm = 0;
    let f = 1;
    for (let o = 0; o < octaves; o++) {
      sum += amp * (2 * Math.abs(this.simplex(x * f - o * 3.3, y * f + o * 21.1, z * f + o * 11.9)) - 1);
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }

  /** Vector fbm (three decorrelated channels) written into `this.w`. */
  warp3(x: number, y: number, z: number, octaves: number): Float64Array {
    const w = this.w;
    w[0] = this.fbm(x + 31.416, y - 12.7, z + 4.2, octaves);
    w[1] = this.fbm(x - 7.31, y + 51.9, z - 23.3, octaves);
    w[2] = this.fbm(x + 17.7, y + 9.1, z + 63.8, octaves);
    return w;
  }
}

export function smoothstep(e0: number, e1: number, x: number): number {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
