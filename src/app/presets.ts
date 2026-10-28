import type { LookHints, SeaKind } from '../core/types.ts';
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
  ambient: number;
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
  ambient: 0.004,
  fov: 45,
  autoRotate: 0,
  autoTilt: true,
};

/** Minimum atmosphere so every world keeps at least a faint limb haze. */
export const MIN_ATMO_DENSITY = 0.04;

const SEA_MODE: Record<SeaKind, number> = { water: 0, lava: 1, ice: 2, none: 3 };

/** Copy the generator's render hints into the viewer settings. */
export function applyLookHints(h: LookHints, env: EnvParams, look: LookParams) {
  env.atmoDensity = Math.max(MIN_ATMO_DENSITY, h.atmoDensity);
  env.atmoHeight = h.atmoHeightKm;
  env.rayleigh = { x: h.rayleigh[0], y: h.rayleigh[1], z: h.rayleigh[2] };
  env.mie = h.mie;
  // The ray march stops at the shell top: keep scale heights well below it so density
  // fades out smoothly instead of ending in a hard-edged shell.
  env.rayleighH = Math.min(h.rayleighH, h.atmoHeightKm / 5);
  env.mieH = Math.min(h.mieH, h.atmoHeightKm / 7);
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
