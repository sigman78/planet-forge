// Generator parameters, UI schema and presets.
// All knobs are plain numbers/strings so they can be posted to workers and bound to Tweakpane.

/** What fills the area below 0 m. The generator treats them all the same; the renderer decides how to draw it. */
export type SeaKind = 'water' | 'ice' | 'lava' | 'none';
/** Which splat layer replaces vegetation where `vegetation` < 1 (barren worlds). */
export type BareGround = 'gravel' | 'desert' | 'rock';

export interface GenParams {
  // --- general ---
  seed: number;
  /** Interior texels per cube face (128 / 256 / 512 / 1024). */
  resolution: number;
  /** Sea-level radius in metres. */
  radius: number;
  /** How the renderer should treat terrain below 0 m. Ocean coverage still defines the 0 m level for 'none'/'lava'. */
  seaKind: SeaKind;

  // --- continents ---
  /** Area fraction below sea level (0..1). Sea level = this area-weighted height percentile, shifted to exactly 0 m. */
  oceanCoverage: number;
  /** Continent noise frequency (higher = more, smaller land masses). */
  continentFreq: number;
  /** Domain-warp strength for continents and plate boundaries. */
  warpStrength: number;
  /** Number of tectonic plates. */
  plateCount: number;
  /** How strongly plate type (continental/oceanic) shapes the continents (0 = pure noise). */
  plateInfluence: number;
  /** Width of continental shelves (in continent-noise units, ~0.02..0.12). */
  shelfWidth: number;

  // --- relief ---
  /** Elevation of the highest peaks in metres (99.99th land percentile before erosion). */
  maxElevation: number;
  /** Depth of the deepest trenches in metres (99.9th depth percentile), positive number. */
  maxDepth: number;
  /** Mountain ranges along convergent plate boundaries. */
  mountainStrength: number;
  /** Ridge sharpness exponent of the ridged multifractal (1 = soft, 3 = knife-edge). */
  ridgeSharpness: number;
  /** Mountain belt width (radians of arc). */
  mountainWidth: number;
  /** Rolling hills on land. */
  hills: number;
  /** Fine detail noise everywhere. */
  detail: number;
  /** Raised plateaus with escarpment edges. */
  plateaus: number;
  /** Terracing of land (0 = off, 1 = hard steps). */
  terracing: number;
  /** Dune fields (ergs) in lowlands. */
  dunes: number;

  // --- craters / volcanoes ---
  craterCount: number;
  /** Largest crater radius as a fraction of planet radius. Sizes follow a power law below it. */
  craterSize: number;
  /** Crater depth multiplier. */
  craterDepth: number;
  volcanoCount: number;
  /** Largest volcano base radius as a fraction of planet radius. */
  volcanoSize: number;

  // --- erosion ---
  /** Hydraulic droplets per land texel (scales with N², 0 = off). */
  erosionDroplets: number;
  erosionRate: number;
  depositionRate: number;
  /** Droplet inertia 0..1 (higher = straighter, longer valleys). */
  inertia: number;
  evaporation: number;
  /** Sediment capacity factor. */
  capacity: number;
  /** Erosion brush radius in texels (1..3). */
  brushRadius: number;
  /** Thermal (talus) erosion iterations. */
  thermalIterations: number;
  /** Talus angle in degrees: slopes steeper than this slump. */
  talusAngle: number;

  // --- climate ---
  /** Global temperature offset in °C (0 = Earth-like). */
  temperatureOffset: number;
  /** Axial tilt in degrees. More tilt = milder poles, narrower tropics. */
  axialTilt: number;
  /** Equator-to-pole temperature drop in °C. */
  poleCold: number;
  /** Moisture offset (-1..1). */
  moisture: number;
  /** Strength of rain shadows behind mountains (0..1). */
  rainShadow: number;
  /** Vegetation multiplier (0 = barren, 1 = Earth-like). */
  vegetation: number;
  /** Layer that replaces missing vegetation on barren worlds. */
  bareGround: BareGround;

  // --- materials ---
  /** Slope in degrees where rock takes over. */
  rockSlope: number;
  /** Mean annual temperature (°C) below which snow/ice lies. */
  snowTemp: number;
  /** Beach band height above sea level in metres. */
  beachWidth: number;

  // --- clouds ---
  cloudCoverage: number;
  /** Cloud feature scale (higher = smaller cloud cells). */
  cloudScale: number;
  /** Number of cyclone swirls. */
  cyclones: number;
  /** Interior resolution of the cloud cube. */
  cloudResolution: number;
}

export const DEFAULT_PARAMS: GenParams = {
  seed: 42,
  resolution: 512,
  radius: 800_000,
  seaKind: 'water',

  oceanCoverage: 0.62,
  continentFreq: 1.1,
  warpStrength: 0.9,
  plateCount: 14,
  plateInfluence: 0.45,
  shelfWidth: 0.05,

  maxElevation: 9000,
  maxDepth: 6000,
  mountainStrength: 1,
  ridgeSharpness: 2,
  mountainWidth: 0.09,
  hills: 1,
  detail: 1,
  plateaus: 0.3,
  terracing: 0,
  dunes: 0,

  craterCount: 0,
  craterSize: 0.12,
  craterDepth: 1,
  volcanoCount: 0,
  volcanoSize: 0.06,

  erosionDroplets: 0.7,
  erosionRate: 0.3,
  depositionRate: 0.3,
  inertia: 0.3,
  evaporation: 0.02,
  capacity: 4,
  brushRadius: 2,
  thermalIterations: 6,
  talusAngle: 40,

  temperatureOffset: 0,
  axialTilt: 23.5,
  poleCold: 45,
  moisture: 0,
  rainShadow: 0.7,
  vegetation: 1,
  bareGround: 'gravel',

  rockSlope: 30,
  snowTemp: -8,
  beachWidth: 40,

  cloudCoverage: 0.5,
  cloudScale: 1,
  cyclones: 4,
  cloudResolution: 256,
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
}

export const PARAM_SCHEMA: ParamSchemaEntry[] = [
  { key: 'seed', group: 'General', label: 'Seed', min: 0, max: 99999, step: 1 },
  { key: 'resolution', group: 'General', label: 'Resolution', options: { '128': 128, '256': 256, '512': 512, '1024': 1024 } },
  { key: 'radius', group: 'General', label: 'Radius (m)', min: 200_000, max: 3_000_000, step: 10_000 },
  { key: 'seaKind', group: 'General', label: 'Sea', options: { water: 'water', ice: 'ice', lava: 'lava', none: 'none' } },

  { key: 'oceanCoverage', group: 'Continents', label: 'Ocean coverage', min: 0, max: 0.95, step: 0.01 },
  { key: 'continentFreq', group: 'Continents', label: 'Continent freq', min: 0.4, max: 4, step: 0.05 },
  { key: 'warpStrength', group: 'Continents', label: 'Domain warp', min: 0, max: 2.5, step: 0.05 },
  { key: 'plateCount', group: 'Continents', label: 'Plates', min: 4, max: 40, step: 1 },
  { key: 'plateInfluence', group: 'Continents', label: 'Plate influence', min: 0, max: 1, step: 0.01 },
  { key: 'shelfWidth', group: 'Continents', label: 'Shelf width', min: 0.01, max: 0.15, step: 0.005 },

  { key: 'maxElevation', group: 'Relief', label: 'Max elevation (m)', min: 1000, max: 20000, step: 100 },
  { key: 'maxDepth', group: 'Relief', label: 'Max depth (m)', min: 200, max: 12000, step: 100 },
  { key: 'mountainStrength', group: 'Relief', label: 'Mountains', min: 0, max: 2, step: 0.01 },
  { key: 'ridgeSharpness', group: 'Relief', label: 'Ridge sharpness', min: 0.5, max: 4, step: 0.05 },
  { key: 'mountainWidth', group: 'Relief', label: 'Mountain width', min: 0.02, max: 0.25, step: 0.005 },
  { key: 'hills', group: 'Relief', label: 'Hills', min: 0, max: 2, step: 0.01 },
  { key: 'detail', group: 'Relief', label: 'Detail', min: 0, max: 2, step: 0.01 },
  { key: 'plateaus', group: 'Relief', label: 'Plateaus', min: 0, max: 1.5, step: 0.01 },
  { key: 'terracing', group: 'Relief', label: 'Terracing', min: 0, max: 1, step: 0.01 },
  { key: 'dunes', group: 'Relief', label: 'Dunes', min: 0, max: 2, step: 0.01 },

  { key: 'craterCount', group: 'Craters', label: 'Craters', min: 0, max: 4000, step: 10 },
  { key: 'craterSize', group: 'Craters', label: 'Max crater size', min: 0.01, max: 0.4, step: 0.005 },
  { key: 'craterDepth', group: 'Craters', label: 'Crater depth', min: 0, max: 3, step: 0.01 },
  { key: 'volcanoCount', group: 'Craters', label: 'Volcanoes', min: 0, max: 200, step: 1 },
  { key: 'volcanoSize', group: 'Craters', label: 'Max volcano size', min: 0.01, max: 0.2, step: 0.005 },

  { key: 'erosionDroplets', group: 'Erosion', label: 'Droplets / texel', min: 0, max: 4, step: 0.05 },
  { key: 'erosionRate', group: 'Erosion', label: 'Erosion rate', min: 0, max: 1, step: 0.01 },
  { key: 'depositionRate', group: 'Erosion', label: 'Deposition rate', min: 0, max: 1, step: 0.01 },
  { key: 'inertia', group: 'Erosion', label: 'Inertia', min: 0, max: 0.95, step: 0.01 },
  { key: 'evaporation', group: 'Erosion', label: 'Evaporation', min: 0.001, max: 0.2, step: 0.001 },
  { key: 'capacity', group: 'Erosion', label: 'Capacity', min: 0.5, max: 16, step: 0.1 },
  { key: 'brushRadius', group: 'Erosion', label: 'Brush radius', min: 1, max: 3, step: 1 },
  { key: 'thermalIterations', group: 'Erosion', label: 'Thermal passes', min: 0, max: 30, step: 1 },
  { key: 'talusAngle', group: 'Erosion', label: 'Talus angle', min: 15, max: 70, step: 1 },

  { key: 'temperatureOffset', group: 'Climate', label: 'Temperature (°C)', min: -50, max: 50, step: 0.5 },
  { key: 'axialTilt', group: 'Climate', label: 'Axial tilt (°)', min: 0, max: 90, step: 0.5 },
  { key: 'poleCold', group: 'Climate', label: 'Pole cold (°C)', min: 0, max: 90, step: 0.5 },
  { key: 'moisture', group: 'Climate', label: 'Moisture', min: -1, max: 1, step: 0.01 },
  { key: 'rainShadow', group: 'Climate', label: 'Rain shadow', min: 0, max: 1, step: 0.01 },
  { key: 'vegetation', group: 'Climate', label: 'Vegetation', min: 0, max: 1.5, step: 0.01 },
  { key: 'bareGround', group: 'Climate', label: 'Bare ground', options: { gravel: 'gravel', desert: 'desert', rock: 'rock' } },

  { key: 'rockSlope', group: 'Materials', label: 'Rock slope (°)', min: 5, max: 60, step: 0.5 },
  { key: 'snowTemp', group: 'Materials', label: 'Snow line (°C)', min: -30, max: 10, step: 0.5 },
  { key: 'beachWidth', group: 'Materials', label: 'Beach width (m)', min: 0, max: 300, step: 1 },

  { key: 'cloudCoverage', group: 'Clouds', label: 'Coverage', min: 0, max: 1, step: 0.01 },
  { key: 'cloudScale', group: 'Clouds', label: 'Scale', min: 0.3, max: 3, step: 0.01 },
  { key: 'cyclones', group: 'Clouds', label: 'Cyclones', min: 0, max: 12, step: 1 },
  { key: 'cloudResolution', group: 'Clouds', label: 'Resolution', options: { '128': 128, '256': 256, '512': 512 } },
];

/**
 * Named partial parameter sets, applied over DEFAULT_PARAMS (see `resolveParams`).
 * Presets keep the user's seed and resolution: they do not set them.
 */
export const GEN_PRESETS: Record<string, Partial<GenParams>> = {
  terran: {},
  archipelago: {
    oceanCoverage: 0.84,
    continentFreq: 2.4,
    warpStrength: 1.2,
    plateCount: 22,
    plateInfluence: 0.25,
    shelfWidth: 0.07,
    maxElevation: 6000,
    maxDepth: 5500,
    mountainStrength: 0.8,
    volcanoCount: 30,
    volcanoSize: 0.03,
    temperatureOffset: 6,
    moisture: 0.25,
    cloudCoverage: 0.55,
  },
  desert: {
    oceanCoverage: 0.12,
    continentFreq: 1.4,
    maxElevation: 8000,
    maxDepth: 2500,
    plateaus: 0.8,
    terracing: 0.25,
    dunes: 1.2,
    erosionDroplets: 0.4,
    temperatureOffset: 14,
    poleCold: 35,
    moisture: -0.65,
    rainShadow: 0.9,
    vegetation: 0.25,
    bareGround: 'desert',
    beachWidth: 15,
    cloudCoverage: 0.15,
    cyclones: 1,
  },
  ice: {
    seaKind: 'ice',
    oceanCoverage: 0.55,
    maxElevation: 8000,
    hills: 0.8,
    erosionDroplets: 0.5,
    thermalIterations: 10,
    temperatureOffset: -32,
    poleCold: 30,
    moisture: -0.2,
    vegetation: 0.3,
    bareGround: 'gravel',
    snowTemp: -12,
    beachWidth: 5,
    cloudCoverage: 0.45,
    cyclones: 3,
  },
  volcanic: {
    seaKind: 'lava',
    oceanCoverage: 0.22,
    continentFreq: 1.6,
    warpStrength: 1.4,
    maxElevation: 12000,
    maxDepth: 1500,
    mountainStrength: 1.3,
    ridgeSharpness: 2.6,
    plateaus: 0.5,
    volcanoCount: 60,
    volcanoSize: 0.08,
    craterCount: 60,
    craterSize: 0.05,
    erosionDroplets: 0.25,
    thermalIterations: 12,
    temperatureOffset: 35,
    moisture: -0.9,
    vegetation: 0,
    bareGround: 'gravel',
    rockSlope: 22,
    beachWidth: 0,
    cloudCoverage: 0.3,
    cyclones: 0,
  },
  moon: {
    seaKind: 'none',
    oceanCoverage: 0.5,
    continentFreq: 0.8,
    warpStrength: 0.6,
    plateInfluence: 0,
    maxElevation: 7000,
    maxDepth: 7000,
    mountainStrength: 0.15,
    hills: 0.5,
    plateaus: 0,
    craterCount: 1800,
    craterSize: 0.22,
    craterDepth: 1.2,
    erosionDroplets: 0,
    thermalIterations: 4,
    temperatureOffset: -20,
    moisture: -1,
    vegetation: 0,
    bareGround: 'gravel',
    rockSlope: 26,
    snowTemp: -100,
    beachWidth: 0,
    cloudCoverage: 0,
    cyclones: 0,
  },
  alien: {
    oceanCoverage: 0.38,
    continentFreq: 1.8,
    warpStrength: 2.2,
    plateCount: 9,
    plateInfluence: 0.6,
    maxElevation: 14000,
    maxDepth: 8000,
    mountainStrength: 1.6,
    ridgeSharpness: 3.4,
    mountainWidth: 0.05,
    plateaus: 1.3,
    terracing: 0.75,
    erosionDroplets: 1.0,
    inertia: 0.6,
    axialTilt: 60,
    temperatureOffset: 12,
    moisture: 0.6,
    vegetation: 1.4,
    rockSlope: 38,
    cloudCoverage: 0.65,
    cloudScale: 1.8,
    cyclones: 9,
  },
};

/** Merge a partial over the defaults and clamp the values that would break the pipeline. */
export function resolveParams(p: Partial<GenParams> = {}): GenParams {
  const r: GenParams = { ...DEFAULT_PARAMS, ...p };
  r.seed = Math.floor(r.seed) >>> 0;
  r.resolution = Math.max(8, Math.floor(r.resolution));
  r.cloudResolution = Math.max(8, Math.floor(r.cloudResolution));
  r.oceanCoverage = Math.min(0.99, Math.max(0.01, r.oceanCoverage));
  r.plateCount = Math.max(2, Math.floor(r.plateCount));
  r.brushRadius = Math.min(3, Math.max(1, Math.round(r.brushRadius)));
  r.craterCount = Math.max(0, Math.floor(r.craterCount));
  r.volcanoCount = Math.max(0, Math.floor(r.volcanoCount));
  r.cyclones = Math.max(0, Math.floor(r.cyclones));
  r.thermalIterations = Math.max(0, Math.floor(r.thermalIterations));
  return r;
}

/** Preset by name merged over defaults; `overrides` (e.g. seed, resolution) win. */
export function presetParams(name: string, overrides: Partial<GenParams> = {}): GenParams {
  return resolveParams({ ...(GEN_PRESETS[name] ?? {}), ...overrides });
}
