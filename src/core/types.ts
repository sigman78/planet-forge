// Data contract between the generator (src/gen) and the renderer (src/render). See CONTRACT.md.

/** Terrain material layers, fixed order. Index = splat channel (0..3 in splat0 RGBA, 4..7 in splat1 RGBA). */
export const LAYERS = [
  'beach_sand', // 0  shore sand, also shallow seabed
  'grass', // 1  temperate grassland
  'forest', // 2  forest floor / moss / dense vegetation
  'dry_grass', // 3  savanna / steppe / dry soil
  'desert', // 4  desert sand / dunes (warm orange-red)
  'rock', // 5  cliffs, steep slopes, mountains
  'gravel', // 6  tundra scree / dark volcanic gravel / deep seabed
  'snow', // 7  snow & ice
] as const;
export type LayerName = (typeof LAYERS)[number];

export interface PlanetData {
  /** Interior resolution of each cube face (texels per side, gutters excluded). */
  N: number;
  /** Stored texels per side including the 1-texel gutter: N + 2. */
  T: number;
  /** Planet radius in metres (at sea level). */
  radius: number;
  /** Elevation in metres relative to sea level, 6*T*T floats. Sea level is always 0. */
  height: Float32Array;
  minHeight: number;
  maxHeight: number;
  /** Splat weights for layers 0..3 (RGBA8), 6*T*T*4 bytes. splat0+splat1 channels sum to ~255 per texel. */
  splat0: Uint8Array;
  /** Splat weights for layers 4..7 (RGBA8), 6*T*T*4 bytes. */
  splat1: Uint8Array;
  /**
   * Climate / auxiliary data, RGBA8, 6*T*T*4 bytes:
   * R = temperature (0 = -40C .. 255 = +40C), G = moisture (0..255),
   * B = water flow / wetness from erosion (0..255, log scaled), A = biome id (see gen BIOMES).
   */
  climate: Uint8Array;
  /** Cloud coverage cube, interior res cloudN, stored (cloudN+2)^2 per face, R8 (0..255). */
  cloudN: number;
  clouds: Uint8Array;
  /** Wall-clock timings of generation stages in ms (for the UI). */
  timings?: Record<string, number>;
}
