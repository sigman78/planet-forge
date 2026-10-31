// Terrain stage (per cube face, gutters included): replays the formation history of the WorldPlan onto the face.
//   crust (dichotomy, low-degree thickness) -> giant basins -> old craters -> rises -> volcanoes
//   -> rifts / graben / fissures -> scarps -> ice tectonics (lineae, grooves) -> chaos / cantaloupe -> polar domes.
// Young craters go into a separate delta (added after the flood basalts in the cube stage).
// Heights are metres relative to the undisturbed mean radius (the datum is fixed later). The non-spherical figure
// (world.ts figureAt) goes into its own layer, added in the cube stage after the flood basalts and the feature limit.

import { faceToDir, texelToS, unwarp, FACE_BASIS } from '../core/cube.ts';
import type { Vec3 } from '../core/cube.ts';
import { Noise3, Rng, smoothstep } from './noise.ts';
import { CRATER_STRIDE, figureAt } from './world.ts';
import type { WorldPlan } from './world.ts';

/** Volcano kind per texel (FaceTerrain.vkind). */
export const VK = { NONE: 0, EDIFICE: 1, CALDERA: 2, CRYO: 3, BLOCK: 4 } as const;

/** Tectonic codes stored in featA.B. */
export const TECT = { GROOVES: 40, LINEAE: 60, FOSSAE: 100, FISSURE: 160, CANYON: 255 } as const;

/**
 * Per-face terrain output. Feature masks (0..255) drive geologic units and splat weights later:
 *   featA: R ejecta, G volcanic edifice cover, B tectonic code (TECT), A basin floor (255) / palimpsest (120)
 *   featB: R basin rim & rings, G chaos (255) / cantaloupe (100), B lava or cryolava flows, A rays (≤240) / facula (255)
 */
export interface FaceTerrain {
  height: Float32Array;
  young: Float32Array;
  /** Non-spherical figure (m), added after the flood basalts and the feature limit. */
  figure: Float32Array;
  featA: Uint8Array;
  featB: Uint8Array;
  vkind: Uint8Array;
}

export interface TerrainContext {
  plan: WorldPlan;
  N: number;
  noise: Noise3;
  /** Noise for the figure lumps (separate stream so the figure is independent of the crust). */
  figNoise: Noise3;
  octRough: number;
  /** Scarp tangent frames (e1, e2 per scarp, 6 floats). */
  scarpFrames: Float64Array;
  /** Ice lineae: great-circle arcs, LIN_STRIDE floats each (normal, start axis, length, half-width, amp, band). */
  lineae: Float64Array;
}

const LIN_STRIDE = 10;

/**
 * Europa-style lineae: long, gently wandering great-circle arcs (double ridges with a central groove), plus a few
 * wide dark bands. Younger arcs (later in the list) are stronger and cross the older ones. Pure function of the plan.
 */
function planLineae(plan: WorldPlan): Float64Array {
  if (!plan.icy || plan.s.lineae <= 0.05 || plan.grooves.length > 0) return new Float64Array(0);
  const rng = new Rng(plan.p.seed, 77);
  const R = plan.bulk.radiusKm;
  const count = Math.round(26 + 44 * plan.s.lineae);
  const out = new Float64Array(count * LIN_STRIDE);
  for (let k = 0; k < count; k++) {
    // Random pole; reference axis in the great-circle plane.
    const z = rng.range(-1, 1), ph = rng.range(0, Math.PI * 2), rr = Math.sqrt(1 - z * z);
    const nx = rr * Math.cos(ph), ny = z, nz = rr * Math.sin(ph);
    let sx = -nz, sy = 0, sz = nx;
    if (Math.hypot(sx, sz) < 1e-3) { sx = 1; sy = 0; sz = 0; }
    const l = 1 / Math.hypot(sx, sy, sz);
    sx *= l; sy *= l; sz *= l;
    const band = rng.next() < 0.12 ? 1 : 0;
    const len = band ? rng.range(0.4, 1.2) : rng.range(0.6, 2.8);
    const a0 = rng.range(-Math.PI, Math.PI);
    const widthKm = band ? rng.range(10, 24) : rng.range(2.5, 7) * plan.p.drama;
    const age = k / Math.max(1, count - 1); // 0 oldest .. 1 youngest
    out.set([nx, ny, nz, sx, sy, sz, len + a0 * 0, widthKm / R, (0.45 + 0.55 * age) * (band ? -0.35 : 1), band], k * LIN_STRIDE);
    out[k * LIN_STRIDE + 6] = len;
    // Rotate the start axis by a0 inside the plane so arcs start anywhere.
    const tx = ny * sz - nz * sy, ty = nz * sx - nx * sz, tz = nx * sy - ny * sx;
    const c = Math.cos(a0), si = Math.sin(a0);
    out[k * LIN_STRIDE + 3] = sx * c + tx * si; out[k * LIN_STRIDE + 4] = sy * c + ty * si; out[k * LIN_STRIDE + 5] = sz * c + tz * si;
  }
  return out;
}

function octavesFor(F: number, N: number, max: number): number {
  const texelsPerRadian = N / (Math.PI / 2);
  const o = Math.floor(Math.log2(texelsPerRadian / (2.5 * F))) + 1;
  return Math.max(1, Math.min(max, o));
}

export function prepareTerrain(plan: WorldPlan): TerrainContext {
  const N = plan.p.resolution;
  const fr = new Float64Array(plan.scarpList.length * 6);
  plan.scarpList.forEach((s, i) => {
    const ref = Math.abs(s.cy) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let ex = ref[1] * s.cz - ref[2] * s.cy, ey = ref[2] * s.cx - ref[0] * s.cz, ez = ref[0] * s.cy - ref[1] * s.cx;
    const l = 1 / Math.hypot(ex, ey, ez);
    ex *= l; ey *= l; ez *= l;
    fr.set([ex, ey, ez, s.cy * ez - s.cz * ey, s.cz * ex - s.cx * ez, s.cx * ey - s.cy * ex], i * 6);
  });
  return { plan, N, noise: new Noise3(plan.p.seed), figNoise: new Noise3(plan.p.seed ^ 0xf16e), octRough: octavesFor(8, N, 6), scarpFrames: fr, lineae: planLineae(plan) };
}

const clampB = (v: number) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));

/** Generate one face (T×T texels including gutters). */
export function generateTerrainFace(ctx: TerrainContext, face: number): FaceTerrain {
  const { plan, N, noise: n } = ctx;
  const T = N + 2;
  const TT = T * T;
  const low = new Float32Array(TT);
  const det = new Float32Array(TT);
  const young = new Float32Array(TT);
  const figure = new Float32Array(TT);
  const featA = new Uint8Array(TT * 4);
  const featB = new Uint8Array(TT * 4);
  const vkind = new Uint8Array(TT);
  const dirs = new Float32Array(TT * 3);
  const d: Vec3 = [0, 0, 0];

  const ax = plan.dichoAxis;
  const icy = plan.icy;
  // Domain warp of the crust grows with drama: twisted, sheared ridge belts on wild worlds.
  const wk = 0.5 + 0.5 * Math.min(2, plan.drama);
  for (let y = 0; y < T; y++) {
    const t = texelToS(y, N);
    for (let x = 0; x < T; x++) {
      faceToDir(face, texelToS(x, N), t, d);
      const i = y * T + x;
      const px = d[0], py = d[1], pz = d[2];
      dirs[i * 3] = px; dirs[i * 3 + 1] = py; dirs[i * 3 + 2] = pz;
      figure[i] = figureAt(plan.figure, ctx.figNoise, px, py, pz);

      // --- primordial crust ---
      const w = n.warp3(px * 1.3, py * 1.3, pz * 1.3, 2);
      const dd = px * ax[0] + py * ax[1] + pz * ax[2] + 0.35 * wk * w[0];
      let h = plan.dichoAmp * 0.8 * Math.tanh(2.6 * dd);
      h += plan.crustAmp * n.fbm(px * 1.4 + 0.3 * wk * w[1] + 5.1, py * 1.4 + 0.3 * wk * w[2], pz * 1.4 - 2.2 + 0.3 * wk * w[0], 4);

      // --- giant basins (multi-ring) ---
      let floorA = 0, rimB = 0;
      for (const b of plan.basins) {
        const dot = px * b.x + py * b.y + pz * b.z;
        const ang = Math.acos(Math.min(1, Math.max(-1, dot)));
        if (ang > b.r * 2.6 * (1 + b.ecc + b.irr)) continue;
        // Azimuth around the centre, measured from the major axis.
        const bx = b.y * b.az - b.z * b.ay, by = b.z * b.ax - b.x * b.az, bz = b.x * b.ay - b.y * b.ax;
        const phi = Math.atan2(px * bx + py * by + pz * bz, px * b.ax + py * b.ay + pz * b.az);
        const cs = Math.cos(phi), sn = Math.sin(phi);
        const c2 = cs * cs - sn * sn; // cos 2phi: +1 along the major axis
        // Elongated (oblique) and scalloped outline: the effective radius depends on the azimuth.
        const reff = b.r * (1 + b.ecc * c2) * (1 + b.irr * n.simplex(cs * 1.7 + b.key, sn * 1.7, b.key * 0.37));
        const xr = ang / reff;
        if (xr > 2.6) continue;
        // Old basins: lower rims, softer walls, infilled floors, faint rings.
        const age = b.age;
        const rimH = b.depth * 0.22 * (1 - 0.6 * age);
        const depth = b.depth * (1 - 0.35 * age);
        let bh: number;
        if (xr < 1) {
          const bowl = b.floor === 3
            ? 1 - Math.pow(xr, 1.6 + 0.6 * age)
            : 1 - Math.pow(smoothstep(0.45 - 0.3 * age, 1.0, xr), 1.2 - 0.4 * age);
          bh = -depth * bowl + rimH * smoothstep(0.8 - 0.25 * age, 1.0, xr);
          if (b.floor === 2) bh += depth * 0.18 * smoothstep(0.75, 0.0, xr); // infill dome of lava / ejecta fallback
          const nk = 0.85 + 0.15 * n.simplex(px * 40, py * 40, pz * 40);
          if (b.floor === 0 && b.peak > 0) bh += b.peak * (1 - 0.5 * age) * Math.exp(-(xr * xr) / 0.012) * nk;
          else if (b.floor === 1 && b.peak > 0) {
            // Peak ring: a broken ring of massifs at about half the rim radius.
            const seg = smoothstep(-0.4, 0.2, n.simplex(cs * 2.5 + b.key, sn * 2.5, 7.7));
            bh += b.peak * 0.55 * (1 - 0.5 * age) * Math.exp(-(((xr - 0.48) / 0.07) ** 2)) * nk * (0.35 + 0.65 * seg);
          }
          floorA = Math.max(floorA, smoothstep(0.92, 0.7, xr));
        } else {
          const tail = Math.pow(2.6, -3);
          // Ejecta apron; oblique impacts throw it along the major axis (butterfly) and starve the cross-range.
          bh = ((rimH * (Math.pow(xr, -3) - tail)) / (1 - tail)) * (1 + 1.5 * b.ecc * c2);
          for (let k = 1; k <= b.rings; k++) {
            const rr = 1 + b.ringStep * k * (1 + 0.08 * n.simplex(k * 3.3, b.key, 1.1));
            if (rr > 2.5) break;
            const ringW = b.ringW * (1 + 0.25 * k);
            const ring = Math.exp(-(((xr - rr) / ringW) ** 2));
            // Rings survive as arcs, not full circles.
            const seg = smoothstep(-0.45, 0.25, n.simplex(cs * 2.2 + k * 3.1 + b.key, sn * 2.2, k * 1.9));
            const amp = rimH * (0.75 / k) * (1 - 0.5 * age) * seg;
            bh += amp * ring - amp * 0.3 * Math.exp(-(((xr - rr + ringW * 2.5) / (ringW * 1.3)) ** 2));
            rimB = Math.max(rimB, ring * 0.9 * seg);
          }
        }
        rimB = Math.max(rimB, Math.exp(-(((xr - 1) / 0.07) ** 2)) * (1 - 0.5 * age));
        h += bh;
      }

      // --- volcanic rises ---
      for (const r of plan.rises) {
        const dot = px * r.x + py * r.y + pz * r.z;
        if (dot < 0) continue;
        const ang = Math.acos(Math.min(1, dot)) / r.r;
        h += r.h * Math.exp(-ang * ang * 2.2) * (1 + 0.12 * n.fbm(px * 6, py * 6, pz * 6, 2));
      }

      // --- polar layered domes with spiral troughs ---
      const lat = Math.asin(py);
      const capLat = py >= 0 ? plan.capLat[0] : plan.capLat[1];
      if (plan.capDome > 0 && Math.abs(lat) > capLat - 0.05) {
        const k = smoothstep(capLat - 0.05, capLat + 0.12, Math.abs(lat));
        const lon = Math.atan2(pz, px);
        const sp = Math.sin(lon * 3 * Math.sign(py || 1) + (Math.PI / 2 - Math.abs(lat)) * 70 + 2 * n.simplex(px * 5, py * 5, pz * 5));
        h += plan.capDome * k * (1 - 0.18 * smoothstep(0.6, 0.95, sp) * k);
      }

      low[i] = h;
      // --- small-scale roughness of the old crust (buried by later lava) ---
      const rough = (icy ? 0.12 : 0.22) * plan.crustAmp;
      det[i] = rough * n.fbm(px * 8 + 1.9, py * 8 - 7.3, pz * 8 + 3.7, ctx.octRough, 2.1, 0.55) * (1 - 0.7 * floorA);
      featA[i * 4 + 3] = clampB(floorA);
      featB[i * 4] = clampB(rimB);
    }
  }

  // --- old craters on the detail layer, young craters on their own layer ---
  rasterCraters(ctx, face, plan.oldCraters, det, dirs, featA, featB, false);
  rasterCraters(ctx, face, plan.youngCraters, young, dirs, featA, featB, true);

  // --- volcanoes (bury the detail under their footprint) ---
  rasterVolcanoes(ctx, face, low, det, dirs, featA, featB, vkind);

  // --- combine, then tectonics and ice-shell features per texel ---
  const height = new Float32Array(TT);
  const hasRifts = plan.rifts.length > 0;
  // Linear features never get narrower than a few texels (sub-texel lines alias into dotted dashes).
  const tex = Math.PI / 2 / N;
  // Wall width as a fraction of the half-width, by rift kind (canyon, graben).
  const WALL_FRAC = [0.45, 0.4];
  for (let i = 0; i < TT; i++) {
    const px = dirs[i * 3], py = dirs[i * 3 + 1], pz = dirs[i * 3 + 2];
    let h = low[i] + det[i];
    let tect = featA[i * 4 + 2];
    // Rifts and scarps postdate the flood basalts: they cut the maria, so they go into the post-flood layer.
    let late = 0;

    if (hasRifts) {
      // Fine 3D wiggle shared by every trough (texel-scale ruggedness)...
      const wx = px + 0.012 * n.simplex(px * 9 + 4.4, py * 9, pz * 9);
      const wy = py + 0.012 * n.simplex(px * 9, py * 9 + 8.8, pz * 9);
      const wz = pz + 0.012 * n.simplex(px * 9, py * 9, pz * 9 - 6.6);
      for (let k = 0; k < plan.rifts.length; k++) {
        const r = plan.rifts[k];
        const dp0 = wx * r.nx + wy * r.ny + wz * r.nz;
        const minW = (r.kind === 2 ? 2.6 : 1.6) * tex;
        const rw = Math.max(r.w, minW);
        // ...plus a per-trough wander of the axis along the arc, so no two run parallel and none is a ruler line:
        // a few widths for graben, about one width for canyons and fissures (which are wide already).
        const wander = r.kind === 1 ? Math.max(rw * 3, 0.012) : rw * 0.9;
        if (Math.abs(dp0) > rw * 2.5 + wander * 1.6) continue;
        // Along-arc position.
        const tx = r.ny * r.sz - r.nz * r.sy, ty = r.nz * r.sx - r.nx * r.sz, tz = r.nx * r.sy - r.ny * r.sx;
        const along = Math.atan2(wx * tx + wy * ty + wz * tz, wx * r.sx + wy * r.sy + wz * r.sz);
        if (along < -rw * 2 || along > r.len + rw * 2) continue;
        const kk = k * 0.731;
        const dp = dp0 - wander * (n.simplex(along * 5.5 + kk * 9.1, kk, 0.3) + 0.45 * n.simplex(along * 14 + kk * 3.7, 1.9 - kk, 0.7));
        if (Math.abs(dp) > rw * 2.5) continue;
        // Ends pinch out over a quarter of the length instead of stopping blunt; graben are segmented (en echelon
        // strands with gaps), canyons and fissures only breathe in depth along their length.
        const taper = smoothstep(-rw, r.len * 0.25, along) * smoothstep(r.len + rw, r.len * 0.75, along);
        if (taper <= 0) continue;
        const segN = 0.5 + 0.5 * n.simplex(along * (r.kind === 1 ? 11 : 6) + kk * 5.3, 2.3 + kk, 1.1);
        const seg = r.kind === 1 ? smoothstep(0.18, 0.55, segN) : 0.6 + 0.4 * segN;
        const str = taper * seg;
        if (str <= 0.001) continue;
        const wv = Math.max(minW, rw * (0.6 + 0.8 * (0.5 + 0.5 * n.simplex(along * 7 + k * 3.1, k * 1.7, 0.5))) * (0.45 + 0.55 * Math.sqrt(str)));
        const u = Math.abs(dp) / wv;
        // Walls are never steeper than ~1.6 texels across: a sub-texel wall aliases into a staircase rim, a
        // jagged shadow edge and per-texel rock spots along the trough. Narrow troughs become V-shaped instead.
        const wallU = Math.max(WALL_FRAC[r.kind] ?? 0.4, (1.6 * tex) / wv);
        if (r.kind === 0) {
          // Canyon: steep layered walls, flat floor, slightly raised shoulders.
          let wall = 1 - smoothstep(1 - wallU, 1.0, u);
          const nl = Math.max(1, Math.min(5, Math.floor((wallU * wv) / (2 * tex))));
          const lay = wall * nl;
          wall = (Math.floor(lay) + smoothstep(0.2, 0.8, lay - Math.floor(lay))) / nl;
          late -= r.depth * str * wall;
          late += r.depth * 0.04 * str * Math.exp(-(((u - 1.3) / 0.3) ** 2));
          if (u < 1.1 * str + 0.05 && str > 0.2) tect = TECT.CANYON;
        } else if (r.kind === 1) {
          // Half-graben: one wall steeper than the other, the side alternating per strand.
          const side = Math.sign(dp) * (n.simplex(along * 3 + kk * 2.9, kk * 0.5, 2.2) > 0 ? 1 : -1);
          const wu = side > 0 ? Math.min(0.85, wallU * 1.8) : wallU;
          late -= r.depth * str * (1 - smoothstep(1 - wu, 1.0, u));
          if (u < 1 && str > 0.35 && tect < TECT.FOSSAE) tect = TECT.FOSSAE;
        } else {
          // Fissure with flanking ridges.
          late += r.depth * str * (0.55 * Math.exp(-(((u - 1.2) / 0.45) ** 2)) - Math.exp(-((u / 0.45) ** 2)));
          if (u < 2 && str > 0.2) tect = Math.max(tect, TECT.FISSURE);
        }
      }
    }

    // Lobate scarps.
    for (let k = 0; k < plan.scarpList.length; k++) {
      const s = plan.scarpList[k];
      const dot = px * s.cx + py * s.cy + pz * s.cz;
      const ang = Math.acos(Math.min(1, Math.max(-1, dot)));
      const sw = Math.max(s.w, 1.6 * tex), sback = Math.max(s.back, 3 * tex);
      if (Math.abs(ang - s.rho) > sback * 4 + sw * 3) continue;
      const f = ctx.scarpFrames;
      let az = Math.atan2(px * f[k * 6 + 3] + py * f[k * 6 + 4] + pz * f[k * 6 + 5], px * f[k * 6] + py * f[k * 6 + 1] + pz * f[k * 6 + 2]) - s.a0;
      az = ((az % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      if (az > s.a1) continue;
      const taper = smoothstep(0, 0.15, az) * smoothstep(s.a1, s.a1 - 0.15, az);
      const rho = s.rho + 0.012 * n.simplex(az * 6 + k, k * 2.3, 1.1);
      const sd = (ang - rho) * s.face;
      const prof = sd < 0 ? smoothstep(-sw, 0, sd) : Math.exp(-sd / sback);
      late += s.h * taper * prof;
      if (sd > -sw * 1.2 && sd < sw * 0.8 && taper > 0.3 && tect < TECT.FOSSAE) tect = TECT.FOSSAE;
    }

    // Ice tectonics: double-ridged lineae (great-circle arcs that wander a little) and dark bands on young shells.
    const L = ctx.lineae;
    if (L.length > 0) {
      const amp = 260 * plan.relief * plan.gRel * plan.s.lineae;
      const wob = 0.006 * n.simplex(px * 5 + 1.7, py * 5 - 3.1, pz * 5 + 0.4);
      let lin = 0, bandM = 0;
      for (let o = 0; o < L.length; o += LIN_STRIDE) {
        const w = Math.max(L[o + 7], (L[o + 9] ? 2 : 1.6) * tex);
        const dp = px * L[o] + py * L[o + 1] + pz * L[o + 2] + wob * (1 + (o % 3));
        if (Math.abs(dp) > 2.2 * w) continue;
        const ux = L[o + 3], uy = L[o + 4], uz = L[o + 5];
        const vx = L[o + 1] * uz - L[o + 2] * uy, vy = L[o + 2] * ux - L[o] * uz, vz = L[o] * uy - L[o + 1] * ux;
        let along = Math.atan2(px * vx + py * vy + pz * vz, px * ux + py * uy + pz * uz);
        if (along < 0) along += Math.PI * 2;
        const len = L[o + 6];
        if (along > len) continue;
        const taper = smoothstep(0, 0.12, along) * smoothstep(len, len - 0.12, along);
        const a = L[o + 8];
        const u = Math.abs(dp) / w;
        if (L[o + 9]) {
          // Dark band: flat, slightly lowered, sharp-edged strip.
          const m = smoothstep(1.0, 0.75, u) * taper;
          lin += a * m;
          bandM = Math.max(bandM, m);
        } else {
          // Double ridge with a central groove (groove only where resolvable).
          const groove = smoothstep(0.9 * tex, 1.8 * tex, 0.3 * w);
          const prof = Math.exp(-(((u - 0.5) / 0.32) ** 2)) - groove * 0.8 * Math.exp(-((u / 0.22) ** 2));
          lin += a * taper * prof;
          if (u < 0.9 && taper > 0.3) bandM = Math.max(bandM, 0.6);
        }
      }
      h += amp * lin;
      if (bandM > 0.5 && tect < TECT.LINEAE) tect = TECT.LINEAE;
    }
    // Grooved bands on old ice.
    for (const g of plan.grooves) {
      const dp = px * g.nx + py * g.ny + pz * g.nz;
      const edge = g.w * (1 + 0.35 * n.simplex(px * 4 + g.freq, py * 4, pz * 4));
      if (Math.abs(dp) > edge) continue;
      const band = smoothstep(edge, edge * 0.8, Math.abs(dp));
      const gr = Math.sin(dp * g.freq * 6 + 2 * n.simplex(px * 12, py * 12, pz * 12));
      h = h * (1 - 0.6 * band) + band * (g.amp * gr * gr + g.amp * 0.6);
      if (band > 0.5 && tect < TECT.GROOVES + 1) tect = TECT.GROOVES;
    }

    // Chaos terrain: the ground breaks into tilted blocks in a lowered matrix.
    let chaos = featB[i * 4 + 1] / 255;
    for (const c of plan.chaosList) {
      const dot = px * c.x + py * c.y + pz * c.z;
      if (dot < Math.cos(c.r * 1.4)) continue;
      const ang = Math.acos(Math.min(1, dot));
      const m = smoothstep(c.r, c.r * 0.7, ang + c.r * 0.25 * n.fbm(px * 10, py * 10, pz * 10, 2));
      if (m <= 0) continue;
      const bl = n.simplex(px * 55 + 3.3, py * 55, pz * 55);
      const block = Math.floor(bl * 3) / 3 + 0.3 * n.ridged(px * 120, py * 120, pz * 120, 2, 2);
      h = h * (1 - 0.4 * m) + m * (c.amp * (block - 0.4));
      chaos = Math.max(chaos, m);
    }
    let cantaloupe = 0;
    if (plan.cantaloupe) {
      const c = plan.cantaloupe;
      const dot = px * c.x + py * c.y + pz * c.z;
      if (dot > Math.cos(c.r * 1.2)) {
        const m = smoothstep(c.r, c.r * 0.75, Math.acos(Math.min(1, dot)) + 0.15 * n.fbm(px * 5, py * 5, pz * 5, 2));
        const cell = Math.abs(n.simplex(px * 70, py * 70, pz * 70)) + 0.5 * Math.abs(n.simplex(px * 140 + 9, py * 140, pz * 140));
        h += m * 450 * plan.relief * plan.gRel * (smoothstep(0.0, 0.35, cell) - 0.6);
        cantaloupe = m;
      }
    }
    // Palimpsests: relaxed flat bright disks with faint rings.
    let pal = 0;
    for (const pp of plan.palimpsests) {
      const dot = px * pp.x + py * pp.y + pz * pp.z;
      if (dot < Math.cos(pp.r * 1.3)) continue;
      const xr = Math.acos(Math.min(1, dot)) / pp.r;
      const m = smoothstep(1.15, 0.9, xr);
      h = h * (1 - 0.75 * m) + m * (40 * Math.sin(xr * 18) * plan.relief);
      pal = Math.max(pal, m);
    }

    height[i] = h;
    young[i] += late;
    featA[i * 4 + 2] = tect;
    if (chaos > 0.5) featB[i * 4 + 1] = clampB(chaos);
    else if (cantaloupe > 0.5) featB[i * 4 + 1] = 100;
    if (pal > 0.5 && featA[i * 4 + 3] < 128) featA[i * 4 + 3] = 120;
  }
  return { height, young, figure, featA, featB, vkind };
}

// ---- rasterised features ------------------------------------------------------------------------

interface Box { x0: number; x1: number; y0: number; y1: number }
const _box: Box = { x0: 0, x1: 0, y0: 0, y1: 0 };

/** Texel bounding box on `face` of the spherical cap (centre c, angular radius A). Returns false if it misses. */
export function capBox(face: number, N: number, cx: number, cy: number, cz: number, A: number, box: Box): boolean {
  const T = N + 2;
  const b = FACE_BASIS[face];
  const nn = b.n, u = b.u, v = b.v;
  const cn = cx * nn[0] + cy * nn[1] + cz * nn[2];
  if (Math.acos(Math.max(-1, Math.min(1, cn))) > A + 0.99) return false;
  let ex: number, ey: number, ez: number;
  if (Math.abs(cx) < 0.9) { ex = 0; ey = -cz; ez = cy; } else { ex = cz; ey = 0; ez = -cx; }
  const l = 1 / Math.hypot(ex, ey, ez);
  ex *= l; ey *= l; ez *= l;
  const fx = cy * ez - cz * ey, fy = cz * ex - cx * ez, fz = cx * ey - cy * ex;
  const ca = Math.cos(A), sa = Math.sin(A);
  let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
  const STEPS = 32;
  for (let i = -1; i < STEPS; i++) {
    let px: number, py: number, pz: number;
    if (i < 0) { px = cx; py = cy; pz = cz; }
    else {
      const a = (i / STEPS) * Math.PI * 2;
      const co = Math.cos(a) * sa, si = Math.sin(a) * sa;
      px = ca * cx + co * ex + si * fx; py = ca * cy + co * ey + si * fy; pz = ca * cz + co * ez + si * fz;
    }
    const dn = px * nn[0] + py * nn[1] + pz * nn[2];
    if (dn <= 0.08) { s0 = -2; s1 = 2; t0 = -2; t1 = 2; break; }
    const su = unwarp((px * u[0] + py * u[1] + pz * u[2]) / dn);
    const sv = unwarp((px * v[0] + py * v[1] + pz * v[2]) / dn);
    if (su < s0) s0 = su;
    if (su > s1) s1 = su;
    if (sv < t0) t0 = sv;
    if (sv > t1) t1 = sv;
  }
  // Angular padding (bbox from 32 samples of a convex conic can undershoot slightly).
  const pad = 2;
  box.x0 = Math.max(0, Math.floor(((s0 + 1) * 0.5) * N + 0.5) - pad);
  box.x1 = Math.min(T - 1, Math.ceil(((s1 + 1) * 0.5) * N + 0.5) + pad);
  box.y0 = Math.max(0, Math.floor(((t0 + 1) * 0.5) * N + 0.5) - pad);
  box.y1 = Math.min(T - 1, Math.ceil(((t1 + 1) * 0.5) * N + 0.5) + pad);
  return box.x0 <= box.x1 && box.y0 <= box.y1;
}

const EJECTA = 2.4;

/** Crater profile at normalised distance x = angle / R. Height in units of depth. */
export function craterProfile(x: number, rim: number, peak: number, floorFrac: number): number {
  if (x < 1) {
    let h = -1 + (1 + rim) * x * x * (0.6 + 0.4 * x);
    if (h < -floorFrac) h = -floorFrac + (h + floorFrac) * 0.15;
    if (peak > 0) h += peak * Math.exp(-(x * x) / 0.018);
    return h;
  }
  const tail = Math.pow(EJECTA, -3);
  return (rim * (Math.pow(x, -3) - tail)) / (1 - tail);
}

/**
 * Degraded crater profile: the rim crest is rounded over a band that widens with wear (the crisp profile has a
 * kink at x = 1) and sinks below the fresh crest. `deg` 0 is craterProfile.
 */
export function craterProfileWorn(x: number, rim: number, peak: number, floorFrac: number, deg: number): number {
  if (deg <= 0.02) return craterProfile(x, rim, peak, floorFrac);
  const w = 0.08 + 0.45 * deg;
  if (x < 1 - w || x > 1 + w) return craterProfile(x, rim, peak, floorFrac);
  // Inside and outside branches both capped at the rim height, blended across the crest, then the plateau
  // the two caps make is pulled down into a rounded crest.
  const inner = Math.min(rim, craterProfile(Math.min(x, 1), rim, peak, floorFrac));
  const outer = Math.min(rim, craterProfile(Math.max(x, 1), rim, 0, floorFrac));
  const t = (x - (1 - w)) / (2 * w);
  const s = t * t * (3 - 2 * t);
  return inner + (outer - inner) * s - rim * 0.35 * deg * Math.sin(Math.PI * t);
}

function rasterCraters(ctx: TerrainContext, face: number, C: Float64Array, out: Float32Array, dirs: Float32Array,
  featA: Uint8Array, featB: Uint8Array, fresh: boolean): void {
  const N = ctx.N, T = N + 2;
  const n = ctx.noise;
  const count = C.length / CRATER_STRIDE;
  const Rkm = ctx.plan.bulk.radiusKm;
  for (let c = 0; c < count; c++) {
    const o = c * CRATER_STRIDE;
    const cx = C[o], cy = C[o + 1], cz = C[o + 2], R = C[o + 3], D0 = C[o + 4];
    const rim0 = C[o + 5], peak0 = C[o + 6], flag = C[o + 7], deg = C[o + 8];
    // Wear: the bowl fills, the rim erodes faster than the bowl fills, the peak is buried, the floor flattens,
    // the ejecta blanket fades, the rim outline gets more ragged.
    const D = D0 * (1 - 0.55 * deg);
    const rim = rim0 * (1 - 0.8 * deg);
    const peak = peak0 * (1 - 0.8 * deg);
    const reach = flag === 1 ? 9 : flag === 3 ? 3.2 : EJECTA;
    const A = R * reach;
    if (!capBox(face, N, cx, cy, cz, A, _box)) continue;
    const cosA = Math.cos(A);
    const floorFrac = (R * Rkm > 25 ? 0.7 : 1.5) * (1 - 0.45 * deg);
    const ejK = (flag === 4 ? 0.25 : 1) * Math.pow(1 - deg, 1.5);
    const irrAmp = 0.07 + 0.05 * deg;
    // Tangent frame for ray azimuths.
    let ex = 0, ey = 0, ez = 0, fx = 0, fy = 0, fz = 0;
    if (flag === 1) {
      if (Math.abs(cx) < 0.9) { ex = 0; ey = -cz; ez = cy; } else { ex = cz; ey = 0; ez = -cx; }
      const l = 1 / Math.hypot(ex, ey, ez);
      ex *= l; ey *= l; ez *= l;
      fx = cy * ez - cz * ey; fy = cz * ex - cx * ez; fz = cx * ey - cy * ex;
    }
    const ejW = (fresh ? 1 : 0.45) * ejK;
    for (let y = _box.y0; y <= _box.y1; y++) {
      for (let x = _box.x0; x <= _box.x1; x++) {
        const idx = y * T + x;
        const dx = dirs[idx * 3], dy = dirs[idx * 3 + 1], dz = dirs[idx * 3 + 2];
        const dot = dx * cx + dy * cy + dz * cz;
        if (dot <= cosA) continue;
        const ang = Math.acos(Math.min(1, dot));
        const xn0 = ang / R;
        if (xn0 < EJECTA) {
          const irr = 1 + irrAmp * n.simplex(dx * 7 / R, dy * 7 / R, dz * 7 / R + c);
          const xn = xn0 / irr;
          out[idx] += D * craterProfileWorn(xn, rim, peak, floorFrac, deg);
          if (xn > 0.8 && xn < 2.1 && ejW > 0.02) {
            const e = smoothstep(2.1, 1.0, xn) * ejW;
            const cur = featA[idx * 4];
            const v = Math.round(e * 255);
            if (v > cur) featA[idx * 4] = v;
          }
          if (flag === 2 && xn < 0.55) featB[idx * 4 + 3] = 255;
        }
        if (flag === 3 && xn0 > 0.6) {
          // Dark halo: a ragged dark blanket out to ~3 radii, strongest just outside the rim (values 245-254).
          const rn = n.simplex(dx * 5 / R + c * 0.7, dy * 5 / R, dz * 5 / R);
          const halo = smoothstep(3.1, 1.3, xn0 + 0.5 * rn) * smoothstep(0.6, 1.0, xn0);
          if (halo > 0.08) {
            const v = 245 + Math.min(9, Math.round(halo * 9));
            const cur = featB[idx * 4 + 3];
            if (cur !== 255 && v > cur) featB[idx * 4 + 3] = v;
          }
        }
        if (flag === 1 && xn0 > 0.7) {
          const az = Math.atan2(dx * fx + dy * fy + dz * fz, dx * ex + dy * ey + dz * ez);
          const rn = n.simplex(Math.cos(az) * 9 + c * 1.3, Math.sin(az) * 9, xn0 * 0.08);
          const ray = smoothstep(0.15, 0.6, rn) * Math.pow(Math.max(0, 1 - xn0 / reach), 1.3) + smoothstep(1.8, 1.0, xn0) * 0.8;
          const v = Math.min(240, Math.round(ray * 240));
          if (v > featB[idx * 4 + 3] && featB[idx * 4 + 3] !== 255) featB[idx * 4 + 3] = v;
        }
      }
    }
  }
}

function rasterVolcanoes(ctx: TerrainContext, face: number, low: Float32Array, det: Float32Array, dirs: Float32Array,
  featA: Uint8Array, featB: Uint8Array, vkind: Uint8Array): void {
  const N = ctx.N, T = N + 2;
  const n = ctx.noise;
  const plan = ctx.plan;
  const sulfur = plan.archetype === 'sulfur';
  for (let c = 0; c < plan.volcanoes.length; c++) {
    const v = plan.volcanoes[c];
    const reach = v.style === 'patera' && sulfur ? Math.max(v.flowR, 5) : Math.max(1.05, v.flowR);
    if (!capBox(face, N, v.x, v.y, v.z, v.r * reach, _box)) continue;
    const cosA = Math.cos(v.r * reach);
    // Tangent frame at the vent, for azimuthal flow lobes.
    let ex = 0, ey = -v.z, ez = v.y;
    if (Math.abs(v.x) > 0.9) { ex = v.z; ey = 0; ez = -v.x; }
    const el = 1 / Math.hypot(ex, ey, ez);
    ex *= el; ey *= el; ez *= el;
    const fx = v.y * ez - v.z * ey, fy = v.z * ex - v.x * ez, fz = v.x * ey - v.y * ex;
    // Crater / caldera walls never get steeper than a ~2.5-texel ramp (tall edifices would otherwise leave 1-texel pits).
    const ramp = (2.5 * (Math.PI / 2 / N)) / v.r;
    for (let y = _box.y0; y <= _box.y1; y++) {
      for (let x = _box.x0; x <= _box.x1; x++) {
        const idx = y * T + x;
        const dx = dirs[idx * 3], dy = dirs[idx * 3 + 1], dz = dirs[idx * 3 + 2];
        const dot = dx * v.x + dy * v.y + dz * v.z;
        if (dot <= cosA) continue;
        const ang = Math.acos(Math.min(1, dot));
        const lob = 0.3 * n.fbm(dx * 30 + c, dy * 30, dz * 30 - c, 3);
        const x0 = ang / v.r;
        // Lobate flow distance: the apron reaches out in broad tongues (azimuthal noise), with mildly ragged edges.
        const az = Math.atan2(dx * fx + dy * fy + dz * fz, dx * ex + dy * ey + dz * ez);
        const tongue = 0.5 + 0.5 * n.simplex(Math.cos(az) * 2.4 + c * 7.1, Math.sin(az) * 2.4, c * 0.37);
        const xl = x0 / (0.6 + 0.55 * tongue) + 0.12 * n.fbm(dx * 9 + c, dy * 9, dz * 9 - c, 2) * v.flowR;
        let prof = 0, cover = 0, flow = 0;
        let kind: number = VK.EDIFICE;
        switch (v.style) {
          case 'shield': {
            const xx = x0 * (1 + 0.08 * lob);
            prof = xx < 0.88 ? 1 - Math.pow(xx, 1.5) : 0.174 * smoothstep(0.94, 0.88, xx);
            prof *= 1 - 0.07 * n.ridged(dx * 70 + c, dy * 70, dz * 70, 2, 2) * xx;
            // Nested summit calderas.
            prof -= 0.09 * smoothstep(v.caldera, Math.min(v.caldera * 0.75, v.caldera - ramp), x0);
            prof -= 0.05 * smoothstep(v.caldera * 0.6, v.caldera * 0.4, Math.abs(x0 - v.caldera * 0.5));
            cover = smoothstep(1.0, 0.85, xx);
            flow = smoothstep(v.flowR, v.flowR * 0.75, xl) * (xl > 0.8 ? 1 : 0);
            prof += 0.015 * flow;
            break;
          }
          case 'cone': {
            prof = Math.pow(Math.max(0, 1 - x0), 1.15) - 0.25 * smoothstep(Math.max(0.12, 0.08 + ramp), 0.08, x0);
            cover = smoothstep(1.0, 0.8, x0);
            flow = smoothstep(v.flowR, v.flowR * 0.8, xl) * (xl > 0.7 ? 1 : 0);
            break;
          }
          case 'dome': {
            prof = Math.pow(Math.max(0, 1 - x0 * x0), 1.6);
            cover = smoothstep(1.0, 0.7, x0);
            break;
          }
          case 'cryo': {
            // Steep-sided dome (Ahuna-like, but huge) with a summit pit and broad cryolava lobes.
            const xx = x0 * (1 + 0.1 * lob);
            prof = Math.pow(Math.max(0, 1 - Math.pow(xx, 3)), 1.4) * (1 - 0.15 * xx) - 0.12 * smoothstep(v.caldera, Math.min(v.caldera * 0.6, v.caldera - ramp), x0);
            prof *= 1 - 0.05 * n.ridged(dx * 90, dy * 90 + c, dz * 90, 2, 2) * xx;
            const lobes = smoothstep(v.flowR, v.flowR * 0.7, xl);
            flow = lobes * (xx > 0.85 ? 1 : 0);
            prof += 0.05 * lobes * smoothstep(v.flowR, v.flowR * 0.6, xl);
            cover = smoothstep(1.0, 0.85, xx);
            kind = VK.CRYO;
            break;
          }
          case 'patera': {
            // Caldera depression with a lava-lake floor, low shield, dark lobate flows, plume ring deposits.
            const cal = v.caldera;
            const xx = x0 * (1 + 0.15 * lob);
            // Steep but continuous caldera wall up to the low shield.
            if (xx < cal) prof = -1 + (1.04 + 0.12 * (1 - cal)) * smoothstep(Math.min(cal * 0.85, cal - ramp), cal, xx);
            else if (xx < 1) prof = 0.12 * (1 - xx) + 0.04;
            else prof = 0.04 * smoothstep(1.2, 1.0, xx);
            if (xx < cal * 0.8) kind = VK.CALDERA;
            cover = smoothstep(1.05, 0.9, xx);
            flow = smoothstep(v.flowR, v.flowR * 0.7, xl);
            if (sulfur && x0 > 1.3) {
              const ring = Math.exp(-(((x0 - 3.6) / 0.9) ** 2)) * (0.6 + 0.4 * n.simplex(dx * 20, dy * 20, dz * 20 + c));
              const rv = Math.round(Math.min(1, ring) * 200);
              if (rv > featB[idx * 4 + 3] && featB[idx * 4 + 3] !== 255) featB[idx * 4 + 3] = rv;
            }
            break;
          }
          case 'block': {
            // Tilted mesa with steep thrust scarps: plateau top, tilted along a random azimuth.
            const tilt = Math.cos(v.caldera) * (dx - v.x) + Math.sin(v.caldera) * (dz - v.z);
            const edge = x0 + 0.35 * n.fbm(dx * 18 + c, dy * 18, dz * 18, 3);
            const top = smoothstep(1.0, 0.72, edge);
            prof = top * (0.65 + 0.35 * (tilt / v.r)) + 0.1 * n.ridged(dx * 60, dy * 60, dz * 60 + c, 3, 2) * top;
            cover = top * 0.6;
            kind = VK.BLOCK;
            break;
          }
        }
        low[idx] += v.h * prof;
        if (cover > 0) det[idx] *= 1 - cover;
        const cv = Math.round(Math.min(1, cover) * 255);
        if (cv > featA[idx * 4 + 1]) { featA[idx * 4 + 1] = cv; if (cover > 0.5) vkind[idx] = kind; }
        if (kind === VK.CALDERA && x0 < v.caldera * 0.8) vkind[idx] = VK.CALDERA;
        const fv = Math.round(Math.min(1, flow) * 255);
        if (fv > featB[idx * 4 + 2]) featB[idx * 4 + 2] = fv;
      }
    }
  }
}
