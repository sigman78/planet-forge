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
- General: `seed`, `resolution`, `archetype`, `drama` (0..2, exaggerates features), `reliefScale`.
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
| `wild` | any | random mix | Random base archetype and features, darkened random tints. May rarely get small brine or frozen lakes (`drama` 1.5). |

No archetype ever gets a liquid-water sea by default. A preset's sea covers under 10% of the surface (tested).

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
   - Crust (dichotomy, low-degree noise, lumpy figure on small bodies), basins, rises, polar domes.
   - Old craters into a detail layer, which volcanoes bury.
   - Ice tectonics: lineae, grooves, chaos, cantaloupe, palimpsests.
   - A separate post-flood ("young") layer holds young craters, rifts and scarps, because they postdate the maria and
     cut them.
   - Linear features never get narrower than ~1.6–2.6 texels, so they never alias into dotted lines.
3. **Cube stage** (`pipeline.ts: stageCube`, one worker).
   - Flood basalts to an area quantile (smooth max, Gaussian wrinkle ridges), then the young layer.
   - Soft relief cap: at most +7.5% / −5.5% of R about the mean.
   - Sea level by coverage or volume. Lava seas are defined on the pre-flood topography so their shores are crisp;
     patera calderas are forced below the lava level.
   - Dunes.
   - Droplet erosion and talus, seamless across faces via a padded index map. Droplet density scales as
     (256/N)^1.5 so N=512 stays affordable.
   - Datum shift.
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
  - Relief is huge by design: Ceres-size worlds reach ±10–30 km.
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
- Heights are finite and the total relief stays under 13% of R.
- `info` is filled; no water seas; sea coverage under 10%; atmosphere scale-height bounds.
- Sea coverage matches the plan.
- The volume sea-level solver is correct.
- Erosion stays bounded.
- Face-edge continuity:
  - for height and splat on all 24 sides, the across-edge difference must statistically match the interior
    neighbour difference (per side and globally), for six archetypes at N=96;
  - gutters must agree with the adjacent face.
