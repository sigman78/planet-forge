// Cube-sphere mapping shared by the generator (TS) and the renderer (GLSL copy in src/shaders/cube.glsl).
// Keep both files in sync. See CONTRACT.md for the full description.

export type Vec3 = [number, number, number];

/** Face order follows the GL cubemap convention: +X, -X, +Y, -Y, +Z, -Z. */
export const FACE_COUNT = 6;

/** Per face basis: n = face normal, u = right, v = up. u x v = n for every face (consistent winding). */
export const FACE_BASIS: ReadonlyArray<{ n: Vec3; u: Vec3; v: Vec3 }> = [
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] }, // 0 +X
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] }, // 1 -X
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] }, // 2 +Y
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] }, // 3 -Y
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, // 4 +Z
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] }, // 5 -Z
];

const QUARTER_PI = Math.PI / 4;

/** Grid coordinate s in [-1,1] -> cube-plane coordinate. The tan warp evens out texel size over the sphere. */
export function warp(s: number): number {
  return Math.tan(s * QUARTER_PI);
}

/** Cube-plane coordinate -> grid coordinate s. */
export function unwarp(c: number): number {
  return Math.atan(c) / QUARTER_PI;
}

/** Face grid coordinates (s,t) in [-1,1] (values slightly outside are fine, used for gutters) -> unit direction. */
export function faceToDir(face: number, s: number, t: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const b = FACE_BASIS[face];
  const cu = warp(s);
  const cv = warp(t);
  const x = b.n[0] + cu * b.u[0] + cv * b.v[0];
  const y = b.n[1] + cu * b.u[1] + cv * b.v[1];
  const z = b.n[2] + cu * b.u[2] + cv * b.v[2];
  const inv = 1 / Math.hypot(x, y, z);
  out[0] = x * inv;
  out[1] = y * inv;
  out[2] = z * inv;
  return out;
}

export interface FaceCoord {
  face: number;
  s: number;
  t: number;
}

/** Unit (or any non-zero) direction -> owning face and grid coordinates. Tie-break order matches the GLSL. */
export function dirToFace(x: number, y: number, z: number, out: FaceCoord = { face: 0, s: 0, t: 0 }): FaceCoord {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  let face: number;
  let cu: number;
  let cv: number;
  if (ax >= ay && ax >= az) {
    if (x > 0) { face = 0; cu = -z / ax; cv = y / ax; }
    else { face = 1; cu = z / ax; cv = y / ax; }
  } else if (ay >= az) {
    if (y > 0) { face = 2; cu = x / ay; cv = -z / ay; }
    else { face = 3; cu = x / ay; cv = z / ay; }
  } else {
    if (z > 0) { face = 4; cu = x / az; cv = y / az; }
    else { face = 5; cu = -x / az; cv = y / az; }
  }
  out.face = face;
  out.s = unwarp(cu);
  out.t = unwarp(cv);
  return out;
}

/**
 * Grid coordinates of a direction on a chosen face, extended past its edges (the direction need not lie on that
 * face, only in its hemisphere). Used where a window of cells on one face reaches across an edge.
 */
export function faceST(face: number, x: number, y: number, z: number): { s: number; t: number } {
  const b = FACE_BASIS[face];
  const dn = Math.max(x * b.n[0] + y * b.n[1] + z * b.n[2], 1e-6);
  return {
    s: unwarp((x * b.u[0] + y * b.u[1] + z * b.u[2]) / dn),
    t: unwarp((x * b.v[0] + y * b.v[1] + z * b.v[2]) / dn),
  };
}

// ---- Texel layout with a 1-texel gutter --------------------------------------------------------
// A face with interior resolution N is stored as T = N + 2 texels per side.
// Texel index i in [0, T) has its centre at grid coordinate s_i = (i - 0.5) * 2/N - 1.
// i = 0 and i = T-1 are gutter texels that hold the neighbouring face's values, so bilinear
// filtering is seamless across face edges. Row-major: index = face*T*T + y*T + x, x along s, y along t.

export function texSize(N: number): number {
  return N + 2;
}

/** Texel index (0..T-1, gutters included) -> grid coordinate of its centre. */
export function texelToS(i: number, N: number): number {
  return ((i - 0.5) * 2) / N - 1;
}

/** Grid coordinate -> continuous texel index (integer value = texel centre). */
export function sToTexel(s: number, N: number): number {
  return ((s + 1) * 0.5) * N + 0.5;
}

export function texIndex(face: number, x: number, y: number, T: number): number {
  return (face * T + y) * T + x;
}

const _fc: FaceCoord = { face: 0, s: 0, t: 0 };

/** Bilinear sample of a single-channel face array (Float32Array or Uint8Array, 6*T*T) at a direction. */
export function sampleDir(data: ArrayLike<number>, N: number, x: number, y: number, z: number): number {
  const T = N + 2;
  dirToFace(x, y, z, _fc);
  const px = sToTexel(_fc.s, N);
  const py = sToTexel(_fc.t, N);
  let x0 = Math.floor(px);
  let y0 = Math.floor(py);
  const fx = px - x0;
  const fy = py - y0;
  if (x0 < 0) x0 = 0; else if (x0 > T - 2) x0 = T - 2;
  if (y0 < 0) y0 = 0; else if (y0 > T - 2) y0 = T - 2;
  const base = (_fc.face * T + y0) * T + x0;
  const a = data[base], b = data[base + 1], c = data[base + T], d = data[base + T + 1];
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
}

/**
 * Repack a face array (6 faces of (N + 2)^2 texels, `channels` interleaved) into one with a `G`-texel gutter
 * on every side: the interior is copied, each gutter texel takes a bilinear sample of the owning face's
 * interior at its own direction (corners land on a third face). A wide gutter keeps the mip chain of the GPU
 * copies seamless: level k still has G / 2^k texels of neighbour data beyond the interior, where a 1-texel
 * gutter is averaged into the interior at level 1 and the edge clamps from then on. G = 8 gives a texture
 * of N + 16 texels, which halves evenly down to a half-texel gutter at level 4.
 */
export function padFaces<A extends Float32Array | Uint8Array | Uint16Array>(data: A, N: number, channels: number, G: number): A {
  const T = N + 2, P = N + 2 * G;
  const out = new (data.constructor as new (n: number) => A)(6 * P * P * channels);
  const dir: Vec3 = [0, 0, 0];
  const fc: FaceCoord = { face: 0, s: 0, t: 0 };
  const round = data instanceof Float32Array ? (v: number) => v : (v: number) => Math.round(v);
  for (let f = 0; f < 6; f++) {
    for (let y = 0; y < P; y++) {
      const sy = y - G + 1;   // source row in the N + 2 layout
      for (let x = 0; x < P; x++) {
        const sx = x - G + 1;
        const o = ((f * P + y) * P + x) * channels;
        if (sx >= 1 && sx <= N && sy >= 1 && sy <= N) {
          const i = ((f * T + sy) * T + sx) * channels;
          for (let c = 0; c < channels; c++) out[o + c] = data[i + c];
          continue;
        }
        // Gutter: this texel's centre on the owning face, sampled from that face's interior.
        faceToDir(f, ((sx - 0.5) * 2) / N - 1, ((sy - 0.5) * 2) / N - 1, dir);
        dirToFace(dir[0], dir[1], dir[2], fc);
        const px = Math.min(Math.max(sToTexel(fc.s, N), 1), N);
        const py = Math.min(Math.max(sToTexel(fc.t, N), 1), N);
        const x0 = Math.min(Math.floor(px), N - 1);
        const y0 = Math.min(Math.floor(py), N - 1);
        const fx = px - x0;
        const fy = py - y0;
        const i00 = ((fc.face * T + y0) * T + x0) * channels;
        const i10 = i00 + channels, i01 = i00 + T * channels, i11 = i01 + channels;
        for (let c = 0; c < channels; c++) {
          const top = data[i00 + c] + (data[i10 + c] - data[i00 + c]) * fx;
          const bot = data[i01 + c] + (data[i11 + c] - data[i01 + c]) * fx;
          out[o + c] = round(top + (bot - top) * fy);
        }
      }
    }
  }
  return out;
}

/**
 * Refill the gutter texels of a single-channel face array from the neighbouring faces' interiors.
 * Call after any pass that modifies interior texels (e.g. erosion).
 */
export function refillGutters(data: Float32Array | Uint8Array, N: number, channels = 1, channel = 0): void {
  const T = N + 2;
  const dir: Vec3 = [0, 0, 0];
  const fc: FaceCoord = { face: 0, s: 0, t: 0 };
  for (let f = 0; f < 6; f++) {
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        if (x !== 0 && y !== 0 && x !== T - 1 && y !== T - 1) continue;
        faceToDir(f, texelToS(x, N), texelToS(y, N), dir);
        dirToFace(dir[0], dir[1], dir[2], fc);
        // Bilinear sample clamped to the owning face's interior (texels 1..N).
        const px = Math.min(Math.max(sToTexel(fc.s, N), 1), N);
        const py = Math.min(Math.max(sToTexel(fc.t, N), 1), N);
        const x0 = Math.min(Math.floor(px), N - 1);
        const y0 = Math.min(Math.floor(py), N - 1);
        const fx = px - x0;
        const fy = py - y0;
        const i00 = ((fc.face * T + y0) * T + x0) * channels + channel;
        const i10 = i00 + channels;
        const i01 = i00 + T * channels;
        const i11 = i01 + channels;
        const top = data[i00] + (data[i10] - data[i00]) * fx;
        const bot = data[i01] + (data[i11] - data[i01]) * fx;
        const v = top + (bot - top) * fy;
        data[((f * T + y) * T + x) * channels + channel] = data instanceof Uint8Array ? Math.round(v) : v;
      }
    }
  }
}
