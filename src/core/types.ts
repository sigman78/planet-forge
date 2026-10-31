// Data contract between the generator (src/gen) and the renderer (src/render). See CONTRACT.md.

/**
 * Terrain material layers, fixed order. Index = splat channel (0..3 in splat0 RGBA, 4..7 in splat1 RGBA).
 * Geological, not Earth biomes: the planets are small rocky worlds. Colour variety per world comes from
 * per-layer tints (PlanetInfo.look.layerTints), e.g. red dust on a Mars-like world, yellow sulfur on an Io-like one.
 */
export const LAYERS = [
  'dust', // 0  fine regolith / dust mantling, tintable (grey, rust, ochre)
  'highland', // 1  bright, rough, old cratered highland regolith
  'basalt', // 2  dark volcanic plains (maria), solidified lava flows
  'sand', // 3  dunes and sand sheets
  'rock', // 4  bare rock: cliffs, crater walls, scarps, canyon walls (steep)
  'gravel', // 5  ejecta blankets, scree, boulder fields, talus
  'ice', // 6  ice, frost, snow, polar caps, ice shells
  'salt', // 7  bright deposits: evaporites, playas, sulfur/frost deposits (tintable)
] as const;
export type LayerName = (typeof LAYERS)[number];

export type SeaKind = 'water' | 'ice' | 'lava' | 'none';
export type TectonicRegime = 'stagnant' | 'episodic' | 'mobile';

/** Bulk physical description of the planet, derived from the seed + archetype before any terrain exists. */
export interface PlanetBulk {
  radiusKm: number;
  massEarth: number;
  densityGcc: number;
  gravity: number; // m/s^2
  coreRadiusFrac: number; // core radius / planet radius
  ironFrac: number;
  volatileFrac: number;
  ageGyr: number;
  insolation: number; // Earth = 1
  surfaceTempK: number; // mean
  heatFlow: number; // relative internal heat today (Earth = 1)
  tectonics: TectonicRegime;
  atmospherePressureBar: number;
  atmosphereKind: string; // e.g. 'none', 'thin CO2', 'N2', 'thick haze', 'SO2'
  seaKind: SeaKind;
}

/** One step of the formation history, for the UI timeline. */
export interface HistoryEvent {
  gyrAgo: number;
  stage: string; // short stage name, e.g. 'Bombardment'
  text: string; // human readable, e.g. '3 giant basins, largest 1,240 km (multi-ring)'
}

/** Geologic map unit (stored as id in climate.A), for the debug "geologic map" view. */
export interface GeoUnit {
  id: number;
  name: string;
  color: [number, number, number]; // sRGB 0..1
}

/** Renderer hints derived from the bulk planet. The viewer applies them when "auto look" is on. */
export interface LookHints {
  atmoDensity: number; // > 0 always (every world has some atmosphere); 1 = Earth-like column in renderer units
  atmoHeightKm: number;
  rayleigh: [number, number, number]; // scattering per km at the surface, units of 1e-3
  mie: number; // 1e-3 / km
  mieH: number; // km
  rayleighH: number; // km
  layerTints: [number, number, number][]; // linear multipliers per layer (8)
  seaKind: SeaKind;
  seaDeepColor: string; // hex
  seaShallowColor: string; // hex
  /** Prevailing-wind axis (unit) and how strongly the fine dune relief squeezes along it (0 = airless / cached planets). */
  windAxis?: [number, number, number];
  windAniso?: number;
  /** +1 bright wind streaks, -1 dark, 0 none. */
  windStreakSign?: number;
}

export interface PlanetInfo {
  archetype: string;
  name?: string;
  bulk: PlanetBulk;
  history: HistoryEvent[];
  units: GeoUnit[];
  look: LookHints;
  /** What each AUTO generator knob resolved to (keyed like GenParams). */
  resolved?: ResolvedParams;
  /** Named landmarks, strongest first. */
  pois?: Poi[];
}

/** A named landmark: kind (basin, volcano, rift, rise, chaos, crater, cap), unit direction, angular radius (rad). */
export interface Poi {
  kind: string;
  name: string;
  dir: [number, number, number];
  radius: number;
  rank: number;
  text: string;
}

/** Resolved values of AUTO generator knobs, keyed by GenParams field name. */
export type ResolvedParams = Record<string, number>;

export interface PlanetData {
  /** Interior resolution of each cube face (texels per side, gutters excluded). */
  N: number;
  /** Stored texels per side including the 1-texel gutter: N + 2. */
  T: number;
  /** Planet radius in metres (at datum / sea level). */
  radius: number;
  /** Elevation in metres relative to datum (sea level when there is a sea), 6*T*T floats. */
  height: Float32Array;
  minHeight: number;
  maxHeight: number;
  /** Splat weights for layers 0..3 (RGBA8), 6*T*T*4 bytes. splat0+splat1 channels sum to ~255 per texel. */
  splat0: Uint8Array;
  /** Splat weights for layers 4..7 (RGBA8), 6*T*T*4 bytes. */
  splat1: Uint8Array;
  /**
   * Auxiliary data, RGBA8, 6*T*T*4 bytes:
   * R = temperature (0 = 0 K .. 255 = 510 K, i.e. 2 K per step), G = volatile wetness / moisture (0..255),
   * B = water/lava flow accumulation (0..255, log scaled), A = geologic unit id (PlanetInfo.units).
   */
  climate: Uint8Array;
  /** Physical description, formation history and render hints. */
  info?: PlanetInfo;
  /** Wall-clock timings of generation stages in ms (for the UI). */
  timings?: Record<string, number>;
}
