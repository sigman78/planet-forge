import type { LookHints, PlanetBulk, SeaKind } from '../core/types.ts';
import type { LookParams } from '../render/planetView.ts';

/** Environment / lighting / post settings (renderer side, no regeneration needed). */
export interface EnvParams {
  sunAzimuth: number; // degrees
  sunElevation: number; // degrees (relative to planet equator)
  sunIntensity: number;
  sunColor: string;
  dayCycle: number; // degrees per second
  exposure: number;
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  starIntensity: number;
  skyIntensity: number;
  atmoDensity: number;
  atmoHeight: number; // km
  rayleigh: { x: number; y: number; z: number }; // 1e-3 / km
  rayleighH: number;
  mie: number; // 1e-3 / km
  mieH: number;
  mieG: number;
  atmoSteps: number;
  haze: number; // low-lying haze extinction, 1e-3 / km at the surface
  hazeH: number; // km
  hazeColor: string;
  ambient: number;
  /** Planetshine fill from the parent giant, relative to the sun. */
  fill: number;
  fillColor: string;
  fov: number;
  autoRotate: number;
  autoTilt: boolean;
}

export const DEFAULT_ENV: EnvParams = {
  sunAzimuth: 35,
  sunElevation: 12,
  sunIntensity: 6,
  sunColor: '#fff6ea',
  dayCycle: 0,
  exposure: 1.0,
  bloomStrength: 0.35,
  bloomRadius: 0.55,
  bloomThreshold: 1.6,
  starIntensity: 1,
  skyIntensity: 1,
  atmoDensity: 1,
  atmoHeight: 70,
  rayleigh: { x: 5.8, y: 13.5, z: 33.1 },
  rayleighH: 8,
  mie: 4,
  mieH: 1.6,
  mieG: 0.78,
  atmoSteps: 16,
  haze: 4,
  hazeH: 3,
  hazeColor: '#c9b49a',
  ambient: 0.015,
  fill: 0.12,
  fillColor: '#c9b8a0',
  fov: 45,
  autoRotate: 0,
  autoTilt: true,
};

/** Minimum atmosphere so every world keeps at least a faint limb haze. */
export const MIN_ATMO_DENSITY = 0.04;

const SEA_MODE: Record<SeaKind, number> = { water: 0, lava: 1, ice: 2, none: 3 };

/** Copy the generator's render hints into the viewer settings. */
/** Landform detail style per archetype: ridged, billowy, cracked, pitted. */
const LAND_STYLE: Record<string, [number, number, number, number]> = {
  rust: [0.65, 0.15, 0, 0.2], // wind-carved yardangs and gullies
  cinder: [0.25, 0.15, 0.1, 0.5], // scorched, cratered regolith
  'grey moon': [0.15, 0.1, 0, 0.75], // craters on craters
  'ice shell': [0.25, 0.05, 0.7, 0], // fractured plates
  'old ice': [0.1, 0.15, 0.3, 0.45], // relaxed craters, old fractures
  sulfur: [0.1, 0.65, 0.25, 0], // lava lobes and flows
  basalt: [0.3, 0.5, 0.2, 0], // flow fronts, cooling cracks
  cryo: [0.15, 0.35, 0.5, 0], // cryolava domes in cracked ice
};

function hashString(s: string, seed: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x85ebca6b) >>> 0;
  return h;
}

export function applyLookHints(h: LookHints, env: EnvParams, look: LookParams, bulk?: PlanetBulk, archetype?: string, seed = 0) {
  env.atmoDensity = Math.max(MIN_ATMO_DENSITY, h.atmoDensity);
  env.atmoHeight = h.atmoHeightKm;
  env.rayleigh = { x: h.rayleigh[0], y: h.rayleigh[1], z: h.rayleigh[2] };
  env.mie = h.mie;
  // The ray march stops at the shell top: keep scale heights well below it so density
  // fades out smoothly instead of ending in a hard-edged shell.
  env.rayleighH = Math.min(h.rayleighH, h.atmoHeightKm / 5);
  env.mieH = Math.min(h.mieH, h.atmoHeightKm / 7);
  // Ground haze from surface pressure: a faint hint on airless bodies (exospheric dust), a real
  // dusty horizon on worlds with a thin atmosphere. Scale height grows on low-gravity bodies.
  if (bulk) {
    const p = Math.max(bulk.atmospherePressureBar, 1e-16);
    const k = Math.min(Math.max((Math.log10(p) + 7) / 5, 0), 1); // 1e-7 bar -> 0, 1e-2 bar -> 1
    env.haze = 0.5 + 7 * k * k;
    look.finePits = 1 - 0.85 * k;
    env.hazeH = Math.min(Math.max(bulk.radiusKm * 0.008, 1.5), 5) * (1 + 0.6 * k);
    // Tint from the dust layer (raw texture is greyish; the world tint carries the colour).
    const t = h.layerTints[0] ?? [1, 1, 1];
    const m = Math.max(t[0], t[1], t[2], 1e-3);
    const c = (v: number) => Math.round(255 * Math.min(1, 0.55 + 0.4 * (v / m)));
    env.hazeColor = `#${[t[0], t[1], t[2]].map((v) => c(v).toString(16).padStart(2, '0')).join('')}`;
  }
  let st = archetype ? LAND_STYLE[archetype] : undefined;
  if (!st) {
    // 'wild' (or unknown): a random but seed-stable mix with one dominant style.
    let x = hashString(archetype ?? 'wild', seed);
    const r = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296);
    const w: [number, number, number, number] = [r() * 0.4, r() * 0.4, r() * 0.4, r() * 0.4];
    w[Math.floor(r() * 4)] += 0.8;
    st = w;
  }
  [look.landRidged, look.landBillowy, look.landCracked, look.landPitted] = st;
  look.oceanMode = SEA_MODE[h.seaKind] ?? 3;
  look.deepColor = h.seaDeepColor;
  look.shallowColor = h.seaShallowColor;
}

/** Nicer button labels for archetype keys (falls back to the capitalised key). */
export const ARCHETYPE_LABELS: Record<string, string> = {
  rust: 'Rust',
  cinder: 'Cinder',
  'grey moon': 'Grey moon',
  'ice shell': 'Ice shell',
  'old ice': 'Old ice',
  sulfur: 'Sulfur',
  basalt: 'Basalt',
  cryo: 'Cryovolcanic',
  wild: 'Wild',
};

export function archetypeLabel(key: string): string {
  return ARCHETYPE_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

const SYL_A = ['ka', 've', 'tor', 'mi', 'zan', 'or', 'el', 'cy', 'ra', 'nu', 'thal', 'is', 'ae', 'lu', 'dra', 'sen', 'qua', 'ix', 'ber', 'syl'];
const SYL_B = ['ra', 'lon', 'dia', 'ros', 'vex', 'nia', 'tis', 'mar', 'sus', 'thea', 'on', 'ka', 'rel', 'phi', 'dun'];
const SUFFIX = ['', '', '', ' Prime', ' II', ' III', ' IV', ' b', ' c', ' d', ' Minor'];

/** Deterministic planet name for a seed. */
export function planetName(seed: number): string {
  let s = (seed * 2654435761) >>> 0;
  const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const a = SYL_A[Math.floor(r() * SYL_A.length)];
  const b = r() < 0.5 ? SYL_A[Math.floor(r() * SYL_A.length)] : '';
  const c = SYL_B[Math.floor(r() * SYL_B.length)];
  const name = a + b + c;
  return name[0].toUpperCase() + name.slice(1) + SUFFIX[Math.floor(r() * SUFFIX.length)];
}
