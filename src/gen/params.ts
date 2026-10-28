// Generator parameters, UI schema and archetype presets.
// Every knob is a plain number/string so it can be posted to workers and bound to Tweakpane.
// Numeric knobs whose schema min is -1 use -1 = AUTO: the value is derived from the archetype + bulk planet.

export type Archetype = 'rust' | 'cinder' | 'grey moon' | 'ice shell' | 'old ice' | 'sulfur' | 'basalt' | 'cryo' | 'wild';

/** Sentinel for "derive from archetype / bulk". */
export const AUTO = -1;

export interface GenParams {
  // --- general ---
  seed: number;
  /** Interior texels per cube face (128 / 256 / 512 / 1024). */
  resolution: number;
  /** World archetype: sets ranges for the bulk and the default strength of every stage. */
  archetype: Archetype;
  /** 0..2: exaggerates volcanoes, basins, canyons and scarps (1 = archetype default). */
  drama: number;
  /** Vertical scale multiplier for all relief. */
  reliefScale: number;

  // --- bulk planet (-1 = auto from archetype + seed) ---
  radiusKm: number;
  /** Iron mass fraction (core). */
  ironFrac: number;
  /** Volatile (water/ice/organics) mass fraction. */
  volatileFrac: number;
  ageGyr: number;
  /** Stellar flux relative to Earth. */
  insolation: number;
  /** Tidal heating from an eccentric orbit around a giant parent, as a multiple of radiogenic heat. */
  tidalHeating: number;

  // --- formation stages (-1 = auto) ---
  /** Hemispheric crustal dichotomy strength. */
  dichotomy: number;
  basinCount: number;
  /** Largest basin rim radius in radians of arc. */
  basinSize: number;
  craterDensity: number;
  /** Number of volcanoes / paterae. */
  plumeCount: number;
  /** Volcano height multiplier (heights already scale with 1/gravity). */
  volcanoScale: number;
  /** Broad volcanic rises (Tharsis-like bulges). */
  riseCount: number;
  /** Rift / canyon system strength. */
  riftStrength: number;
  /** Global-contraction lobate scarps. */
  scarps: number;
  /** Ice tectonics: lineae (ridges and cracks) on young shells, grooved bands on old ice. */
  lineae: number;
  /** Chaos terrain amount. */
  chaos: number;
  /** Flood-basalt area fraction (0..0.6): low basins fill up to this area percentile. */
  floodLevel: number;
  /**
   * Surface liquid/ice volume as global equivalent layer depth (m); the sea level follows from it.
   * AUTO: the archetype picks a small target coverage instead (rocky worlds: no sea).
   */
  seaVolume: number;
  /** Fluvial erosion strength (droplet erosion). */
  erosion: number;
  dunes: number;
  /** Evaporite / sulfur / frost deposit strength. */
  salt: number;
  /** Number of fresh rayed craters. */
  rays: number;
  polarCaps: number;

  // --- erosion details ---
  /** Droplets per land texel at erosion = 1. */
  erosionDroplets: number;
  erosionRate: number;
  depositionRate: number;
  inertia: number;
  evaporation: number;
  capacity: number;
  brushRadius: number;
  thermalIterations: number;
  talusAngle: number;

  // --- materials ---
  /** Slope in degrees where bare rock takes over. */
  rockSlope: number;
}

export const DEFAULT_PARAMS: GenParams = {
  seed: 42,
  resolution: 512,
  archetype: 'rust',
  drama: 1,
  reliefScale: 1,

  radiusKm: AUTO,
  ironFrac: AUTO,
  volatileFrac: AUTO,
  ageGyr: AUTO,
  insolation: AUTO,
  tidalHeating: AUTO,

  dichotomy: AUTO,
  basinCount: AUTO,
  basinSize: AUTO,
  craterDensity: AUTO,
  plumeCount: AUTO,
  volcanoScale: AUTO,
  riseCount: AUTO,
  riftStrength: AUTO,
  scarps: AUTO,
  lineae: AUTO,
  chaos: AUTO,
  floodLevel: AUTO,
  seaVolume: AUTO,
  erosion: AUTO,
  dunes: AUTO,
  salt: AUTO,
  rays: AUTO,
  polarCaps: AUTO,

  erosionDroplets: 0.8,
  erosionRate: 0.3,
  depositionRate: 0.3,
  inertia: 0.35,
  evaporation: 0.02,
  capacity: 4,
  brushRadius: 2,
  thermalIterations: 4,
  talusAngle: 42,

  rockSlope: 28,
};

export interface ParamSchemaEntry {
  key: keyof GenParams;
  group: string;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  /** Tweakpane-style options: label -> value. */
  options?: Record<string, string | number>;
  /** True when -1 means "auto" (derived from archetype + bulk). */
  auto?: boolean;
}

export const ARCHETYPE_LABELS: Record<Archetype, string> = {
  rust: 'Rust (Mars-like)',
  cinder: 'Cinder (Mercury-like)',
  'grey moon': 'Grey moon (Moon-like)',
  'ice shell': 'Ice shell (Europa-like)',
  'old ice': 'Old ice (Callisto-like)',
  sulfur: 'Sulfur (Io-like)',
  basalt: 'Basalt (young volcanic)',
  cryo: 'Cryo (Enceladus/Triton-like)',
  wild: 'Wild',
};

const archOptions: Record<string, string> = {};
for (const [k, v] of Object.entries(ARCHETYPE_LABELS)) archOptions[v] = k;

const auto = (key: keyof GenParams, group: string, label: string, max: number, step: number): ParamSchemaEntry =>
  ({ key, group, label, min: -1, max, step, auto: true });

export const PARAM_SCHEMA: ParamSchemaEntry[] = [
  { key: 'seed', group: 'General', label: 'Seed', min: 0, max: 99999, step: 1 },
  { key: 'resolution', group: 'General', label: 'Resolution', options: { '128': 128, '256': 256, '512': 512, '1024': 1024 } },
  { key: 'archetype', group: 'General', label: 'Archetype', options: archOptions },
  { key: 'drama', group: 'General', label: 'Drama', min: 0, max: 2, step: 0.01 },
  { key: 'reliefScale', group: 'General', label: 'Relief scale', min: 0.25, max: 3, step: 0.01 },

  auto('radiusKm', 'Bulk', 'Radius (km)', 2000, 5),
  auto('ironFrac', 'Bulk', 'Iron fraction', 0.8, 0.01),
  auto('volatileFrac', 'Bulk', 'Volatile fraction', 0.6, 0.005),
  auto('ageGyr', 'Bulk', 'Age (Gyr)', 10, 0.05),
  auto('insolation', 'Bulk', 'Insolation (Earth=1)', 12, 0.01),
  auto('tidalHeating', 'Bulk', 'Tidal heating ×', 80, 0.1),

  auto('dichotomy', 'Crust & impacts', 'Dichotomy', 2, 0.01),
  auto('basinCount', 'Crust & impacts', 'Giant basins', 8, 1),
  auto('basinSize', 'Crust & impacts', 'Basin size (rad)', 0.8, 0.01),
  auto('craterDensity', 'Crust & impacts', 'Crater density', 3, 0.01),
  auto('rays', 'Crust & impacts', 'Rayed craters', 30, 1),

  auto('plumeCount', 'Volcanism', 'Volcanoes', 150, 1),
  auto('volcanoScale', 'Volcanism', 'Volcano scale', 3, 0.01),
  auto('riseCount', 'Volcanism', 'Volcanic rises', 4, 1),
  auto('floodLevel', 'Volcanism', 'Flood basalt', 0.6, 0.01),

  auto('riftStrength', 'Tectonics', 'Rifts & canyons', 2, 0.01),
  auto('scarps', 'Tectonics', 'Lobate scarps', 2, 0.01),
  auto('lineae', 'Tectonics', 'Lineae / grooves (ice)', 2, 0.01),
  auto('chaos', 'Tectonics', 'Chaos terrain', 2, 0.01),

  auto('seaVolume', 'Volatiles', 'Sea volume (m GEL)', 3000, 5),
  auto('erosion', 'Volatiles', 'Fluvial erosion', 2, 0.01),
  auto('polarCaps', 'Volatiles', 'Polar caps', 2, 0.01),
  auto('dunes', 'Volatiles', 'Dunes', 2, 0.01),
  auto('salt', 'Volatiles', 'Salt / sulfur deposits', 2, 0.01),

  { key: 'erosionDroplets', group: 'Erosion detail', label: 'Droplets / texel', min: 0, max: 4, step: 0.05 },
  { key: 'erosionRate', group: 'Erosion detail', label: 'Erosion rate', min: 0, max: 1, step: 0.01 },
  { key: 'depositionRate', group: 'Erosion detail', label: 'Deposition rate', min: 0, max: 1, step: 0.01 },
  { key: 'inertia', group: 'Erosion detail', label: 'Inertia', min: 0, max: 0.95, step: 0.01 },
  { key: 'evaporation', group: 'Erosion detail', label: 'Evaporation', min: 0.001, max: 0.2, step: 0.001 },
  { key: 'capacity', group: 'Erosion detail', label: 'Capacity', min: 0.5, max: 16, step: 0.1 },
  { key: 'brushRadius', group: 'Erosion detail', label: 'Brush radius', min: 1, max: 3, step: 1 },
  { key: 'thermalIterations', group: 'Erosion detail', label: 'Thermal passes', min: 0, max: 30, step: 1 },
  { key: 'talusAngle', group: 'Erosion detail', label: 'Talus angle', min: 15, max: 70, step: 1 },

  { key: 'rockSlope', group: 'Materials', label: 'Rock slope (°)', min: 5, max: 60, step: 0.5 },
];

/**
 * Archetype presets (partials over DEFAULT_PARAMS). Everything else stays AUTO, so the seed varies the bulk
 * planet and stage strengths within the archetype's ranges. Presets do not set seed or resolution.
 */
export const GEN_PRESETS: Record<string, Partial<GenParams>> = {
  rust: { archetype: 'rust' },
  cinder: { archetype: 'cinder' },
  'grey moon': { archetype: 'grey moon' },
  'ice shell': { archetype: 'ice shell' },
  'old ice': { archetype: 'old ice' },
  sulfur: { archetype: 'sulfur' },
  basalt: { archetype: 'basalt' },
  cryo: { archetype: 'cryo' },
  wild: { archetype: 'wild', drama: 1.5 },
};

/** Archetype families, for grouping in the UI. */
export const ARCHETYPE_FAMILIES: Record<string, Archetype[]> = {
  rocky: ['rust', 'cinder', 'grey moon'],
  ice: ['ice shell', 'old ice'],
  volcanic: ['sulfur', 'basalt'],
  cryovolcanic: ['cryo'],
  random: ['wild'],
};

/** Merge a partial over the defaults and sanitise values that would break the pipeline. */
export function resolveParams(p: Partial<GenParams> = {}): GenParams {
  const r: GenParams = { ...DEFAULT_PARAMS, ...p };
  r.seed = Math.floor(r.seed) >>> 0;
  r.resolution = Math.max(8, Math.floor(r.resolution));
  if (!(r.archetype in ARCHETYPE_LABELS)) r.archetype = 'rust';
  r.brushRadius = Math.min(3, Math.max(1, Math.round(r.brushRadius)));
  r.thermalIterations = Math.max(0, Math.floor(r.thermalIterations));
  r.drama = Math.max(0, r.drama);
  r.reliefScale = Math.max(0.05, r.reliefScale);
  return r;
}

/** Preset by name merged over defaults; `overrides` (e.g. seed, resolution) win. */
export function presetParams(name: string, overrides: Partial<GenParams> = {}): GenParams {
  return resolveParams({ ...(GEN_PRESETS[name] ?? {}), ...overrides });
}

/** `v` unless it is AUTO (< 0), else `fallback`. */
export function pick(v: number, fallback: number): number {
  return v >= 0 ? v : fallback;
}
