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
  cloudSpeed: number;
  cloudShadow: number;
  cloudAltitude: number;
  cloudCover: number; // shader-side coverage bias
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
  cloudSpeed: 1,
  cloudShadow: 0.6,
  cloudAltitude: 9,
  cloudCover: 0.5,
  fov: 45,
  autoRotate: 0,
  autoTilt: true,
};

export interface PlanetPreset {
  label: string;
  gen: string; // key into GEN_PRESETS
  look: Partial<LookParams>;
  env: Partial<EnvParams>;
  vegTint?: string;
}

export const PLANET_PRESETS: Record<string, PlanetPreset> = {
  terran: {
    label: 'Terran',
    gen: 'terran',
    look: { oceanMode: 0, cityLights: 1.2, cloudTint: '#ffffff' },
    env: {},
  },
  archipelago: {
    label: 'Archipelago',
    gen: 'archipelago',
    look: { oceanMode: 0, shallowColor: '#1fa0a0', deepColor: '#041c3a', clarity: 80, cityLights: 0.6 },
    env: { cloudCover: 0.55 },
  },
  desert: {
    label: 'Dune world',
    gen: 'desert',
    look: { oceanMode: 0, shallowColor: '#2a8a80', deepColor: '#06203a', cityLights: 0.4, cloudTint: '#fff1dc' },
    env: { rayleigh: { x: 9, y: 11, z: 16 }, mie: 14, mieH: 3, mieG: 0.7, atmoHeight: 60, cloudCover: 0.3 },
  },
  ice: {
    label: 'Ice world',
    gen: 'ice',
    look: { oceanMode: 2, cityLights: 0 },
    env: { rayleigh: { x: 4.5, y: 11, z: 30 }, atmoDensity: 0.7, mie: 2.5, sunIntensity: 5.5 },
  },
  volcanic: {
    label: 'Volcanic',
    gen: 'volcanic',
    look: { oceanMode: 1, cityLights: 0, cloudTint: '#5a4c46', cloudOpacity: 0.85, wetness: 0, rivers: 0 },
    env: { rayleigh: { x: 22, y: 12, z: 7 }, mie: 18, mieH: 4, mieG: 0.65, atmoDensity: 1.1, bloomStrength: 0.6, bloomThreshold: 1.2, sunIntensity: 5 },
  },
  moon: {
    label: 'Barren moon',
    gen: 'moon',
    look: { oceanMode: 3, cityLights: 0, cloudsVisible: false, wetness: 0, rivers: 0 },
    env: { atmoDensity: 0, ambient: 0.002 },
  },
  alien: {
    label: 'Alien',
    gen: 'alien',
    look: { oceanMode: 0, deepColor: '#16052e', shallowColor: '#1b9c7c', clarity: 60, cloudTint: '#e9ffe9', cityLights: 0 },
    env: { rayleigh: { x: 26, y: 9, z: 22 }, mie: 6, atmoHeight: 90, rayleighH: 11 },
    vegTint: '#c58aff',
  },
};

const SYL_A = ['ka', 've', 'tor', 'mi', 'zan', 'or', 'el', 'cy', 'ra', 'nu', 'thal', 'is', 'ae', 'lu', 'dra', 'sen', 'qua', 'ix', 'ber', 'syl'];
const SYL_B = ['ra', 'lon', 'dia', 'ros', 'vex', 'nia', 'tis', 'mar', 'sus', 'thea', 'on', 'ka', 'rel', 'phi', 'dun'];
const SUFFIX = ['', '', '', ' Prime', ' II', ' III', ' IV', ' b', ' c', ' Major', ' Minor'];

/** Deterministic planet name for a seed. */
export function planetName(seed: number): string {
  let s = (seed * 2654435761) >>> 0;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const a = SYL_A[Math.floor(r() * SYL_A.length)];
  const b = r() < 0.5 ? SYL_A[Math.floor(r() * SYL_A.length)] : '';
  const c = SYL_B[Math.floor(r() * SYL_B.length)];
  const name = a + b + c;
  return name[0].toUpperCase() + name.slice(1) + SUFFIX[Math.floor(r() * SUFFIX.length)];
}
