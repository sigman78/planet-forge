// World plan: archetype -> bulk planet -> formation-history feature lists, plus geologic units, look hints and
// the history timeline. Everything here is cheap and deterministic, so every worker rebuilds the same plan.
//
// Bodies are dwarf-planet / large-moon sized (≈200–900 km, 'wild' up to 1,800 km). Gravity is tiny, so relief
// scales up with 1/g (and the drama knob): basins, volcanoes and canyons read on the silhouette.

import type { GeoUnit, HistoryEvent, LookHints, PlanetBulk, PlanetInfo, Poi, ResolvedParams, SeaKind, TectonicRegime } from '../core/types.ts';
import { Rng } from './noise.ts';
import type { Noise3 } from './noise.ts';
import { ARCHETYPE_LABELS, pick } from './params.ts';
import type { Archetype, GenParams } from './params.ts';

// ---- geologic units (climate.A) ---------------------------------------------------------------------------

export const U = {
  HIGHLANDS: 0, BASIN_FLOOR: 1, BASIN_RIM: 2, MARE: 3, SHIELD: 4, RISE: 5, FLOWS: 6, CANYON: 7, CHAOS: 8,
  EJECTA: 9, RAYED: 10, DUNES: 11, POLAR_CAP: 12, FROZEN_SEA: 13, SEA: 14, PLAYA: 15, LINEATED_ICE: 16,
  FOSSAE: 17, SMOOTH_PLAINS: 18, LAVA_LAKE: 19, PLUME_DEPOSITS: 20, CRYO_DOME: 21, CRYO_FLOWS: 22, GROOVED: 23,
  PALIMPSEST: 24, CANTALOUPE: 25, FACULA: 26, BLOCK_MOUNTAIN: 27, FISSURE: 28, DIRTY_ICE: 29,
} as const;

export const GEO_UNITS: GeoUnit[] = [
  { id: 0, name: 'ancient cratered highlands', color: [0.72, 0.64, 0.52] },
  { id: 1, name: 'impact basin floor', color: [0.55, 0.5, 0.62] },
  { id: 2, name: 'multi-ring basin massifs', color: [0.62, 0.42, 0.32] },
  { id: 3, name: 'volcanic plains (mare)', color: [0.25, 0.3, 0.45] },
  { id: 4, name: 'shield volcano', color: [0.85, 0.28, 0.18] },
  { id: 5, name: 'volcanic rise', color: [0.9, 0.58, 0.36] },
  { id: 6, name: 'lava flows / patera', color: [0.52, 0.1, 0.1] },
  { id: 7, name: 'rift canyon', color: [0.48, 0.18, 0.58] },
  { id: 8, name: 'chaos terrain', color: [0.92, 0.55, 0.72] },
  { id: 9, name: 'ejecta blanket', color: [0.62, 0.62, 0.6] },
  { id: 10, name: 'fresh rayed crater', color: [1.0, 1.0, 0.82] },
  { id: 11, name: 'dune field', color: [0.92, 0.74, 0.38] },
  { id: 12, name: 'polar cap', color: [0.96, 0.98, 1.0] },
  { id: 13, name: 'frozen sea', color: [0.68, 0.84, 0.96] },
  { id: 14, name: 'brine sea', color: [0.12, 0.28, 0.6] },
  { id: 15, name: 'playa / evaporites', color: [0.98, 0.94, 0.78] },
  { id: 16, name: 'lineated ice plains', color: [0.74, 0.8, 0.86] },
  { id: 17, name: 'graben / scarps', color: [0.62, 0.42, 0.74] },
  { id: 18, name: 'smooth lowland plains', color: [0.78, 0.72, 0.6] },
  { id: 19, name: 'lava lake', color: [1.0, 0.36, 0.05] },
  { id: 20, name: 'plume / frost deposits', color: [0.96, 0.86, 0.22] },
  { id: 21, name: 'cryovolcanic dome', color: [0.45, 0.75, 0.95] },
  { id: 22, name: 'cryolava flows', color: [0.6, 0.88, 0.92] },
  { id: 23, name: 'grooved terrain', color: [0.82, 0.8, 0.62] },
  { id: 24, name: 'palimpsest', color: [0.9, 0.88, 0.8] },
  { id: 25, name: 'cantaloupe terrain', color: [0.7, 0.62, 0.5] },
  { id: 26, name: 'facula (bright salts)', color: [1.0, 1.0, 1.0] },
  { id: 27, name: 'block mountain', color: [0.55, 0.35, 0.22] },
  { id: 28, name: 'fissure (tiger stripe)', color: [0.2, 0.45, 0.85] },
  { id: 29, name: 'dark dirty ice', color: [0.42, 0.38, 0.34] },
];

// ---- archetypes --------------------------------------------------------------------------------------------

type Range = [number, number];
type SeaPref = 'none' | 'ice' | 'lava' | 'brine';
export type VolcStyle = 'shield' | 'patera' | 'cone' | 'dome' | 'cryo' | 'block';
type AtmoStyle = 'dusty' | 'co2haze' | 'sulfur' | 'exo' | 'exoIce' | 'n2haze';

export interface ArchDef {
  family: 'rocky' | 'ice' | 'volcanic' | 'cryovolcanic';
  radiusKm: Range; ironFrac: Range; volatileFrac: Range; ageGyr: Range; insolation: Range; tidal: Range;
  albedo: number;
  /** Crust is ice (splat base = ice) rather than silicate regolith. */
  icy: boolean;
  atmo: { kind: string; pressure: Range; molar: number; greenhouse: number; style: AtmoStyle };
  sea: SeaPref;
  /** Target sea area fraction when seaVolume is AUTO. */
  seaCoverage: Range;
  dichotomy: Range; basinCount: Range; basinSize: Range; craterDensity: Range; plumeCount: Range; volcanoScale: Range;
  style: VolcStyle; riseCount: Range; riftStrength: Range; scarps: Range; lineae: Range; chaos: Range;
  floodLevel: Range; erosion: Range; dunes: Range; salt: Range; rays: Range; polarCaps: Range;
  /** Crust relief multiplier (young ice shells are flat). */
  crustRelief: number;
  /** Viscous relaxation of large craters on ice-rich crust (0 = none, 1 = strong). */
  relax: number;
  /** Figure distortion range at drama 1 (triaxial stretch + lumps; warm young ice relaxes round). */
  figure: Range;
  palimpsests?: Range; grooveBands?: Range; cantaloupe?: boolean; stripes?: boolean; faculae?: Range; blocks?: Range;
  tints: [number, number, number][];
}

const GREY: [number, number, number] = [1, 1, 1];

export const ARCHETYPES: Record<Exclude<Archetype, 'wild'>, ArchDef> = {
  rust: {
    family: 'rocky', radiusKm: [350, 900], ironFrac: [0.18, 0.3], volatileFrac: [0.02, 0.06], ageGyr: [3.8, 4.6], insolation: [0.3, 0.6], tidal: [0, 0.5],
    albedo: 0.25, icy: false,
    atmo: { kind: 'thin CO2', pressure: [0.002, 0.012], molar: 44, greenhouse: 1, style: 'dusty' },
    sea: 'none', seaCoverage: [0, 0],
    dichotomy: [0.8, 1.3], basinCount: [1, 3], basinSize: [0.3, 0.5], craterDensity: [0.6, 0.9], plumeCount: [2, 5], volcanoScale: [0.9, 1.2],
    style: 'shield', riseCount: [1, 2], riftStrength: [0.8, 1.2], scarps: [0, 0.2], lineae: [0, 0], chaos: [0.5, 0.9],
    floodLevel: [0.05, 0.12], erosion: [0.5, 0.9], dunes: [0.8, 1.3], salt: [0.3, 0.6], rays: [1, 4], polarCaps: [0.8, 1.2],
    crustRelief: 1, figure: [0.8, 1.1], relax: 0, faculae: [0, 2],
    tints: [[1.0, 0.55, 0.34], [0.68, 0.44, 0.3], [1.0, 0.82, 0.76], [0.4, 0.31, 0.28], [1.1, 0.74, 0.56], [0.95, 0.66, 0.5], [1, 0.97, 0.95], [0.62, 0.45, 0.34]],
  },
  cinder: {
    family: 'rocky', radiusKm: [300, 1000], ironFrac: [0.55, 0.72], volatileFrac: [0, 0.004], ageGyr: [4.0, 4.6], insolation: [4, 9], tidal: [0, 0.3],
    albedo: 0.1, icy: false,
    atmo: { kind: 'Na/K exosphere', pressure: [1e-14, 1e-12], molar: 23, greenhouse: 0, style: 'exo' },
    sea: 'none', seaCoverage: [0, 0],
    dichotomy: [0.1, 0.3], basinCount: [1, 2], basinSize: [0.35, 0.5], craterDensity: [0.9, 1.2], plumeCount: [0, 3], volcanoScale: [0.4, 0.7],
    style: 'dome', riseCount: [0, 0], riftStrength: [0, 0], scarps: [1, 1.4], lineae: [0, 0], chaos: [0.6, 1],
    floodLevel: [0.18, 0.3], erosion: [0, 0], dunes: [0, 0], salt: [0.15, 0.35], rays: [5, 10], polarCaps: [0, 0],
    crustRelief: 0.8, figure: [0.6, 0.9], relax: 0,
    tints: [[0.5, 0.47, 0.43], [0.44, 0.42, 0.39], [0.85, 0.82, 0.8], [0.38, 0.36, 0.33], [0.75, 0.72, 0.68], [0.62, 0.6, 0.56], GREY, [0.62, 0.62, 0.64]],
  },
  'grey moon': {
    family: 'rocky', radiusKm: [200, 800], ironFrac: [0.03, 0.15], volatileFrac: [0, 0.01], ageGyr: [4.2, 4.6], insolation: [0.7, 1.3], tidal: [0, 0.3],
    albedo: 0.12, icy: false,
    atmo: { kind: 'argon exosphere', pressure: [1e-15, 1e-13], molar: 40, greenhouse: 0, style: 'exo' },
    sea: 'none', seaCoverage: [0, 0],
    dichotomy: [0.5, 0.9], basinCount: [2, 4], basinSize: [0.35, 0.7], craterDensity: [1.1, 1.5], plumeCount: [0, 3], volcanoScale: [0.3, 0.5],
    style: 'dome', riseCount: [0, 0], riftStrength: [0, 0.15], scarps: [0.1, 0.3], lineae: [0, 0], chaos: [0.3, 0.6],
    floodLevel: [0.14, 0.24], erosion: [0, 0], dunes: [0, 0], salt: [0, 0], rays: [6, 12], polarCaps: [0, 0],
    crustRelief: 1, figure: [0.45, 0.7], relax: 0,
    tints: [[0.66, 0.65, 0.64], [0.56, 0.56, 0.55], [0.95, 0.95, 1.0], [0.5, 0.5, 0.5], [0.95, 0.95, 0.95], [0.78, 0.78, 0.78], GREY, [0.68, 0.68, 0.68]],
  },
  'ice shell': {
    family: 'ice', radiusKm: [250, 900], ironFrac: [0.04, 0.12], volatileFrac: [0.35, 0.55], ageGyr: [4.3, 4.6], insolation: [0.03, 0.05], tidal: [4, 12],
    albedo: 0.65, icy: true,
    atmo: { kind: 'O2 exosphere', pressure: [1e-12, 1e-11], molar: 32, greenhouse: 0, style: 'exoIce' },
    sea: 'ice', seaCoverage: [0.02, 0.07],
    dichotomy: [0, 0.2], basinCount: [0, 1], basinSize: [0.15, 0.25], craterDensity: [0.04, 0.12], plumeCount: [0, 3], volcanoScale: [0.5, 0.9],
    style: 'cryo', riseCount: [0, 0], riftStrength: [0, 0.3], scarps: [0, 0], lineae: [0.9, 1.3], chaos: [0.8, 1.3],
    floodLevel: [0, 0], erosion: [0, 0], dunes: [0, 0], salt: [0.4, 0.8], rays: [1, 3], polarCaps: [0, 0],
    crustRelief: 0.35, figure: [0.2, 0.4], relax: 0.6,
    tints: [[0.82, 0.55, 0.38], [0.95, 0.9, 0.86], [0.6, 0.5, 0.45], [0.92, 0.9, 0.88], [0.8, 0.86, 0.94], [0.7, 0.6, 0.55], [0.95, 1.0, 1.08], [1.05, 0.78, 0.6]],
  },
  'old ice': {
    family: 'ice', radiusKm: [300, 900], ironFrac: [0.05, 0.15], volatileFrac: [0.35, 0.5], ageGyr: [4.3, 4.6], insolation: [0.03, 0.05], tidal: [0, 0.5],
    albedo: 0.2, icy: true,
    atmo: { kind: 'CO2 exosphere', pressure: [1e-12, 1e-11], molar: 44, greenhouse: 0, style: 'exoIce' },
    sea: 'none', seaCoverage: [0, 0],
    dichotomy: [0.2, 0.5], basinCount: [1, 2], basinSize: [0.3, 0.5], craterDensity: [1.3, 1.7], plumeCount: [0, 0], volcanoScale: [0, 0],
    style: 'dome', riseCount: [0, 0], riftStrength: [0, 0], scarps: [0, 0], lineae: [0.6, 1.0], chaos: [0, 0],
    floodLevel: [0, 0], erosion: [0, 0], dunes: [0, 0], salt: [0.2, 0.4], rays: [4, 8], polarCaps: [0, 0],
    crustRelief: 0.5, figure: [0.3, 0.5], relax: 1, palimpsests: [3, 7], grooveBands: [2, 4],
    tints: [[0.42, 0.36, 0.3], [0.62, 0.56, 0.5], [0.4, 0.36, 0.33], [0.7, 0.66, 0.62], [0.62, 0.66, 0.72], [0.4, 0.35, 0.3], [0.88, 0.9, 0.95], [1.0, 1.0, 1.04]],
  },
  sulfur: {
    family: 'volcanic', radiusKm: [400, 900], ironFrac: [0.18, 0.3], volatileFrac: [0.005, 0.02], ageGyr: [4.3, 4.6], insolation: [0.03, 0.06], tidal: [30, 60],
    albedo: 0.6, icy: false,
    atmo: { kind: 'patchy SO2', pressure: [1e-9, 1e-7], molar: 64, greenhouse: 0, style: 'sulfur' },
    sea: 'lava', seaCoverage: [0.01, 0.03],
    dichotomy: [0, 0.15], basinCount: [0, 0], basinSize: [0.2, 0.3], craterDensity: [0, 0.02], plumeCount: [45, 80], volcanoScale: [0.8, 1.2],
    style: 'patera', riseCount: [0, 0], riftStrength: [0, 0], scarps: [0, 0], lineae: [0, 0], chaos: [0, 0],
    floodLevel: [0.06, 0.12], erosion: [0, 0], dunes: [0, 0], salt: [1, 1.4], rays: [0, 0], polarCaps: [0, 0],
    crustRelief: 0.7, figure: [0.9, 1.2], relax: 0, blocks: [6, 11],
    tints: [[1.35, 1.05, 0.38], [1.15, 0.95, 0.55], [0.36, 0.3, 0.27], [1.2, 0.95, 0.5], [0.95, 0.72, 0.45], [0.9, 0.55, 0.32], [1.05, 1.05, 0.9], [1.3, 1.22, 0.55]],
  },
  basalt: {
    family: 'volcanic', radiusKm: [300, 900], ironFrac: [0.25, 0.35], volatileFrac: [0.01, 0.03], ageGyr: [1.0, 3.0], insolation: [0.6, 1.5], tidal: [5, 15],
    albedo: 0.15, icy: false,
    atmo: { kind: 'CO2 haze', pressure: [0.03, 0.3], molar: 44, greenhouse: 1, style: 'co2haze' },
    sea: 'lava', seaCoverage: [0.03, 0.08],
    dichotomy: [0.3, 0.7], basinCount: [0, 2], basinSize: [0.25, 0.4], craterDensity: [0.1, 0.25], plumeCount: [12, 24], volcanoScale: [0.8, 1.1],
    style: 'shield', riseCount: [1, 2], riftStrength: [0.8, 1.3], scarps: [0, 0], lineae: [0, 0], chaos: [0, 0.2],
    floodLevel: [0.3, 0.45], erosion: [0.5, 0.9], dunes: [0, 0.3], salt: [0.1, 0.3], rays: [0, 2], polarCaps: [0, 0],
    crustRelief: 0.9, figure: [0.8, 1.1], relax: 0,
    tints: [[0.62, 0.52, 0.46], [0.6, 0.52, 0.45], [0.8, 0.76, 0.76], [0.4, 0.36, 0.34], [0.85, 0.75, 0.68], [0.7, 0.6, 0.54], GREY, [0.9, 0.82, 0.62]],
  },
  cryo: {
    family: 'cryovolcanic', radiusKm: [200, 600], ironFrac: [0.03, 0.1], volatileFrac: [0.4, 0.6], ageGyr: [4.3, 4.6], insolation: [0.002, 0.05], tidal: [6, 20],
    albedo: 0.8, icy: true,
    atmo: { kind: 'faint N2', pressure: [5e-6, 2e-5], molar: 28, greenhouse: 0, style: 'n2haze' },
    sea: 'none', seaCoverage: [0, 0],
    dichotomy: [0.1, 0.3], basinCount: [0, 1], basinSize: [0.2, 0.35], craterDensity: [0.2, 0.5], plumeCount: [4, 9], volcanoScale: [1.0, 1.4],
    style: 'cryo', riseCount: [0, 0], riftStrength: [0.3, 0.7], scarps: [0, 0], lineae: [0.4, 0.8], chaos: [0.2, 0.5],
    floodLevel: [0, 0], erosion: [0, 0], dunes: [0, 0], salt: [0.9, 1.3], rays: [0, 2], polarCaps: [0, 0],
    crustRelief: 0.5, figure: [0.9, 1.25], relax: 0.7, cantaloupe: true, stripes: true,
    tints: [[0.75, 0.68, 0.66], [0.95, 0.94, 0.95], [0.6, 0.58, 0.6], [0.95, 0.92, 0.94], [0.78, 0.84, 0.94], [0.65, 0.62, 0.64], [0.96, 1.0, 1.06], [1.05, 0.9, 0.92]],
  },
};

const ARCH_KEYS = Object.keys(ARCHETYPES) as Exclude<Archetype, 'wild'>[];

/** 'wild': mixes ranges of all archetypes, bigger bodies allowed; the preset raises drama. */
function wildArch(rng: Rng): ArchDef {
  const base = ARCHETYPES[ARCH_KEYS[rng.int(ARCH_KEYS.length)]];
  const other = () => ARCHETYPES[ARCH_KEYS[rng.int(ARCH_KEYS.length)]];
  const out: ArchDef = { ...base };
  const keys: (keyof ArchDef)[] = ['ironFrac', 'volatileFrac', 'insolation', 'tidal', 'dichotomy', 'basinCount', 'basinSize', 'craterDensity',
    'plumeCount', 'volcanoScale', 'riseCount', 'riftStrength', 'scarps', 'chaos', 'floodLevel', 'erosion', 'dunes', 'salt', 'rays', 'polarCaps', 'lineae'];
  for (const k of keys) (out as unknown as Record<string, unknown>)[k] = (other() as unknown as Record<string, unknown>)[k];
  out.radiusKm = [200, 1800];
  out.figure = [1.25, 1.9];
  out.atmo = other().atmo;
  out.style = (['shield', 'patera', 'cone', 'dome', 'cryo'] as VolcStyle[])[rng.int(5)];
  if (out.style === 'patera' && out.plumeCount[1] < 20) out.plumeCount = [20, 50];
  // Rarely small frozen or briny lakes; otherwise whatever the base archetype does.
  const r = rng.next();
  if (r < 0.12) { out.sea = 'brine'; out.seaCoverage = [0.02, 0.06]; }
  else if (r < 0.25) { out.sea = 'ice'; out.seaCoverage = [0.02, 0.08]; }
  out.riseCount = [0, 2];
  out.palimpsests = rng.next() < 0.3 ? [2, 5] : undefined;
  out.grooveBands = rng.next() < 0.3 ? [1, 3] : undefined;
  out.cantaloupe = rng.next() < 0.25;
  out.stripes = out.icy && rng.next() < 0.5;
  out.faculae = [0, 3];
  const hue = rng.next() * Math.PI * 2;
  const tint = (s: number): [number, number, number] =>
    [1 + s * Math.cos(hue), 1 + s * Math.cos(hue + 2.1), 1 + s * Math.cos(hue + 4.2)];
  // Rocky layers darkened (texture means are 0.12-0.31 linear): wild worlds stay in a believable 0.08-0.25 albedo band.
  const b = out.icy ? 1 : 0.5 + 0.35 * rng.next();
  const dk = (t: [number, number, number], k: number): [number, number, number] => [t[0] * k, t[1] * k, t[2] * k];
  out.tints = [dk(tint(0.45), b), dk(tint(0.2), b * 0.85), [0.8, 0.77, 0.8], dk(tint(0.4), b * 0.7), dk(tint(0.15), b * 1.1), dk(tint(0.25), b), GREY, dk(tint(0.35), 0.8)];
  return out;
}

// ---- plan types ----------------------------------------------------------------------------------------------

export interface Disk { x: number; y: number; z: number; r: number }
/**
 * Giant impact basin. Beyond the disk: major axis (ax, ay, az) and eccentricity of oblique impacts, rim
 * irregularity, floor style (0 central peak, 1 peak ring, 2 flat infill, 3 deep bowl), age/degradation 0..1,
 * ring spacing and width (in basin radii), and a noise key for its azimuthal irregularity.
 */
export interface Basin extends Disk {
  depth: number; rings: number; peak: number; name: string;
  ax: number; ay: number; az: number; ecc: number; irr: number; floor: number; age: number; ringStep: number; ringW: number; key: number;
}
export interface Volcano extends Disk { h: number; style: VolcStyle; caldera: number; flowR: number; name: string }
export interface Rise extends Disk { h: number }
/** Great-circle arc trough: start s, plane normal n, length (rad), half-width (rad), depth (m). kind 0 canyon, 1 graben, 2 fissure. */
export interface Rift { sx: number; sy: number; sz: number; nx: number; ny: number; nz: number; len: number; w: number; depth: number; kind: number; name: string }
/** Arcuate thrust scarp on a small circle (angular radius rho) around pole c, azimuth a0..a0+a1. */
export interface Scarp { cx: number; cy: number; cz: number; rho: number; a0: number; a1: number; h: number; w: number; back: number; face: number }
export interface Chaos extends Disk { amp: number }
/**
 * Non-spherical figure (metres, relief scale applied): triaxial stretch along a random frame, low-order fbm lumps
 * and a few broad lobes / dents. Evaluated analytically per direction (figureAt) in the cube stage, after the
 * flood basalts and the feature limit, so maria and the limit work on the residual while seas pool in the lows.
 */
export interface Figure {
  /** Rows: three orthonormal axes. */
  axes: [number, number, number][];
  /** Triaxial coefficients (m) per axis: h = Σ e_i (d·a_i)² − Σe/3. */
  e: [number, number, number];
  lumpAmp: number;
  lumpFreq: number;
  /** Broad Gaussian lobes (+) and dents (−): centre, chord² width, amplitude (m). */
  blobs: { x: number; y: number; z: number; w2: number; a: number }[];
}

/** Figure height (m) at unit direction (x, y, z). Smooth (degree ≲ 4); `n` is the cube stage's figure noise. */
export function figureAt(f: Figure, n: Noise3, x: number, y: number, z: number): number {
  let h = -(f.e[0] + f.e[1] + f.e[2]) / 3;
  for (let k = 0; k < 3; k++) {
    const a = f.axes[k];
    const d = x * a[0] + y * a[1] + z * a[2];
    h += f.e[k] * d * d;
  }
  if (f.lumpAmp > 0) h += f.lumpAmp * n.fbm(x * f.lumpFreq + 3.7, y * f.lumpFreq - 8.1, z * f.lumpFreq + 0.9, 2);
  for (const b of f.blobs) {
    const c2 = (x - b.x) ** 2 + (y - b.y) ** 2 + (z - b.z) ** 2;
    h += b.a * Math.exp(-c2 / b.w2);
  }
  return h;
}

/** Band of parallel grooves along a great circle with normal n (Ganymede-style grooved terrain). */
export interface GrooveBand { nx: number; ny: number; nz: number; w: number; freq: number; amp: number }

export const CRATER_STRIDE = 8; // x y z r depth rim peak flag(0 plain, 1 rays, 2 facula)

export interface WorldPlan {
  p: GenParams;
  archetype: Archetype;
  arch: ArchDef;
  bulk: PlanetBulk;
  name: string;
  /** Orbital period around the giant parent in days (0 = not tidally locked to a giant). */
  orbitDays: number;
  tidal: number;
  /** Resolved values of all AUTO knobs, keyed like GenParams. */
  resolved: ResolvedParams;
  /** Resolved stage strengths (AUTO replaced). */
  s: {
    dichotomy: number; craterDensity: number; volcanoScale: number; riftStrength: number; scarps: number; lineae: number; chaos: number;
    floodLevel: number; erosion: number; dunes: number; salt: number; polarCaps: number;
  };
  /** 'coverage': sea level at an area percentile (archetype default), 'volume': from a global equivalent layer (m). */
  seaMode: 'none' | 'coverage' | 'volume';
  seaValue: number;
  relief: number;
  /**
   * Wildness cap factor from drama: every per-feature cap (fraction of R) and the stacked-relief limit scale with it
   * (0.45 at drama 0, 1.4 at 1, 2.35 at 2); horizontal footprint ceilings scale with its square root.
   */
  capK: number;
  /** Resolved figure distortion (0..2). */
  distortion: number;
  figure: Figure;
  /** Relief multiplier from low gravity (≈ (3.7/g)^0.3). */
  gRel: number;
  drama: number;
  icy: boolean;
  dichoAxis: [number, number, number];
  dichoAmp: number;
  crustAmp: number;
  basins: Basin[];
  oldCraters: Float64Array;
  youngCraters: Float64Array;
  rises: Rise[];
  volcanoes: Volcano[];
  rifts: Rift[];
  scarpList: Scarp[];
  chaosList: Chaos[];
  palimpsests: Disk[];
  grooves: GrooveBand[];
  cantaloupe: Disk | null;
  /** Latitude (rad) where the polar cap starts, north/south; > π/2 = none. */
  capLat: [number, number];
  capDome: number;
  stripes: boolean;
}

// ---- helpers ---------------------------------------------------------------------------------------------

const SYL1 = ['ar', 'ty', 'cal', 'hel', 'ol', 'mar', 'ne', 'sir', 'ab', 'ka', 'ves', 'ul', 'tha', 'ery', 'pan', 'ozo', 'ish', 'dor', 'ela', 'qu', 'ah', 'oc'];
const SYL2 = ['sia', 'ris', 'oris', 'las', 'ympus', 'ena', 'thea', 'dia', 'eon', 'ana', 'ilon', 'arra', 'mis', 'ura', 'ion', 'ax', 'ene', 'oth', 'una', 'ator'];
function makeName(rng: Rng): string {
  const n = SYL1[rng.int(SYL1.length)] + (rng.next() < 0.35 ? SYL1[rng.int(SYL1.length)] : '') + SYL2[rng.int(SYL2.length)];
  return n[0].toUpperCase() + n.slice(1);
}

const G = 6.674e-11;

function between(rng: Rng, r: Range): number {
  return r[0] + (r[1] - r[0]) * rng.next();
}
function logBetween(rng: Rng, r: Range): number {
  if (r[0] <= 0) return between(rng, r);
  return Math.exp(Math.log(r[0]) + (Math.log(r[1]) - Math.log(r[0])) * rng.next());
}
function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
/** Soft cap: ≈x for x ≪ c, approaches c. */
function softcap(x: number, c: number): number {
  return (c * x) / (x + c);
}
function randomUnit(rng: Rng): [number, number, number] {
  const v = new Float64Array(3);
  rng.unitVec(v);
  return [v[0], v[1], v[2]];
}
function norm3(x: number, y: number, z: number): [number, number, number] {
  const l = 1 / (Math.hypot(x, y, z) || 1);
  return [x * l, y * l, z * l];
}
function cross(a: number[], b: number[]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
/** Point at angular distance `ang` from c, at azimuth `az` (in a fixed tangent frame of c). */
export function offsetDir(c: number[], ang: number, az: number): [number, number, number] {
  const ref = Math.abs(c[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const e1 = norm3(...cross(ref, c));
  const e2 = cross(c, e1);
  const ca = Math.cos(ang), sa = Math.sin(ang), cz = Math.cos(az), sz = Math.sin(az);
  return norm3(c[0] * ca + (e1[0] * cz + e2[0] * sz) * sa, c[1] * ca + (e1[1] * cz + e2[1] * sz) * sa, c[2] * ca + (e1[2] * cz + e2[2] * sz) * sa);
}
/** Point at distance t along the great circle starting at s with plane normal n. */
function along(s: number[], n: number[], t: number): [number, number, number] {
  const d = cross(n, s);
  return norm3(s[0] * Math.cos(t) + d[0] * Math.sin(t), s[1] * Math.cos(t) + d[1] * Math.sin(t), s[2] * Math.cos(t) + d[2] * Math.sin(t));
}

// ---- bulk ------------------------------------------------------------------------------------------------

export function computeBulk(p: GenParams, arch: ArchDef, rng: Rng): { bulk: PlanetBulk; tidal: number } {
  const radiusKm = pick(p.radiusKm, between(rng, arch.radiusKm));
  let ironFrac = pick(p.ironFrac, between(rng, arch.ironFrac));
  let volatileFrac = pick(p.volatileFrac, between(rng, arch.volatileFrac));
  if (ironFrac + volatileFrac > 0.92) { const k = 0.92 / (ironFrac + volatileFrac); ironFrac *= k; volatileFrac *= k; }
  const ageGyr = pick(p.ageGyr, between(rng, arch.ageGyr));
  const insolation = pick(p.insolation, logBetween(rng, arch.insolation));
  const tidal = pick(p.tidalHeating, between(rng, arch.tidal));
  const sil = 1 - ironFrac - volatileFrac;
  const densityGcc = 1 / (ironFrac / 7.9 + sil / 3.3 + volatileFrac / 0.95);
  const R = radiusKm * 1000;
  const mass = (4 / 3) * Math.PI * R * R * R * densityGcc * 1000;
  const gravity = (G * mass) / (R * R);
  const coreRadiusFrac = Math.cbrt(Math.min(0.95, (ironFrac * densityGcc) / 7.9));
  const teq = 278.6 * Math.pow(insolation, 0.25) * Math.pow(1 - arch.albedo, 0.25);
  // Radiogenic heat scales with size (surface/volume) and decays with age; tidal heating adds on top.
  const radiogenic = ((radiusKm / 6371) * (0.4 + 0.6 * Math.exp(-ageGyr / 2.8))) / 0.52;
  const heatFlow = radiogenic * (1 + tidal);
  let tectonics: TectonicRegime = 'stagnant';
  if (heatFlow > 1.5) tectonics = 'episodic';
  if (heatFlow > 4 && radiusKm > 1200 && volatileFrac > 0.01) tectonics = 'mobile';
  // Atmosphere retention: escape velocity vs thermal speed at a warm exobase (Jeans-like). Designed atmospheres
  // keep a floor so the archetype still reads (small bodies are "slightly unrealistic" on purpose).
  const vEsc = Math.sqrt((2 * G * mass) / R);
  const vTh = Math.sqrt((2 * 1.380649e-23 * teq * 2) / (arch.atmo.molar * 1.6605e-27));
  const retention = Math.max(0.35, smooth(4, 10, vEsc / vTh));
  const atmospherePressureBar = logBetween(rng, arch.atmo.pressure) * retention;
  const surfaceTempK = teq + arch.atmo.greenhouse * 30 * Math.log2(1 + atmospherePressureBar);
  let seaKind: SeaKind = 'none';
  const want: SeaPref = p.seaVolume > 0 && arch.sea === 'none' ? 'brine' : arch.sea;
  if (want === 'lava') seaKind = 'lava';
  else if (want === 'ice') seaKind = 'ice';
  else if (want === 'brine') seaKind = surfaceTempK > 252 && surfaceTempK < 380 ? 'water' : 'ice';
  if (p.seaVolume === 0) seaKind = 'none';
  return {
    bulk: {
      radiusKm, massEarth: mass / 5.972e24, densityGcc, gravity, coreRadiusFrac, ironFrac, volatileFrac, ageGyr, insolation,
      surfaceTempK, heatFlow, tectonics, atmospherePressureBar, atmosphereKind: arch.atmo.kind, seaKind,
    },
    tidal,
  };
}

// ---- craters ---------------------------------------------------------------------------------------------

/** Truncated power-law crater list (radius in rad), largest first. Depth follows the simple→complex transition, which moves to larger craters at low gravity. */
function makeCraters(rng: Rng, count: number, rMin: number, rMax: number, Rkm: number, g: number, relief: number, relax: number,
  rays: number, faculae: number): Float64Array {
  const out = new Float64Array(count * CRATER_STRIDE);
  const alpha = 1.75;
  const q = Math.pow(rMin / rMax, alpha);
  const tmp = new Float64Array(3);
  const halfT = 14 / g; // transition radius (km) ~ 29/g km diameter (Moon: 18 km)
  const depthOf = (rk: number) => (relief * 400 * rk) / (1 + rk / halfT) / (1 + relax * Math.pow(rk / 25, 1.4));
  for (let i = 0; i < count; i++) {
    rng.unitVec(tmp);
    const r = rMin * Math.pow(1 - rng.next() * (1 - q), -1 / alpha);
    const rk = r * Rkm;
    const o = i * CRATER_STRIDE;
    out[o] = tmp[0]; out[o + 1] = tmp[1]; out[o + 2] = tmp[2];
    out[o + 3] = r;
    out[o + 4] = depthOf(rk) * (0.75 + 0.5 * rng.next());
    out[o + 5] = 0.2 + 0.12 * rng.next();
    out[o + 6] = rk > halfT * 0.7 ? 0.3 + 0.35 * rng.next() : 0;
    out[o + 7] = 0;
  }
  const idx = Array.from({ length: count }, (_, i) => i).sort((a, b) => out[b * CRATER_STRIDE + 3] - out[a * CRATER_STRIDE + 3] || a - b);
  const sorted = new Float64Array(out.length);
  idx.forEach((src, dst) => sorted.set(out.subarray(src * CRATER_STRIDE, (src + 1) * CRATER_STRIDE), dst * CRATER_STRIDE));
  // Fresh rayed craters and bright-floored (facula) craters: a few of the larger young ones.
  let k = Math.floor(count * 0.01);
  const flag = (n: number, v: number, rLo: number) => {
    for (let i = 0; i < n && k < count; i++, k++) {
      const o = k * CRATER_STRIDE;
      sorted[o + 7] = v;
      sorted[o + 3] = Math.max(sorted[o + 3], rLo * (1 + rng.next()));
      sorted[o + 4] = depthOf(sorted[o + 3] * Rkm);
    }
  };
  flag(rays, 1, 0.012);
  flag(faculae, 2, 0.03);
  return sorted;
}

// ---- plan ------------------------------------------------------------------------------------------------

export function planWorld(p: GenParams): WorldPlan {
  const archetype = p.archetype;
  const arch = archetype === 'wild' ? wildArch(new Rng(p.seed, 2)) : ARCHETYPES[archetype];
  const { bulk, tidal } = computeBulk(p, arch, new Rng(p.seed, 1));
  const sr = new Rng(p.seed, 3);
  const drama = p.drama;
  const relief = p.reliefScale;
  const g = bulk.gravity;
  const gRel = Math.min(3, Math.pow(3.7 / g, 0.3));
  const Rkm = bulk.radiusKm;
  const R = Rkm * 1000;
  // Wildness: all relief caps (fractions of R) scale together, so lifting one never just hits the next.
  const wild = Math.min(2, drama);
  const capK = 0.45 + 0.95 * wild;
  const hs = Math.sqrt(capK); // horizontal footprint ceilings (keeps slopes sane as caps rise)
  const val = (v: number, r: Range) => pick(v, between(sr, r));
  const s = {
    dichotomy: val(p.dichotomy, arch.dichotomy),
    craterDensity: val(p.craterDensity, arch.craterDensity),
    volcanoScale: val(p.volcanoScale, arch.volcanoScale),
    riftStrength: val(p.riftStrength, arch.riftStrength),
    scarps: val(p.scarps, arch.scarps),
    lineae: val(p.lineae, arch.lineae),
    chaos: val(p.chaos, arch.chaos),
    floodLevel: Math.min(0.6, val(p.floodLevel, arch.floodLevel)),
    erosion: val(p.erosion, arch.erosion),
    dunes: val(p.dunes, arch.dunes),
    salt: val(p.salt, arch.salt),
    polarCaps: val(p.polarCaps, arch.polarCaps),
  };
  // Running liquids and wind need an atmosphere (unless the user forces them).
  if (bulk.atmospherePressureBar < 1e-3) { if (p.erosion < 0) s.erosion = 0; if (p.dunes < 0) s.dunes = 0; }
  const seaCov = between(sr, arch.seaCoverage);
  let seaMode: WorldPlan['seaMode'] = 'none';
  let seaValue = 0;
  if (bulk.seaKind !== 'none') {
    if (p.seaVolume > 0) { seaMode = 'volume'; seaValue = p.seaVolume; }
    else if (p.seaVolume < 0 && seaCov > 0) { seaMode = 'coverage'; seaValue = seaCov; }
  }
  const basinCount = Math.round(pick(p.basinCount, between(sr, arch.basinCount)));
  const basinSize = pick(p.basinSize, between(sr, arch.basinSize));
  const heatBoost = Math.min(2, Math.max(0.4, Math.sqrt(bulk.heatFlow / Math.max(0.05, (1 + (arch.tidal[0] + arch.tidal[1]) / 2) * 0.1))));
  const plumeCount = Math.round(pick(p.plumeCount, between(sr, arch.plumeCount) * (arch.plumeCount[1] > 0 ? Math.min(1.3, Math.max(0.7, heatBoost)) : 1)));
  const riseCount = Math.round(pick(p.riseCount, between(sr, arch.riseCount)));
  const rayCount = Math.round(pick(p.rays, between(sr, arch.rays)));
  const faculaCount = arch.faculae ? Math.round(between(sr, arch.faculae)) : 0;
  const name = makeName(new Rng(p.seed, 9));
  const nameRng = new Rng(p.seed, 10);
  const orbitDays = tidal > 1 ? 1 + 6 / Math.sqrt(tidal / 2) * (0.7 + 0.6 * sr.next()) : 0;

  // --- crust: dichotomy + low-degree crustal thickness ---
  const dichoAxis = randomUnit(new Rng(p.seed, 4));
  const dichoAmp = s.dichotomy * 2600 * relief * arch.crustRelief * gRel * (0.6 + 0.4 * wild);
  const crustAmp = 1300 * relief * arch.crustRelief * gRel * (0.6 + 0.4 * wild);

  // --- figure: triaxial stretch + lumps + lobes. Smaller bodies are lumpier; drama and the archetype set the AUTO value ---
  const frng = new Rng(p.seed, 13);
  const distortion = Math.min(2, pick(p.distortion, between(frng, arch.figure) * (0.4 + 0.6 * wild)));
  // Big bodies pull themselves rounder ('wild' ignores that: even 1,800 km wild worlds stay potatoes).
  const sizeK = Math.max(archetype === 'wild' ? 1 : 0, 0.7 + 0.6 * smooth(1200, 200, Rkm));
  const figR = R * relief * distortion * sizeK;
  const ax0 = randomUnit(frng);
  const ax1 = norm3(...cross(ax0, randomUnit(frng)));
  const ax2 = cross(ax0, ax1);
  const triA = 0.023 * figR;
  const figure: Figure = {
    axes: [ax0, ax1, ax2],
    e: [triA, triA * (-0.35 + 0.8 * frng.next()), -triA * (0.55 + 0.45 * frng.next())],
    lumpAmp: 0.018 * figR, lumpFreq: 0.9 + 0.5 * frng.next(), blobs: [],
  };
  const nBlobs = Math.round(1 + 2 * distortion + frng.next());
  for (let i = 0; i < nBlobs; i++) {
    const c = randomUnit(frng);
    const wr = 0.35 + 0.5 * frng.next(); // angular width (rad) ≈ chord width
    figure.blobs.push({ x: c[0], y: c[1], z: c[2], w2: wr * wr, a: (frng.next() < 0.55 ? 1 : -1) * (0.4 + 0.6 * frng.next()) * 0.02 * figR });
  }

  // --- giant basins (depth scales with body size, capped for silhouettes) ---
  const brng = new Rng(p.seed, 5);
  const basins: Basin[] = [];
  // Each basin also rolls its own impact story from a separate stream (so positions stay put): oblique or not,
  // what the floor rebounded into, how many rings survived, and how old and worn it is.
  const vr = new Rng(p.seed, 21);
  for (let i = 0; i < basinCount; i++) {
    const c = randomUnit(brng);
    const r = basinSize * (i === 0 ? 0.6 + 0.4 * vr.next() : 0.4 + 0.45 * brng.next());
    const depth = Math.min(0.07 * capK * R, R * (0.025 + 0.025 * brng.next()) * Math.sqrt(r / 0.4) * (0.6 + 0.4 * drama)) * relief / (1 + arch.relax * 1.5);
    const peakH = depth * (0.5 + 0.4 * brng.next()) * (0.6 + 0.4 * drama);
    // Oblique impacts: an elongated basin with butterfly ejecta along the major axis.
    const obl = p.basinOblique >= 0 ? p.basinOblique * (0.7 + 0.3 * vr.next()) : vr.next() < 0.35 ? 0.3 + 0.7 * vr.next() : 0.15 * vr.next();
    const t = randomUnit(vr);
    const td = t[0] * c[0] + t[1] * c[1] + t[2] * c[2];
    const tl = Math.hypot(t[0] - td * c[0], t[1] - td * c[1], t[2] - td * c[2]) || 1;
    // Floor: 0 central peak, 1 peak ring, 2 flat (infilled), 3 deep bowl. Big basins favour peak rings.
    const fr = vr.next();
    const floor = r > 0.3 ? (fr < 0.25 ? 0 : fr < 0.6 ? 1 : fr < 0.85 ? 2 : 3) : r > 0.15 ? (fr < 0.45 ? 0 : fr < 0.7 ? 1 : fr < 0.9 ? 2 : 3) : fr < 0.6 ? 0 : 3;
    const maxRings = r > 0.15 ? 4 : 1;
    const rings = p.basinRings >= 0 ? Math.min(maxRings, Math.round(p.basinRings * (r > 0.15 ? 1 : 0.4))) : vr.int(maxRings + 1);
    const age = p.basinAge >= 0 ? Math.min(1, p.basinAge * (0.8 + 0.4 * vr.next())) : i === 0 ? 0.55 * vr.next() : vr.next();
    basins.push({
      x: c[0], y: c[1], z: c[2], r, depth, rings, peak: floor === 0 || floor === 1 ? peakH : 0,
      ax: (t[0] - td * c[0]) / tl, ay: (t[1] - td * c[1]) / tl, az: (t[2] - td * c[2]) / tl,
      ecc: 0.4 * Math.min(1, obl), irr: 0.04 + 0.1 * vr.next(), floor, age,
      ringStep: 0.28 + 0.27 * vr.next(), ringW: 0.03 + 0.04 * vr.next(), key: vr.next() * 97,
      name: makeName(nameRng) + (arch.icy ? ' Regio' : ' Planitia'),
    });
  }

  // --- craters: count is per steradian (angular sizes), old ones before the floods, young ones after ---
  const crng = new Rng(p.seed, 6);
  const totalCraters = Math.round(s.craterDensity * 3000 * Math.min(1, bulk.ageGyr / 4));
  const youngN = Math.round(totalCraters * 0.07) + rayCount + faculaCount;
  const oldN = Math.max(0, totalCraters - youngN + rayCount + faculaCount);
  const rMax = 0.12 * (0.7 + 0.6 * crng.next());
  const rMin = 0.0055;
  const oldCraters = makeCraters(crng, oldN, rMin, rMax, Rkm, g, relief, arch.relax, 0, 0);
  const youngCraters = makeCraters(crng, youngN, rMin, rMax * 0.5, Rkm, g, relief, arch.relax * 0.3, rayCount, faculaCount);

  // --- volcanic rises (prefer the dichotomy boundary, Tharsis style) ---
  const vrng = new Rng(p.seed, 7);
  const rises: Rise[] = [];
  for (let i = 0; i < riseCount; i++) {
    const c = offsetDir(dichoAxis, Math.PI / 2 + (vrng.next() - 0.5) * 0.5, vrng.next() * Math.PI * 2);
    const r = 0.32 + 0.25 * vrng.next();
    const h = softcap((4500 + 4000 * vrng.next()) * Math.sqrt(Math.max(0.1, s.volcanoScale)) * (0.5 + 0.5 * drama) * Math.pow(3.7 / g, 0.35), 0.05 * capK * R) * relief;
    rises.push({ x: c[0], y: c[1], z: c[2], r, h });
  }

  // --- volcanoes: heights scale ~1/g (soft-capped to a fraction of the radius), drama exaggerates ---
  const volcanoes: Volcano[] = [];
  const gScale = Math.pow(3.7 / g, 0.7);
  const dr = Math.pow(Math.max(0.05, drama), 1.2);
  for (let i = 0; i < plumeCount; i++) {
    let c: [number, number, number];
    if (rises.length > 0 && vrng.next() < 0.65) {
      const rs = rises[vrng.int(rises.length)];
      c = offsetDir([rs.x, rs.y, rs.z], rs.r * (0.1 + 0.65 * vrng.next()), vrng.next() * Math.PI * 2);
    } else c = randomUnit(vrng);
    const style: VolcStyle = arch.style === 'patera' && vrng.next() < 0.12 ? 'cone' : arch.style;
    const size = Math.pow(vrng.next(), 1.5); // most volcanoes small, a few giants
    const big = i === 0 ? 1 : 0.3 + 0.7 * size;
    let h: number, rr: number;
    if (style === 'shield') {
      h = softcap(21000 * gScale * s.volcanoScale * dr, 0.07 * capK * R) * big * relief;
      rr = Math.min(0.4 * hs, (h / 0.08) / R * (0.8 + 0.4 * vrng.next()));
    } else if (style === 'patera') {
      h = (500 + 1500 * size) * Math.pow(gScale, 0.3) * relief * s.volcanoScale;
      rr = 0.012 + 0.035 * size;
    } else if (style === 'cone') {
      h = softcap(8000 * gScale * s.volcanoScale * dr, 0.045 * capK * R) * big * relief;
      rr = Math.min(0.15 * hs, (h / 0.18) / R);
    } else if (style === 'cryo') {
      h = softcap(9000 * gScale * s.volcanoScale * dr, 0.055 * capK * R) * big * relief;
      rr = Math.min(0.2 * hs, (h / 0.15) / R * (0.8 + 0.4 * vrng.next()));
    } else {
      h = softcap(3000 * gScale * s.volcanoScale * dr, 0.03 * capK * R) * big * relief;
      rr = Math.min(0.12 * hs, (h / 0.1) / R);
    }
    if (h <= 0) continue;
    rr = Math.max(rr, 0.01);
    volcanoes.push({
      x: c[0], y: c[1], z: c[2], r: rr, h, style,
      caldera: style === 'patera' ? 0.55 + 0.2 * vrng.next() : style === 'cryo' ? 0.05 + 0.06 * vrng.next() : 0.08 + 0.1 * vrng.next(),
      flowR: style === 'patera' ? 2.2 + 1.8 * vrng.next() : style === 'cryo' ? 2.4 + 1.4 * vrng.next() : style === 'shield' ? 1.5 + 0.6 * vrng.next() : 1.3,
      name: makeName(nameRng) + (style === 'patera' ? ' Patera' : style === 'cryo' ? ' Tholus' : ' Mons'),
    });
  }
  // Io-style block mountains: tall thrust-faulted crustal blocks, not volcanoes.
  const nBlocks = arch.blocks ? Math.round(between(vrng, arch.blocks)) : 0;
  for (let i = 0; i < nBlocks; i++) {
    const c = randomUnit(vrng);
    const h = softcap(22000 * Math.pow(gScale, 0.4) * dr * (0.5 + 0.5 * vrng.next()), 0.05 * capK * R) * relief;
    volcanoes.push({ x: c[0], y: c[1], z: c[2], r: (0.05 + 0.06 * vrng.next()) * hs, h, style: 'block', caldera: vrng.next() * Math.PI * 2, flowR: 1, name: makeName(nameRng) + ' Mons' });
  }

  // --- rifts, canyons, graben, fissures ---
  const trng = new Rng(p.seed, 8);
  const rifts: Rift[] = [];
  const chaosList: Chaos[] = [];
  const canyonCount = s.riftStrength > 0.05 && !arch.icy ? (rises.length > 0 ? 1 + (trng.next() < 0.3 * s.riftStrength ? 1 : 0) : trng.next() < s.riftStrength * 0.6 ? 1 : 0) : 0;
  for (let i = 0; i < canyonCount; i++) {
    let from: [number, number, number], start: [number, number, number];
    if (rises.length > 0) {
      const rs = rises[i % rises.length];
      from = [rs.x, rs.y, rs.z];
      start = offsetDir(from, rs.r * 0.45, trng.next() * Math.PI * 2);
    } else { from = randomUnit(trng); start = offsetDir(from, 0.2, trng.next() * Math.PI * 2); }
    const n = norm3(...cross(from, start));
    const len = (0.7 + 0.6 * trng.next()) * Math.min(1.4, 0.7 + 0.3 * drama);
    const w = (0.03 + 0.02 * trng.next()) * (0.8 + 0.2 * drama) * hs;
    const depth = softcap((5000 + 3500 * trng.next()) * s.riftStrength * gRel * (0.6 + 0.4 * drama), 0.045 * capK * R) * relief;
    rifts.push({ sx: start[0], sy: start[1], sz: start[2], nx: n[0], ny: n[1], nz: n[2], len, w, depth, kind: 0, name: makeName(nameRng) + ' Chasma' });
    // Parallel chasmata.
    const extra = 1 + trng.int(3);
    for (let k = 0; k < extra; k++) {
      const off = (k % 2 === 0 ? 1 : -1) * w * (2.2 + 1.2 * trng.next());
      const s0 = along(start, n, len * (0.1 + 0.4 * trng.next()));
      const s1 = norm3(s0[0] + n[0] * off, s0[1] + n[1] * off, s0[2] + n[2] * off);
      const n1 = norm3(n[0] - s1[0] * off, n[1] - s1[1] * off, n[2] - s1[2] * off);
      rifts.push({ sx: s1[0], sy: s1[1], sz: s1[2], nx: n1[0], ny: n1[1], nz: n1[2], len: len * (0.25 + 0.3 * trng.next()), w: w * (0.5 + 0.3 * trng.next()), depth: depth * 0.6, kind: 0, name: '' });
    }
    // Chaos at the far end (outflow source).
    if (s.chaos > 0.1) {
      const e = along(start, n, len);
      chaosList.push({ x: e[0], y: e[1], z: e[2], r: 0.08 + 0.05 * trng.next(), amp: 1500 * relief * s.chaos * gRel });
    }
  }
  // Radial graben around rises, and in the largest basin on cinder worlds (Pantheon Fossae).
  const grabenSources: { c: number[]; r0: number; r1: number; n: number }[] = [];
  for (const rs of rises) grabenSources.push({ c: [rs.x, rs.y, rs.z], r0: rs.r * 0.6, r1: rs.r * 2.2, n: Math.round(8 + 10 * Math.min(1.5, s.riftStrength + 0.3)) });
  if (archetype === 'cinder' && basins.length > 0) grabenSources.push({ c: [basins[0].x, basins[0].y, basins[0].z], r0: 0.03, r1: basins[0].r * 0.8, n: 22 });
  for (const gs of grabenSources) {
    for (let k = 0; k < gs.n; k++) {
      const st = offsetDir(gs.c, gs.r0 * (0.8 + 0.4 * trng.next()), (k / gs.n) * Math.PI * 2 + trng.next() * 0.25);
      const n = norm3(...cross(gs.c, st));
      rifts.push({ sx: st[0], sy: st[1], sz: st[2], nx: n[0], ny: n[1], nz: n[2], len: (gs.r1 - gs.r0) * (0.5 + 0.5 * trng.next()), w: 0.004 + 0.003 * trng.next(), depth: (400 + 600 * trng.next()) * relief * gRel, kind: 1, name: '' });
    }
  }
  // Long cryovolcanic fissures ("tiger stripes") around one pole; also big icy rift systems for cryo worlds.
  const stripes = !!arch.stripes && (archetype !== 'wild' || bulk.heatFlow > 0.5);
  if (stripes) {
    const pole: [number, number, number] = [0, trng.next() < 0.5 ? -1 : 1, 0];
    const az = trng.next() * Math.PI;
    const cnt = 4 + trng.int(2);
    const spacing = 0.07 + 0.03 * trng.next();
    const len = 0.7 + 0.5 * trng.next() * drama;
    for (let k = 0; k < cnt; k++) {
      const mid = offsetDir(pole, (k - (cnt - 1) / 2) * spacing, az + Math.PI / 2);
      const a = offsetDir(mid, len / 2, az);
      const b = offsetDir(mid, len / 2, az + Math.PI);
      const n = norm3(...cross(a, b));
      rifts.push({ sx: a[0], sy: a[1], sz: a[2], nx: n[0], ny: n[1], nz: n[2], len, w: 0.006 + 0.002 * drama, depth: 700 * relief * gRel * drama, kind: 2, name: k === 0 ? makeName(nameRng) + ' Sulci' : '' });
    }
  }
  if (arch.icy && s.riftStrength > 0.2) {
    const n = Math.round(2 + 3 * s.riftStrength);
    for (let k = 0; k < n; k++) {
      const st = randomUnit(trng);
      const nn = norm3(...cross(st, randomUnit(trng)));
      rifts.push({ sx: st[0], sy: st[1], sz: st[2], nx: nn[0], ny: nn[1], nz: nn[2], len: 0.5 + 0.8 * trng.next(), w: 0.012 + 0.012 * trng.next(), depth: (1500 + 2500 * trng.next()) * relief * gRel * s.riftStrength, kind: 0, name: k === 0 ? makeName(nameRng) + ' Chasma' : '' });
    }
  }

  // --- lobate scarps (global contraction as the core cools) ---
  const scarpList: Scarp[] = [];
  const nScarps = Math.round(s.scarps * 14);
  for (let i = 0; i < nScarps; i++) {
    const c = randomUnit(trng);
    scarpList.push({
      cx: c[0], cy: c[1], cz: c[2], rho: 0.2 + 0.45 * trng.next(), a0: trng.next() * Math.PI * 2, a1: 0.5 + 1.1 * trng.next(),
      h: softcap((1200 + 2000 * trng.next()) * gRel * drama, 0.015 * capK * R) * relief, w: (0.006 + 0.006 * trng.next()) * hs, back: (0.05 + 0.06 * trng.next()) * hs, face: trng.next() < 0.5 ? 1 : -1,
    });
  }

  // --- chaos patches (ice shells: melt-through) and antipodal chaos for giant basins ---
  const nChaos = arch.icy ? Math.round(s.chaos * 6) : 0;
  for (let i = 0; i < nChaos; i++) {
    const c = randomUnit(trng);
    chaosList.push({ x: c[0], y: c[1], z: c[2], r: 0.06 + 0.1 * trng.next(), amp: 700 * relief * gRel });
  }
  // Antipodal chaos needs focused seismic waves: likely but not certain (vr: drawn after the basin rolls).
  if (basins.length > 0 && basins[0].r > 0.25 && s.chaos > 0.1 && vr.next() < 0.6) {
    const b = basins[0];
    chaosList.push({ x: -b.x, y: -b.y, z: -b.z, r: b.r * 0.55, amp: 1400 * relief * s.chaos * gRel });
  }

  // --- old-ice extras: palimpsests and grooved bands; cryo: cantaloupe terrain ---
  const xr = new Rng(p.seed, 12);
  const palimpsests: Disk[] = [];
  const np = arch.palimpsests ? Math.round(between(xr, arch.palimpsests)) : 0;
  for (let i = 0; i < np; i++) { const c = randomUnit(xr); palimpsests.push({ x: c[0], y: c[1], z: c[2], r: 0.08 + 0.12 * xr.next() }); }
  const grooves: GrooveBand[] = [];
  const ng = arch.grooveBands ? Math.round(between(xr, arch.grooveBands) * Math.max(0.3, s.lineae)) : 0;
  for (let i = 0; i < ng; i++) {
    const n = randomUnit(xr);
    grooves.push({ nx: n[0], ny: n[1], nz: n[2], w: 0.08 + 0.12 * xr.next(), freq: 90 + 70 * xr.next(), amp: (400 + 500 * xr.next()) * relief * gRel });
  }
  let cantaloupe: Disk | null = null;
  if (arch.cantaloupe) { const c = randomUnit(xr); cantaloupe = { x: c[0], y: c[1], z: c[2], r: 0.5 + 0.4 * xr.next() }; }

  // --- polar caps (layered domes) ---
  const poleT = bulk.surfaceTempK * 0.78;
  const capsAllowed = s.polarCaps > 0 && bulk.volatileFrac > 0.005 && poleT < 250 && !arch.icy;
  const capLat: [number, number] = capsAllowed
    ? [(90 - 9 * s.polarCaps * (1.1 + 0.3 * trng.next())) * Math.PI / 180, (90 - 7 * s.polarCaps * (0.8 + 0.3 * trng.next())) * Math.PI / 180]
    : [10, 10];
  const capDome = capsAllowed ? softcap(2500 * gRel, 0.012 * capK * R) * relief * Math.min(1.5, s.polarCaps) : 0;

  // What every AUTO knob resolved to, for the UI (sea volume is only known after the terrain; see buildInfo).
  const resolved: ResolvedParams = {
    distortion, radiusKm: bulk.radiusKm, ironFrac: bulk.ironFrac, volatileFrac: bulk.volatileFrac, ageGyr: bulk.ageGyr,
    insolation: bulk.insolation, tidalHeating: tidal, ...s, basinCount, basinSize, plumeCount, riseCount, rays: rayCount,
    basinOblique: basins.length ? basins[0].ecc / 0.4 : 0, basinRings: basins.length ? basins[0].rings : 0, basinAge: basins.length ? basins[0].age : 0,
  };
  if (seaMode === 'volume' || bulk.seaKind === 'none') resolved.seaVolume = seaMode === 'volume' ? seaValue : 0;

  return {
    resolved,
    p, archetype, arch, bulk, name, orbitDays, tidal, s, seaMode, seaValue, relief, capK, distortion, figure, gRel, drama, icy: arch.icy,
    dichoAxis, dichoAmp, crustAmp, basins, oldCraters, youngCraters, rises, volcanoes, rifts, scarpList, chaosList,
    palimpsests, grooves, cantaloupe, capLat, capDome, stripes,
  };
}

// ---- look hints ------------------------------------------------------------------------------------------

export function lookHints(plan: WorldPlan): LookHints {
  const b = plan.bulk;
  const P = b.atmospherePressureBar;
  const style = plan.arch.atmo.style;
  const H = (8.314 * Math.max(40, b.surfaceTempK)) / ((plan.arch.atmo.molar / 1000) * b.gravity) / 1000; // scale height, km
  let atmoDensity = 0.08 + 0.6 * Math.log10(1 + 30 * P);
  let rayleigh: [number, number, number] = [5.8, 13.5, 33.1];
  let mie = 4, mieH = H * 0.4;
  switch (style) {
    case 'dusty': rayleigh = [11, 8.5, 6.2]; mie = 22; mieH = H * 0.6; atmoDensity = Math.max(atmoDensity, 0.2); break;
    case 'co2haze': rayleigh = [10, 8.5, 6.5]; mie = 26; mieH = H * 0.8; atmoDensity = Math.max(atmoDensity, 0.35); break;
    case 'sulfur': rayleigh = [10, 9, 3.6]; mie = 10; mieH = H * 0.8; atmoDensity = Math.max(atmoDensity, 0.12); break;
    case 'exo': rayleigh = [4, 7, 12]; mie = 6; mieH = H * 0.5; atmoDensity = 0.05; break;
    case 'exoIce': rayleigh = [3.5, 8, 18]; mie = 3; mieH = H * 0.5; atmoDensity = 0.06; break;
    case 'n2haze': rayleigh = [4.5, 8, 17]; mie = 5; mieH = H * 0.6; atmoDensity = Math.max(atmoDensity, 0.1); break;
  }
  atmoDensity = Math.min(3, Math.max(0.05, atmoDensity));
  // Tiny bodies have enormous physical scale heights; a renderer shell needs soft exponential falloff inside it,
  // so scale heights stay well below the shell (rayleighH <= shell/6, mieH <= shell/8).
  const atmoHeightKm = Math.min(120, Math.max(25, b.radiusKm * 0.1));
  const rayleighH = Math.min(atmoHeightKm / 6, Math.max(2, H));
  mieH = Math.min(atmoHeightKm / 8, Math.max(1, mieH), rayleighH);
  let seaDeep = '#0a2440', seaShallow = '#2a8a8a';
  if (b.seaKind === 'lava') { seaDeep = '#ff4a12'; seaShallow = '#ffb238'; }
  else if (b.seaKind === 'ice') { seaDeep = '#8fb2cc'; seaShallow = '#dce9f2'; }
  else if (b.seaKind === 'water') { seaDeep = '#0b3550'; seaShallow = '#38c0b0'; }
  const jr = new Rng(plan.p.seed, 11);
  const j = [(jr.next() - 0.5) * 0.12, (jr.next() - 0.5) * 0.12, (jr.next() - 0.5) * 0.12];
  const layerTints = plan.arch.tints.map((t) => [t[0] * (1 + j[0]), t[1] * (1 + j[1]), t[2] * (1 + j[2])] as [number, number, number]);
  return {
    atmoDensity, atmoHeightKm, rayleigh, mie, mieH, rayleighH, layerTints, seaKind: b.seaKind,
    seaDeepColor: seaDeep, seaShallowColor: seaShallow,
  };
}

// ---- history ---------------------------------------------------------------------------------------------

export interface SurfaceStats {
  seaCoverage: number;
  /** Global equivalent layer (m) of the sea. */
  seaGEL: number;
  floodCoverage: number;
  duneCoverage: number;
  capCoverage: number;
  playaCoverage: number;
  minHeight: number;
  maxHeight: number;
  droplets: number;
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const pct = (f: number) => `${(f * 100).toFixed(f < 0.1 ? 1 : 0)}%`;
const km = (m: number) => `${(m / 1000).toFixed(1)} km`;

export function buildHistory(plan: WorldPlan, st: SurfaceStats): HistoryEvent[] {
  const b = plan.bulk;
  const age = b.ageGyr;
  const R = b.radiusKm;
  const ev: HistoryEvent[] = [];
  const fam = plan.arch.family;
  ev.push({ gyrAgo: age, stage: 'Accretion', text: `${plan.name} accretes from ${plan.icy ? 'icy' : 'rocky'} planetesimals: ${fmt(R)} km radius, ${(b.massEarth * 1e3).toFixed(2)}‰ of Earth's mass, ${(b.ironFrac * 100).toFixed(0)}% iron, ${(b.volatileFrac * 100).toFixed(0)}% volatiles.` });
  ev.push({ gyrAgo: age - 0.02, stage: 'Differentiation', text: plan.icy
    ? `Radiogenic heat melts the interior: rock sinks into a core of ${fmt(b.coreRadiusFrac * R)} km while water rises into a mantle of ice and brine. Gravity ${b.gravity.toFixed(2)} m/s².`
    : `A magma ocean differentiates the body: a ${fmt(b.coreRadiusFrac * R)} km iron core sinks (${(b.coreRadiusFrac * 100).toFixed(0)}% of the radius); density ${b.densityGcc.toFixed(2)} g/cm³, gravity ${b.gravity.toFixed(2)} m/s².` });
  if (plan.orbitDays > 0) ev.push({ gyrAgo: age - 0.05, stage: 'Capture', text: `Locked into a ${plan.orbitDays.toFixed(1)}-day eccentric orbit around a gas giant; tidal heating runs at ${plan.tidal.toFixed(0)}× the radiogenic heat.` });
  if (plan.dichoAmp > 300)
    ev.push({ gyrAgo: age - 0.06, stage: 'Primordial crust', text: `The crust freezes lopsided: one hemisphere stands ${km(plan.dichoAmp * 1.6)} above the other (crustal dichotomy).` });
  else
    ev.push({ gyrAgo: age - 0.06, stage: 'Primordial crust', text: plan.icy ? 'An ice shell freezes over a salty internal ocean.' : 'A thin crust floats to the top of the cooling magma ocean.' });
  {
    const e = plan.figure.e, m = (e[0] + e[1] + e[2]) / 3;
    const ax = e.map((v) => 2 * (R + (v - m) / 1000)).sort((a, c) => c - a);
    if ((ax[0] - ax[2]) / (2 * R) > 0.02) ev.push({ gyrAgo: age - 0.08, stage: 'Figure', text: `${plan.distortion > 1.2 ? 'Never pulled itself round' : 'Too stiff to relax fully round'}: the body stays a lumpy triaxial ${fmt(ax[0])} × ${fmt(ax[1])} × ${fmt(ax[2])} km${plan.figure.blobs.length > 2 ? ', with broad lobes and dents' : ''}.` });
  }
  if (plan.basins.length > 0) {
    const big = plan.basins[0];
    ev.push({ gyrAgo: Math.min(age - 0.1, 4.1), stage: 'Giant impacts', text: `${plan.basins.length} giant impact${plan.basins.length > 1 ? 's' : ''} carve multi-ring basins; ${big.name} spans ${fmt(big.r * 2 * R)} km (${Math.round((big.r * 2 * R) / (2 * R) * 100)}% of the diameter), ${km(big.depth)} deep${big.peak > 0 ? `, with a ${km(big.peak)} central peak` : ''}.${plan.chaosList.some((c) => c.r > 0.12) ? ' Seismic waves focus at its antipode and shatter the ground into chaos.' : ''}` });
  }
  const nc = plan.oldCraters.length / 8;
  if (nc > 50) ev.push({ gyrAgo: Math.min(age - 0.2, 3.9), stage: 'Heavy bombardment', text: `${fmt(nc)} large craters ${nc > 2500 ? 'saturate the old crust: crater on crater' : 'scar the crust'}${plan.arch.relax > 0.5 ? '; the warm ice slowly relaxes the biggest ones flat' : ''}.` });
  if (plan.palimpsests.length) ev.push({ gyrAgo: 3.8, stage: 'Relaxation', text: `${plan.palimpsests.length} ancient craters sag into flat bright palimpsests.` });
  if (plan.rises.length > 0) ev.push({ gyrAgo: Math.min(age - 0.5, 3.7), stage: 'Mantle plume', text: `A mantle plume domes the crust into ${plan.rises.length > 1 ? `${plan.rises.length} volcanic rises` : 'a volcanic rise'} ${km(plan.rises[0].h)} high.` });
  const vs = plan.volcanoes.filter((v) => v.style !== 'block');
  if (vs.length > 0) {
    const tall = vs.reduce((a, v) => (v.h > a.h ? v : a), vs[0]);
    const sty = vs[0].style;
    const pctR = ((tall.h / (R * 1000)) * 100).toFixed(1);
    if (sty === 'patera') ev.push({ gyrAgo: 0.001, stage: 'Volcanism', text: `${vs.length} paterae erupt continuously (heat flow ${b.heatFlow.toFixed(0)}× Earth's per area); lava lakes glow in their calderas and plumes rain sulfur.` });
    else if (sty === 'cryo') ev.push({ gyrAgo: 0.05, stage: 'Cryovolcanism', text: `${vs.length} cryovolcanic dome${vs.length > 1 ? 's' : ''} extrude slushy brine; ${tall.name} towers ${km(tall.h)} (${pctR}% of the radius) over broad lobes of cryolava.` });
    else ev.push({ gyrAgo: fam === 'volcanic' ? 0.2 : Math.min(age - 0.8, 3.5), stage: 'Volcanism', text: `${vs.length} volcano${vs.length > 1 ? 'es grow' : ' grows'} in the weak gravity; ${tall.name} reaches ${km(tall.h)} (${pctR}% of the radius).` });
  }
  const blocks = plan.volcanoes.filter((v) => v.style === 'block');
  if (blocks.length) ev.push({ gyrAgo: 0.01, stage: 'Crustal thrusting', text: `Subsiding lava piles thrust up ${blocks.length} isolated block mountains, up to ${km(Math.max(...blocks.map((v) => v.h)))}.` });
  if (st.floodCoverage > 0.01) ev.push({ gyrAgo: fam === 'volcanic' ? 0.05 : Math.min(age - 0.9, 3.4), stage: 'Flood basalts', text: `Basalt floods fill the low basins, paving ${pct(st.floodCoverage)} of the surface with dark plains and wrinkle ridges.` });
  const canyon = plan.rifts.find((r) => r.kind === 0 && r.name);
  if (canyon) ev.push({ gyrAgo: plan.icy ? 0.3 : 3.2, stage: 'Rifting', text: `The crust splits: ${canyon.name} opens ${fmt(canyon.len * R)} km long and ${km(canyon.depth)} deep.` });
  if (plan.scarpList.length > 0) ev.push({ gyrAgo: 3.0, stage: 'Contraction', text: `The cooling core shrinks the body; ${plan.scarpList.length} lobate thrust scarps rise up to ${km(Math.max(...plan.scarpList.map((s) => s.h)))}.` });
  if (plan.grooves.length) ev.push({ gyrAgo: 2.0, stage: 'Grooved terrain', text: `Extension tears ${plan.grooves.length} bright bands of parallel grooves across the dark ancient ice.` });
  if (plan.icy && plan.s.lineae > 0.1 && !plan.grooves.length) ev.push({ gyrAgo: 0.08, stage: 'Tidal flexing', text: `Tides crack the shell into ridged lineae${plan.chaosList.length ? `; ${plan.chaosList.length} chaos regions mark where the ocean melted through` : ''}.` });
  if (plan.cantaloupe) ev.push({ gyrAgo: 0.5, stage: 'Diapirs', text: 'Rising ice diapirs dimple a broad region into cantaloupe terrain.' });
  if (plan.stripes) ev.push({ gyrAgo: 0.001, stage: 'Geysers', text: 'Parallel fissures near the pole vent the inner ocean; geyser frost snows back onto the surface.' });
  if (st.seaCoverage > 0.002) {
    const kind = b.seaKind === 'water' ? 'briny lakes' : b.seaKind === 'ice' ? 'frozen seas' : 'lava lakes and seas';
    ev.push({ gyrAgo: b.seaKind === 'lava' ? 0 : 1, stage: 'Volatiles', text: `${st.seaGEL.toFixed(0)} m of global ${b.seaKind === 'lava' ? 'melt' : 'volatiles'} pools in the lows as ${kind}, covering ${pct(st.seaCoverage)}.` });
  }
  if (st.droplets > 0) ev.push({ gyrAgo: fam === 'volcanic' ? 0.1 : 3.5, stage: fam === 'volcanic' ? 'Lava channels' : 'Outflow floods', text: fam === 'volcanic' ? 'Fast lava rivers cut sinuous channels and fans down the shield flanks.' : 'Catastrophic outflows from the chaos regions carve channels into the lowlands.' });
  if (st.capCoverage > 0.001) ev.push({ gyrAgo: 0.5, stage: 'Polar caps', text: `CO₂ and water frost build layered polar domes ${km(plan.capDome)} thick with spiral troughs, covering ${pct(st.capCoverage)}.` });
  if (st.duneCoverage > 0.002) ev.push({ gyrAgo: 0.1, stage: 'Wind', text: `Thin winds sweep sand into dune seas over ${pct(st.duneCoverage)} of the surface.` });
  if (st.playaCoverage > 0.001) ev.push({ gyrAgo: 0.3, stage: 'Deposits', text: plan.archetype === 'sulfur' ? 'Plume fallout paints rings of sulfur and SO₂ frost around the vents.' : plan.icy ? `Geyser and frost deposits brighten ${pct(st.playaCoverage)} of the surface.` : `Closed basins dry out into bright salt flats (${pct(st.playaCoverage)}).` });
  let rayed = 0, fac = 0;
  for (let o = 7; o < plan.youngCraters.length; o += 8) { if (plan.youngCraters[o] === 1) rayed++; else if (plan.youngCraters[o] === 2) fac++; }
  if (rayed > 0) ev.push({ gyrAgo: 0.05, stage: 'Fresh impacts', text: `${rayed} young impact${rayed > 1 ? 's' : ''} splash bright rays across the older terrain.` });
  if (fac > 0) ev.push({ gyrAgo: 0.02, stage: 'Faculae', text: `Brine seeps up through ${fac} young crater floor${fac > 1 ? 's' : ''}, leaving dazzling salt faculae.` });
  ev.push({ gyrAgo: 0, stage: 'Today', text: `${ARCHETYPE_LABELS[plan.archetype]}: ${b.surfaceTempK.toFixed(0)} K mean surface, ${atmoText(b.atmospherePressureBar)} ${b.atmosphereKind}, ${b.tectonics} lid. Relief ${km(st.minHeight)} to +${km(st.maxHeight)} (${(((st.maxHeight - st.minHeight) / (R * 1000)) * 100).toFixed(1)}% of the radius).` });
  ev.sort((a, c) => c.gyrAgo - a.gyrAgo);
  for (const e of ev) e.gyrAgo = Math.max(0, Math.round(e.gyrAgo * 1000) / 1000);
  return ev;
}

function atmoText(P: number): string {
  if (P >= 0.1) return `${P.toFixed(2)} bar`;
  if (P >= 1e-4) return `${(P * 1000).toFixed(1)} mbar`;
  return `${P.toExponential(0)} bar`;
}

// ---- points of interest ----------------------------------------------------------------------------------

const VOLC_KIND: Record<VolcStyle, string> = {
  shield: 'shield volcano', patera: 'patera', cone: 'volcanic cone', dome: 'volcanic dome', cryo: 'cryovolcano', block: 'block mountain',
};

/**
 * Named landmarks for the globe view (the planner's features, ranked by how much they dominate the view).
 * Basins, volcanoes and the main canyons already carry names; rises, chaos, rayed craters and caps get theirs
 * here from a separate stream, so the existing names do not change.
 */
export function buildPois(plan: WorldPlan): Poi[] {
  const Rk = plan.bulk.radiusKm;
  const rng = new Rng(plan.p.seed, 30);
  const fmt = (km: number) => (km >= 100 ? Math.round(km / 10) * 10 : Math.round(km)).toLocaleString('en-US');
  const pois: Poi[] = [];
  const add = (kind: string, name: string, d: number[], radius: number, rank: number, text: string) =>
    pois.push({ kind, name, dir: [d[0], d[1], d[2]], radius, rank, text });
  for (const b of plan.basins) {
    const floor = ['central peak', 'peak ring', 'flat floor', 'deep bowl'][b.floor] ?? '';
    add('basin', b.name, [b.x, b.y, b.z], b.r, b.r * 2 * Rk * 1.3, `impact basin · ${fmt(b.r * 2 * Rk)} km${floor ? ` · ${floor}` : ''}`);
  }
  for (const v of plan.volcanoes) {
    if (!v.name) continue;
    add('volcano', v.name, [v.x, v.y, v.z], v.r, v.r * 2 * Rk * 0.6 + v.h / 1000 * 25, `${VOLC_KIND[v.style]} · ${(v.h / 1000).toFixed(1)} km high`);
  }
  for (const r of plan.rifts) {
    if (!r.name) continue;
    const m = along([r.sx, r.sy, r.sz], [r.nx, r.ny, r.nz], r.len / 2);
    add('rift', r.name, m, r.len / 2, r.len * Rk * 0.9 + r.depth / 1000 * 20, `${r.kind === 0 ? 'canyon system' : 'fissure belt'} · ${fmt(r.len * Rk)} km, ${(r.depth / 1000).toFixed(1)} km deep`);
  }
  for (const r of plan.rises) {
    add('rise', makeName(rng) + ' Planum', [r.x, r.y, r.z], r.r, r.r * 2 * Rk * 0.8, `volcanic rise · ${fmt(r.r * 2 * Rk)} km · +${(r.h / 1000).toFixed(1)} km`);
  }
  for (const c of plan.chaosList) {
    if (c.r < 0.07) continue;
    add('chaos', makeName(rng) + ' Chaos', [c.x, c.y, c.z], c.r, c.r * 2 * Rk * 0.7, `chaos terrain · ${fmt(c.r * 2 * Rk)} km`);
  }
  const yc = plan.youngCraters;
  for (let o = 0; o < yc.length; o += CRATER_STRIDE) {
    const flag = yc[o + 7];
    if (flag !== 1 && flag !== 2) continue;
    const r = yc[o + 3];
    add('crater', makeName(rng), [yc[o], yc[o + 1], yc[o + 2]], r, r * 2 * Rk * 3 + 40, `${flag === 2 ? 'crater with salt faculae' : 'fresh rayed crater'} · ${fmt(r * 2 * Rk)} km`);
  }
  if (plan.capDome > 0) {
    for (const [sgn, nm] of [[1, 'Planum Boreum'], [-1, 'Planum Australe']] as const) {
      add('cap', nm, [0, sgn, 0], Math.PI / 2 - (sgn > 0 ? plan.capLat[0] : plan.capLat[1]), 300, `polar layered deposits · ${(plan.capDome / 1000).toFixed(1)} km thick`);
    }
  }
  // Strongest first; keep the list short so the globe never turns into a map.
  pois.sort((a, b) => b.rank - a.rank);
  return pois.slice(0, 16);
}

export function buildInfo(plan: WorldPlan, st: SurfaceStats): PlanetInfo {
  return {
    archetype: plan.archetype, name: plan.name, bulk: plan.bulk, history: buildHistory(plan, st), units: GEO_UNITS, look: lookHints(plan),
    resolved: { ...plan.resolved, seaVolume: Math.round(st.seaGEL) },
    pois: buildPois(plan),
  };
}
