# Planet generator: a take on visual variance

Branch `gen/variance`. Each item is one commit the user can veto on its own. Rule for every slice: no
render-time cost. Quality comes from the generator (offline, cached per world), from data baked on the CPU
when a world loads, or from a cheaper shader; a slice that needs a new render pass or a per-pixel loop does
not qualify.

## Where the sameness comes from

Nine archetypes, each a fixed recipe: one volcano style, one set of eight layer tints with a ±6% jitter
shared by all layers, fixed sea colours, dunes always north-south, craters all at the same freshness, every
graben a ruler line, one global albedo noise at two frequencies. Two worlds of one archetype differ in
where things are, not in what they look like; a Rust world is always the same brown. Seen from orbit the
layer textures average out to their tints, so the planet reads as a flat colour with relief, while real
bodies carry their history in their colour: dark maria against bright highlands, ray systems, a reddened
leading hemisphere, frost at the poles, dust streaks downwind of craters.

## Slices, in order

1. **Baked colour map** (done, see below) (renderer, cache-safe). A per-world RGBA8 data texture `tTone` computed on the CPU
   at load from what the data already carries: the geologic unit id, height, latitude and a few low-order
   noise fields, through a palette drawn per world from the archetype's gamut. Unit tints (maria darker
   and bluer than highlands, ejecta and rays brighter, dune fields warmer, canyon floors darker, lava
   flows nearly black, caps neutral), a hemispheric dichotomy, a latitude term, and a regional drift.
   Blurred over a few texels so no unit edge becomes a drawn line. Applied as one multiply in the terrain
   and rock shaders (one `textureLod` at the data LOD, which the AO already pays). A Look slider sets its
   strength. Cached planets get it for free because nothing in the data changes.
2. **Crater population** (generator). A degradation continuum instead of two freshness classes: rim
   sharpness, depth/diameter and ejecta extent fall with age so old craters are soft bowls with no rim and
   young ones crisp; secondary chains and clusters around the largest fresh craters; a few crater
   clusters from binary impacts. Bright and dark halo craters as unit ids so the colour map can use them.
3. **Winds** (generator). A per-world prevailing wind field (zonal bands plus a seeded twist) that orients
   the dunes, streaks dust downwind of craters and rises (bright and dark wind streaks as a unit), and
   decides which hemisphere of a tidally locked body collects frost.
4. **Archetype flags** (refactor, no visual change). The scattered `archetype === 'x'` checks in
   surface.ts, terrain.ts, world.ts and pipeline.ts become ArchDef booleans so new archetypes are data.
5. **New archetypes**: two-tone (Iapetus-like: one hemisphere coated dark, a sharp ragged boundary, bright
   ice elsewhere, an equatorial ridge); carbon (C-type: very dark, grooves, big rubble-pile craters,
   low relief); and a regolith-stripe variant of grey moon (swirls as magnetic anomalies).
6. **Events**: antipodal hilly terrain from the largest basin, a global ring of ejecta from a late giant
   impact, a recent plume deposit fan on cryo worlds; each a unit id plus relief.

Deferred: new texture layers (needs a third splat texture and a data contract change) and anything that
touches the cube stage ordering.

## Done so far on the branch

- Cube-face seams (renderer): AO blurred on a padded face, GPU data textures carry an 8-texel gutter.
- Straight thin lines: the flow routing drew ruler-straight channels across every slope and lava plain
  (single-direction routing); now multiple flow directions on the filled surface, channels as the excess
  over the local sheet, no flow across ponded ground. Rift troughs wander, pinch out, and split into
  en-echelon strands.
- Slice 1, the baked colour map (`src/core/tone.ts`, Look slider "colour map"). Bake ~530 ms at res 512 on
  load; ice worlds barely change (their units are neutral); wild worlds take the rocky palette for now.
