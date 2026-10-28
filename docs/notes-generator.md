# Generator notes (`src/gen/`)

The generator builds small rocky and icy worlds (Ceres to large-moon scale, ~200–900 km radius) by replaying a
formation history. Every stage leaves a `HistoryEvent`, so the UI can tell the planet's story. Output is the
`PlanetData` cube-sphere contract in `src/core/types.ts`, with `info` always filled.

## API (`src/gen/index.ts`)

```ts
generatePlanet(params: Partial<GenParams>, opts?: GenerateOptions | ((stage: string, frac: number) => void)): Promise<PlanetData>
interface GenerateOptions { onProgress?(stage: string, frac: number): void; signal?: AbortSignal; mainThread?: boolean }
```

- Deterministic for a given seed and parameter set. The worker pool and the main-thread fallback run the same stage
  functions, so they give identical results.
- The newest call wins. Starting a new generation terminates any workers still busy with the old one, and the old
  promise rejects with `AbortError`. `signal` aborts the same way.
- Re-exports:
  - From params: `DEFAULT_PARAMS`, `GEN_PRESETS`, `PARAM_SCHEMA`, `ARCHETYPE_LABELS`, `ARCHETYPE_FAMILIES`, `AUTO`,
    `presetParams(name, overrides)`, `resolveParams(p)`, and the types `GenParams`, `Archetype`, `ParamSchemaEntry`.
  - `GEO_UNITS`: the unit id, name and colour table.
  - `LAYER_ALBEDO`: mean linear albedo of the texture set per layer.
  - `LAYER_COLORS`: sRGB version of `LAYER_ALBEDO`.
- `src/gen/pipeline.ts` exports `generatePlanetSync(params, onProgress?)`, used by the CLI and tests.

## Parameters

- `AUTO = -1` means "draw from the archetype's range using the seed".
- General: `seed`, `resolution`, `archetype`, `drama` (0..2, wildness: exaggerates features and lifts every
  relief cap), `distortion` (0..2 or AUTO, non-sphericity of the figure), `reliefScale`. See "Wildness" below.
- Bulk (AUTO-able): `radiusKm`, `ironFrac`, `volatileFrac`, `ageGyr`, `insolation`, `tidalHeating`.
- Stage knobs (AUTO-able): `dichotomy`, `basinCount`, `basinSize`, `craterDensity`, `plumeCount`, `volcanoScale`,
  `riseCount`, `riftStrength`, `scarps`, `lineae`, `chaos`, `floodLevel`, `seaVolume`, `erosion`, `dunes`, `salt`,
  `rays`, `polarCaps`.
  - `seaVolume` is in metres of global equivalent layer. AUTO uses the archetype's coverage.
- Erosion detail: `erosionDroplets`, `erosionRate`, `depositionRate`, `inertia`, `evaporation`, `capacity`,
  `brushRadius`, `thermalIterations`, `talusAngle`, plus `rockSlope`.

## Archetypes (`GEN_PRESETS` keys)

| key | family | inspiration | look |
|---|---|---|---|
| `rust` | rocky | Mars, shrunk | Ochre dust (albedo ~0.2), dark basaltic dunes, shields on a rise, a canyon, polar caps, thin CO₂ dust haze. |
| `cinder` | rocky | Mercury | Albedo ~0.1 grey-brown, saturated craters, maria, lobate scarps that cut the maria, bright rays; Na/K exosphere. |
| `grey moon` | rocky | Moon | Grey highlands, dark maria in giant basins, rays; argon exosphere. |
| `ice shell` | ice | Europa | Smooth young ice, great-circle double-ridge lineae with dark bands, chaos, small frozen seas (`seaKind: 'ice'`); thin bluish O₂ exosphere. |
| `old ice` | ice | Callisto / Ganymede | Dark dirty ice, crater-saturated, palimpsests, grooved bright bands. |
| `sulfur` | volcanic | Io | Yellow sulfur plains, paterae with lava-lake floors, plume rings, block mountains, almost no craters; SO₂ haze; `seaKind: 'lava'`. |
| `basalt` | volcanic | young volcanic world | Dark basalt, shield fields, flood basalts, rifts, lava seas in low basins; CO₂ haze; `seaKind: 'lava'`. |
| `cryo` | cryovolcanic | Enceladus / Triton / Ceres | Tall cryodomes, cryolava lobes, tiger-stripe fissures, geyser frost (salt layer), cantaloupe terrain, lumpy figure; faint N₂ haze. |
| `wild` | any | random mix | Random base archetype and features, darkened random tints, potato figure at any size. May rarely get small brine or frozen lakes (`drama` 1.6). |

No archetype ever gets a liquid-water sea by default. A preset's sea covers under 10% of the surface (tested).

## Wildness (drama, distortion, relief caps)

Worlds are exaggerated on purpose ("slightly unrealistic, blown out of proportion").

- **`drama` = wildness `w` (0..2).** It scales feature magnitudes as before, and also sets the cap factor
  `capK = 0.45 + 0.95·w` (0.45 / 1.4 / 2.35 at w = 0 / 1 / 2).
  - Every per-feature cap is a fraction of R × `capK`: basins 7%, shields 7%, cones 4.5%, cryodomes 5.5%,
    domes 3%, blocks 5%, rises 5%, canyons 4.5%, scarps 1.5%, polar domes 1.2%. All the caps rise together, so
    lifting one cap never just runs into the next.
  - Horizontal footprint ceilings (volcano radius caps, block and canyon widths, scarp widths) scale with
    `√capK`, so slopes stay sane.
  - Crust, dichotomy amplitude and crust domain warp grow with `w`.
- **Feature limit** (cube stage, after the floods). Stacked feature relief is soft-compressed above
  +4.5%·L / below −3.5%·L, with asymptotes +7.5%·L / −5.5%·L, where `L = capK·reliefScale`. It is capped at
  +20% / −17%, so the relief slider is real.
- **Figure** (`world.ts: Figure`, `figureAt`). The non-spherical figure has three parts:
  - a triaxial stretch along a random frame (axis spread ≈ 4.4% R × distortion × size factor);
  - low-order fbm lumps;
  - a few broad Gaussian lobes and dents.

  The terrain stage evaluates it per texel into its own layer (parallel). The cube stage adds it after the
  flood basalts and the feature limit. The maria and the limit therefore work on the residual, while seas, lava
  seas and the datum see the total, so liquids pool in the figure lows.
  - `distortion` AUTO = archetype `figure` range × (0.4 + 0.6·w): ice shell 0.2–0.4 (warm young ice relaxes
    round), old ice 0.3–0.5, grey moon 0.45–0.7, cinder 0.6–0.9, rust / basalt 0.8–1.1, sulfur 0.9–1.2,
    cryo 0.9–1.25, wild 1.25–1.9. Clamped to 2.
  - Size factor: 1.3 at 200 km down to 0.7 at ≥ 1,200 km. Wild worlds keep at least 1.
  - The history gets a "Figure" event with the triaxial diameters.
- **Renderer contract.** After the datum shift, heights are smoothly clamped beyond ±20% R (asymptote ±24.5%),
  so the displaced cube sphere stays star-shaped in any setting (tested at drama 2, relief 3, distortion 2).
- Patera lava lakes are forced to the lava level only when the caldera sits within ~2.5–5 km·relief of it.
  Higher calderas stay as pits; the old forcing dug 1-texel shafts. Calderas on lava worlds above the sea get
  unit `lava lake` and 1250 K in climate R.
- Typical relief (max − min, % of R, N=256, seeds 1–5, defaults):

  | archetype | relief |
  |---|---|
  | rust | 9–17 |
  | basalt | 12–19 |
  | cryo | 10–18 |
  | sulfur | 5–13 |
  | wild | 13–23 |
  | cinder, grey moon | 4–9 |
  | ice shell, old ice | 3–9 |

## Pipeline

1. **Plan** (`world.ts`, pure, memoised per parameter set).
   - Bulk physics:
     - density from the iron/silicate/volatile mix, then gravity and core radius;
     - insolation and greenhouse give the temperature;
     - radiogenic × (1 + tidal) heating gives the tectonic regime;
     - escape vs thermal speed gives atmosphere retention (never zero).
   - Then the event lists: basins with peaks and rings, power-law craters (old and young), volcanoes (shield, patera,
     cone, dome, cryo, block), rises, rifts (canyon, graben, fissure), scarps, chaos, grooves, palimpsests, caps.
   - Relief scales with 1/g: `gRel = (3.7/g)^0.3`, volcanoes use `(3.7/g)^0.7`.
2. **Terrain per face** (`terrain.ts`, parallel in workers).
   - Crust (dichotomy, low-degree noise), basins, rises, polar domes.
   - The figure (triaxial + lumps), in its own layer.
   - Old craters into a detail layer, which volcanoes bury.
   - Ice tectonics: lineae, grooves, chaos, cantaloupe, palimpsests.
   - A separate post-flood ("young") layer holds young craters, rifts and scarps, because they postdate the maria and
     cut them.
   - Linear features never get narrower than ~1.6–2.6 texels, so they never alias into dotted lines.
3. **Cube stage** (`pipeline.ts: stageCube`, one worker).
   - Flood basalts to an area quantile (smooth max, Gaussian wrinkle ridges), then the young layer.
   - Feature limit (scales with `capK·reliefScale`), then the figure layer is added.
   - Sea level by coverage or volume. Lava seas are defined on the pre-flood topography so their shores are crisp;
     patera calderas are forced below the lava level.
   - Dunes.
   - Droplet erosion and talus, seamless across faces via a padded index map. Droplet density scales as
     (256/N)^1.5 so N=512 stays affordable.
   - Datum shift, then the ±20% (asymptote ±24.5%) smooth safety clamp.
   - Priority-flood flow and fill. Evaporites go only in the deepest closed pockets: capped by area at ≤2%·salt,
     broken into patches, and only where a carrier exists (fluids, frost or sulfur).
4. **Surface per face** (`surface.ts`, parallel).
   - Slope from the 3D tangent gradient drives the splat weights.
   - Each texel gets a geologic unit by precedence.
   - Splats are normalised with largest remainder, so `splat0 + splat1 = 255` exactly in the interior.
   - Gutters are refilled bilinearly (unit ids use the nearest texel).

## Renderer notes

- **`height`:** metres relative to the datum. The datum is sea level when `info.look.seaKind !== 'none'` (lava or
  ice), otherwise the area-mean radius. `PlanetData.radius` is the mean radius in metres.
  - Relief is huge by design: Ceres-size worlds reach ±10–30 km at default and more with drama.
  - Heights always stay within ±24.5% of R. Default worlds span about 5–20% of R (max − min), and wild ones up
    to ~25%. Extreme settings fill the ±24.5% band. Mountains can reach +12–16% R at default, well above the
    atmosphere shell (0.1·R): size the shell and the camera's minimum altitude from `maxHeight`.
  - Lava and ice seas: texels with `h < 0` are sea. The sea surface is flat at 0.
- **`climate`:** R = temperature K/2 (lava cells are written as 1250 K, so R saturates at 255), G = volatile
  wetness, B = flow (only on worlds with fluids), A = geologic unit id (`info.units` / `GEO_UNITS`, ids 0–29;
  categorical, so sample it with nearest filtering).
- **Layers:** 0 dust, 1 highland, 2 basalt, 3 sand, 4 rock, 5 gravel, 6 ice, 7 salt.
  - `look.layerTints` are linear multipliers on the texture set's mean albedos (`LAYER_ALBEDO`).
  - Cinder averages albedo ~0.10, rust ~0.21/0.14/0.09; icy worlds are bright.
- **Atmosphere:** shell `atmoHeightKm = clamp(0.1·R, 25, 120)`, `rayleighH ≤ shell/6`, `mieH ≤ shell/8`,
  `atmoDensity > 0` always.
- **Face seams:** the data is continuous across the 24 face edges (tested). Sample the splat and climate textures
  with an LOD derived from the continuous direction, not from the cube texcoord; implicit derivatives jump at face
  edges.

## Timings (single thread, Node, this machine; ms)

| N | terrain (6 faces) | cube stage (flood, sea, erosion, flow) | surface (6 faces) | total sync |
|---|---|---|---|---|
| 256 | 0.5–1.0 s | 0.2 s (1.1 s with erosion: rust, basalt) | 0.5 s | 1.2–2.8 s |
| 512 | 1.7–3.7 s | 0.7 s (4 s with erosion) | 1.5–1.9 s | 3.9–9.0 s |

In workers, terrain and surface split six ways. Expected wall time at N=512 is ~1.5 s for airless worlds and ~5 s
for eroded ones (rust, basalt), where the single-threaded cube stage dominates.

## CLI

```
node src/gen/cli.ts --seed 42 --res 256 --preset "grey moon" --out out/moon [--set key=value] [--zoom lon,lat,fov] [--exag k] [--no-preview]
```

It writes:
- previews: `preview.png` (tinted splat), `units.png`, `height.png`, `globe.png` (two orthographic views with an
  atmosphere rim), `zoomK.png`;
- raw exports: `height.f32`, `splat0.rgba`, `splat1.rgba`, `climate.rgba`;
- `planet.json`: the layout, params, `info` and the history.

## Tests (`src/gen/gen.test.ts`)

- Determinism.
- Splat sums are exactly 255 in the interior and within ±4 in the gutters.
- Heights are finite and stay within ±25% of R, for every preset and at drama 2 / relief 3 / distortion 2.
- The relief slider and drama move the relief. Wild figures are triaxial (axis spread > 5% R); ice shells are
  rounder.
- `info` is filled; no water seas; sea coverage under 10%; atmosphere scale-height bounds.
- Sea coverage matches the plan.
- The volume sea-level solver is correct.
- Erosion stays bounded.
- Face-edge continuity:
  - for height and splat on all 24 sides, the across-edge difference must statistically match the interior
    neighbour difference (per side and globally), for seven archetypes (including wild) at N=96;
  - gutters must agree with the adjacent face.
