# HQ terrain: sub-datum mesh subdivision (branch `exp/hq-subdiv`)

User ask (2026-10-30): "model on a branch a new HQ mode toggle - new sub-datum mesh subdivision for extra details (procedural)".

Reading: an opt-in toggle that adds real geometry *below the resolution of the baked datum* (the 512-texel height
cube, ~2.5 km per texel on an 800 km world) and below the current mesh spacing, near the camera, displaced by the
procedural relief the fragment shader already paints as normals. Close views (the fly mode can sit 0.4 km up) then
get true silhouettes, occlusion and parallax. Note that the WORKLOG uses "sub-datum" once for *below sea level*
(atmosphere entry, 2026-10-28); that reading would mean seabed detail only and does not fit "extra details
(procedural)", so this plan takes the resolution reading. Numbers below are for R = 800 km, N = 512, 45° fov,
1080 px tall, default look (`detailAmp` 350 m, `detailScale` 6 km) unless stated. Line numbers refer to `6799267`.

## 1. Diagnosis: what limits close-up geometry today

**Vertex spacing.** The planet is one tan-warped cube-sphere grid (`geometry.ts`), `R·π/2 / segments` km between
vertices: 128 → 9.8 km, 256 → 4.9, 384 → 3.3, 512 → 2.45 (one height texel), 768 → 1.64 km. The 768 grid is the
cap (`main.ts:632`, R ≥ 600 km). On R = 2000 the cap is 4.1 km; on R = 300 the 512 cap is 0.92 km. Cell size varies
only ~7% over a face (tan warp), 2.45 km at the centre, 2.27 km at the corners.

**Footprint logic.** `terrain.vert.glsl:11` sets `gFootprint = max(dist·pixelAngle, 2·uVertexSpacing)` and
`octaveFade(s)` (`terrain_common.glsl:22`) keeps an octave only while `gFootprint/s < 0.6` (full below 0.25), so a
vertex carries an octave of size `s` only if `s > 3.3·spacing` (fully if `s > 8·spacing`). With the detail spectrum
`s_k = 6 km / 2.15^k`:

| octave | size | amplitude (default, ×landMask or ×fineM·gFineAmp) | slope | spacing for full geometry |
|---|---|---|---|---|
| k0 landform | 6000 m | 190 m × 0.35..1.6 | 0.03 | ≤ 750 m |
| k1 landform | 2790 m | 105 m | 0.04 | ≤ 350 m |
| k2 landform | 1300 m | 52 m | 0.04 | ≤ 160 m |
| k3 fine | 604 m | 140 m × 0.5..1.4 × 0.15..1.65 | 0.23 | ≤ 75 m |
| k4 fine | 281 m | 53 m | 0.19 | ≤ 35 m |
| k5 fine | 131 m | 20 m | 0.15 | ≤ 16 m |
| k6 fine | 61 m | 7.7 m | 0.13 | ≤ 8 m |
| k7 fine | 28 m | 2.9 m | 0.10 | ≤ 4 m |

Result: on bodies ≥ 600 km the mesh carries **no procedural relief at all**. At 768 on R 800, k0's fade is 0.07 and
k1/k2 are 0; at 512 all three are 0. The drawn geometry is the bilinear baked height and nothing finer. Only small
bodies get landforms (R 300 at 512: k0 = 0.93, k1 = 0). The fine octaves k3..k7 (`detailGrad`, `terrain.frag.glsl:174`)
are never geometry anywhere; `detailM` only knows the 3 landform octaves and the world style, while the fine style
(`fineStyle`, `gRegion`, `gFineAmp`, crack/pit masks) is computed inline in the fragment prologue (`:284-306`).

**Normal vs geometry mismatch.** The fragment normal is fully analytic: sphere normal + baked gradient (`tGrad`) +
`detailGrad` of all 8 octaves, faded by the *pixel* footprint (full down to ~3 px per wavelength). So at 0.4-6 km
(0.3-4.4 m/px at the nadir) every octave is lit as if it were there, on triangles 1.6 km wide. The biggest gap is
k3: 600 m hills of ~140 m (slope 0.23, comparable to the camera's altitude) painted on flat triangles. k0 (190 m over
6 km) and k4 (53 m over 280 m) follow. Visible as: smooth horizon silhouettes over "hilly" shading, no parallax when
flying, rocks sitting on a plane that the shading says is a slope, crater rims faceted at 1.6 km.

**Camera floor.** `surfaceRadiusKm` (`planetView.ts:456`) adds a `1.6 × detailAmp` margin (0.56 km) because the CPU
cannot evaluate the procedural relief, so the real floor is ~1 km above the baked ground (~0.7 m/px), not 0.4 km.
That margin is what real geometry plus a GPU height probe can remove: it is the user-visible payoff for fly mode.

**Shadows.** `terrainShadow` (`terrain_light.glsl:38`) marches the baked height only. New geometric relief casts no
shadows (a follow-up, not a blocker: the fine relief already has none).

**Precision.** Vertex positions are unit directions × (R + e) in km. A float32 unit vector has ~6e-8 of play, which
is 5 cm at R 800 and 24 cm at R 3000, static per vertex (it depends on the grid cell, not the camera). Acceptable for
cells ≥ ~20 m; rock facets needed a fix because they are 2-8 m. `dFdx(vWorldPos)` carries the same cm-level noise
into the footprint and texture gradients; already the case today.

**Rocks.** `rocks_place.frag.glsl:49` rebuilds the coarse mesh triangle under each rock from `(face, i, j, uSegments)`.
Any new geometry must be reproducible the same way or rocks float/sink by up to ~100 m.

## 2. Candidate techniques (WebGL2: no tessellation or compute; instancing and render-to-texture available)

1. **Push the uniform grid further (1024-1536 segments).** 1536² × 6 = 14 M vertices, 1.2 km spacing on R 800, still
   no k3. Build time ~1 s, no benefit. Rejected.
2. **Camera-centred nested rings in the anchor face's extended cube grid (geometry clipmap, CDLOD morph).**
   Keep the coarse sphere for the globe and the horizon. Add 6-7 square windows (96-128 cells each) centred on the
   camera's ground point, cell = coarse spacing / 2^k (below 25 km the coarse is pinned at 768 on R ≥ 600, so
   1.64 km → 818, 409, 204, 102, 51, 26, 13 m; on the 512 cap of small bodies, R 300: 0.92 km → 460 ... 7 m), each a
   ring with a hole where the next finer one sits. Vertices are `(i, j)` integers; the vertex shader maps them through the
   anchor face's `faceDir(st)` with `|st|` allowed past 1 (`faceST` in `cube.ts` already does this for rocks), so
   rings cross face edges continuously; the cube sphere has no pole singularity. Displacement = baked height +
   every octave the cell resolves. Grids are anchored to world cells (snap on move), so content never crawls.
   Cost: ~100-150 k vertices, each evaluating the full height function (~5% of what `detailGrad` already costs per
   pixel). Stitching: each ring's outer band morphs onto its parent (exact T-junction fix); the outermost morphs
   onto the real coarse triangles; the coarse sphere discards its fragments under the patch. Best fit; see §3.
3. **Local tangent-plane clipmap (gnomonic frame at the nadir, not cube-aligned).** No face re-anchoring, but the
   frame rotates as the camera moves (no world-anchored cells), so coarse rings drift under the camera (facet error
   ~25 m at the 613 m ring, 0.6 px at 40 km) and rocks cannot reproduce the triangles from a hash. Only worth it if
   face re-anchoring turns out visible.
4. **One high-res patch per cube face snapped to the coarse grid (a single refinement level).** Simplest stitching,
   but one level cannot span 600 m → 20 m (30x); two or more levels are the rings of (2).
5. **GPU-baked local height tiles (RTT) sampled by the rings.** One float tile per level (129² texels), re-baked when
   its window snaps (~0.1 ms for all levels). Vertex shader becomes a `texelFetch`, the morph is 2 fetches, rocks
   and the camera probe read the same texels. More machinery (6 targets, bake pass, readbacks) for a cost that (2)
   does not have. Keep as the optimisation if direct evaluation ever shows up in the profile.
6. **Per-pixel relief/parallax of the procedural height.** 8-16 march steps × 7 octaves per pixel is ~10x the fragment
   cost, cannot change silhouettes, and was already rejected for textures (`plan-closeup.md`). Rejected.
7. **Coarse-under-patch via stencil.** Would need `Depth24Stencil8`; `pipeline.ts:28` uses a `FloatType` depth texture
   that the atmosphere pass reads. Use draw order + rect discard instead (§3).
8. **Skirts.** Not needed: every boundary in (2) is an overlap band (child over the parent's hole margin, outer ring
   over the undiscarded coarse), so no surface ends where the other is not drawn.
9. **Camera-relative (eye-relative) coordinates.** Not pursued now: the 5-24 cm error sits in the float32 unit
   direction, is static per cell (no per-frame jitter), and a camera-relative matrix path does not touch it. Revisit
   only if the floor drops below ~0.1 km on R ≥ 2000 (then build the offset from the anchor direction in small
   differences and give the ring mesh the anchor as its object position, so three.js forms the modelView translation
   in doubles).

**Normals: no hand-off problem.** The mesh has no vertex normals; the fragment normal is analytic from the same
function the geometry would displace with. Geometry gives shape, the gradient gives the normal, octaves finer than
the local cell stay normal-only exactly as today. The only rule is that the patch displaces with *the same* function
(same `fineStyle`, masks and fades keyed on cell size) whose gradient the fragment takes. Do not add mesh normals.

**Features that become geometric for free** (they are already in the height function): craterlets with raised rims
(pitted, k3-k5: 100-600 m bowls), lava lobes and hummocks (billowy), dune and yardang crests (ridged), crack-plate
edges on ice/salt at k3-k4 (troughs ~100 m wide, 50-70 m deep). Candidates needing new terms, later: scree/talus
aprons at the foot of steep baked slopes, strata terraces on steep rock (quantised height on `steep`), sea-ice
pressure ridges (positive-only crests on the cell network, since the frozen datum is clamped flat), rayed ejecta
blocks stay instanced rocks.

## 3. Recommendation: cube-aligned nested rings, evaluated directly in the vertex shader

Build (2). Why: it reuses everything (same height function, same fragment shader and debug views, same cube mapping,
same triangle rule the rocks already replicate), its cost is a few hundred thousand noise evaluations per frame, it
has no new render targets, and every stitching case has an exact answer (morph onto the parent's triangle). Tiles
(5) and the tangent frame (3) are fallbacks, not starts.

Design:

- **Anchor.** Camera nadir direction, biased ahead like the rocks (`rocks.ts:155`, 0.25 of the finest window). Anchor
  face = `dirToFace(anchor)` with hysteresis (keep the face until the nadir is > 0.02 st past the edge) so
  re-anchoring is rare and happens where the finest rings are sub-pixel anyway.
- **Levels.** `cell_k = coarseSpacing / 2^k`, k = 1..K, derived from the *actual* coarse mesh (`view.segments`,
  manual override included; 1.64 km at the 768 cap on R 800). K = 6 → finest 26 m (k4 full, k5 partial), K = 7 →
  13 m (k5 full, k6 partial). Level k is drawn only while `cell_k / (groundAlt · pixelAngle) > ~3 px`, and HQ as a
  whole only below 25 km where the coarse mesh is pinned at its cap. Ring k: window N × N cells (N = 128 → 105 km at
  818 m, 3.3 km at 26 m), origin snapped to its parent's cell; hole = central `N/2 − 4` parent cells; the child's
  extra 2-4 parent cells of overlap are its morph band.
  Finest level uses a full (no-hole) index buffer; every level keeps both buffers so the finest *active* level is full.
- **Vertex shader (new `terrain_hq.vert.glsl`).** `st = origin_k + ij·cell_k` → `d = faceDir(anchorFace, st)` →
  `hM = baked + landformM + fineM` with `gFootprint = 2·cell_k` → morph: in the band, `h = mix(h_own,
  h_parent, α)` where `h_parent` is the parent's height interpolated along the parent edge (2 evaluations with the
  parent's footprint; for k = 1 the real coarse triangle through 3 `meshVertex`-style evaluations, diagonal rule as
  `rocks_place.frag.glsl:81`). Height-space mixing is fine: the sag between height- and position-interpolation is
  0.1 m at 613 m cells. Output the same varyings as `terrain.vert.glsl` (`vDir`, `vWorldPos`, `vElevM`).
- **Coarse sphere.** Drawn after the rings (`renderOrder`: rings −1, terrain 0, rock decals 0.5, rocks 0.6). Its
  fragment shader gets `uHQRect` (anchor face + inner rect of the outermost morph band, in extended st) and discards
  inside it; early-Z already rejects most of those fragments because the rings drew first. In the band both surfaces
  coincide, and z-fighting between two copies of the same material with the same analytic normal is invisible.
- **Shared height code.** Move the fragment prologue that builds the fine style (`terrain.frag.glsl:284-306`:
  splat → `fineStyle`, `gRegion`, `region2`, `macro`, `flatK/steep` from `tGrad`, `gFineAmp`) into
  `fineContextAt(d, hM)` in `terrain_common.glsl`, and split the octave loop so one function yields the height
  (`fineReliefM`) and the existing one the gradient, from the same loop and masks. This is the same refactor
  `ideas-closeup-materials.md` §3.1 wants (`hFine` for the fines-fill mask); do it once. Cracks stay normal-only at
  cells where the trough (0.16·s) is under ~3 cells: key the existing `cf` crack→billowy swap on cell size for
  geometry as it is keyed on footprint for normals. Sea ice: no fine geometry where `iceK > 0` (`elevationKm`'s
  `max(hM, 0)` would half-wave-rectify plates into bumps on a flat sea); ridges are a later deliberate feature.
- **Baked height sampling.** Rings at ≤ 800 m cells over 2.45 km bilinear texels reproduce the same creases the
  512/768 mesh has. Try Catmull-Rom (16 `texelFetch`, blend to bilinear within one texel of a face edge since the gutter is
  one texel) in the ring shader; the outer morph band blends it back to the coarse bilinear. Skip if the creases do
  not show at 1-6 km.
- **Rocks.** Replace `meshVertex(face, i, j)` with a shared `hqVertex(face, level, i, j)` in a new
  `terrain_hq.glsl` chunk used by the rings, the rocks and the probe; the placement shader finds the finest active
  level containing the rock's extended st and reproduces that triangle (morph weight included). Same GLSL, same
  uniforms → bit-identical.
- **Camera clamp.** A 1×1 (or 4×4) **RGBA** float target (`readRenderTargetPixelsAsync` throws on non-RGBA targets,
  `WebGLRenderer.js:3251`) that runs the same height function at the camera's nadir direction with the finest
  level's footprint; `renderer.readRenderTargetPixelsAsync` (in r186) with one frame of latency (at
  0.4 km the fly speed is ~8 m/frame, slope 0.2 → ~2 m/frame). `surfaceRadiusKm` uses it when HQ is on and shrinks
  the 0.56 km margin to a few tens of metres; `minAltitude` stays 0.4 km unless the user wants lower.
- **Toggle.** New `state.hqTerrain` (default `false`), Debug tab next to 'mesh / face', label "HQ terrain".
  Do not reuse `state.hq`: that is the volumetrics flag (`main.ts:57`, Atmosphere folder, drives `uHQ` and
  `sunShadow.update`). Off = zero extra draws and byte-identical frames. `renderer.compileAsync` the ring program at
  world load so the first toggle does not hitch (the terrain fragment shader is large). `forge.state.hqTerrainDebug`
  = 1 tints each level (uDebug 11) for screenshots.
- **Materials.** Ring material = `terrainMat` uniforms by reference (as `rocks.ts:82` does) with
  `#define HQ_PATCH` on the fragment, so debug views 1-10, `wireframe`, ocean/lava shells and the depth-based
  atmosphere all work unchanged.

## 4. Phased plan

**Phase 0: harness (half a day).** Add uDebug 11 (level tint / octaves carried). Take baseline screenshots, HQ off,
at the WORKLOG views (2 / 6 / 25 km and top-down) on ice shell 4242, rust 24672, sulfur, grey moon, plus 0.4 km
looking at the horizon. Record fps at 1080p. Note the camera (lat/lon/alt/heading) for each.

**Phase 1: shared height function + rings + discard (1-2 days).**
- `terrain_common.glsl`: `fineContextAt`, `fineReliefM`; `detailGrad` consumes the same context. Verify HQ-off frames
  are byte-identical after the refactor (readback diff).
- `src/render/hqTerrain.ts`: `HQTerrain` class owning K ring meshes (two index buffers each, `(i, j)` attribute),
  per-level uniforms `uLevel, uCell, uOrigin, uParentOrigin, uBand`, shared `uAnchorFace`; `update(camera,
  groundAlt, segments)` snaps origins, picks active levels; `dispose`. Rings `frustumCulled = false`.
- `src/shaders/terrain_hq.glsl` (`hqVertex`, morph) and `terrain_hq.vert.glsl`.
- `terrain.frag.glsl`: `uHQRect` discard under `#ifndef HQ_PATCH`; `planetView.ts`: expose rect uniform.
- `main.ts`: `state.hqTerrain`, pane binding, per-frame `hqTerrain.update(...)` before `rocks.update`, compileAsync.
- Pictures at the Phase 0 views; seam and popping checks (§5).

**Phase 2: rocks on `hqVertex` (half a day).** `rocks_place.frag.glsl` uses the shared function and the ring
uniforms; the edge-sweep check from the WORKLOG (lon 45°, 0.02° steps) must still give 100%.

**Phase 3: camera probe (half a day).** 1-px target + async readback in `hqTerrain.ts`, `controller.surface`
override when HQ is on. Fly into a hill at 0.4 km: no clipping. Optional slider for `minAltitude` down to 0.1 km.

**Phase 4 (optional, after sign-off).** Bicubic baked sampling if creases show. Short-range cast shadows from the new
relief: 8-12 step march of the ring height function within the finest two windows, HQ only. Sea-ice pressure ridges
and rock terraces as new height terms (they then appear in normals and geometry together).

**Performance budget (GTX 1080 Ti, 1080p).** HQ on ≤ 2 ms over the baseline at the 0.4-6 km views (baseline
~85-100 fps at 1400×850): rings ~0.3-0.6 ms vertex work, coarse discard ~0, rocks +0.1 ms, probe readback ~0 (async).
HQ off: 0 ms, byte-identical.

**Data flow per frame.** camera → anchor face/st, per-level origins (ints), active levels → uniforms → rings draw
(first) → coarse sphere draws with discard → rock placement reads the same uniforms → probe renders at the nadir →
readback lands next frame → `surfaceRadiusKm`.

## 5. Verification checklist

- HQ off: frame readback identical to master at orbit, 25 km, 2 km (after the shared-function refactor too).
- Seams/cracks: clear colour magenta, count magenta pixels inside the ground region at 0.4 / 2 / 6 km, nadir and
  horizon; with uDebug 11 ring tint on; fly east across lon 45° (face 4 → 0) and over a 3-face corner; lat ±89°.
- Popping: fly W for 20 s at 0.4 km and at 2 km (ice shell 4242, rust 24672); frame-to-frame sharp-change counts
  with the ~1 m camera-nudge method from the WORKLOG, HQ on vs off. Levels switching on/off with altitude must not show.
- Shimmer: same nudge test; ice glints and specular AA unchanged (they are per-pixel).
- Face re-anchoring: cross the hysteresis band; rocks (edge sweep) stay 100%.
- Rocks: no floating/sunk blocks at 0.4 and 2 km (compare to decal contact); edge sweep passes.
- Camera: HUD altitude at the floor; no terrain intersection flying into slopes; `near` unchanged in debug views.
- Sea ice 4242: frozen sea flat, shoreline hills gain relief, no rectified bumps on ice.
- Debug views 1-10 and wireframe on rings; cube faces (9) continuous across the ring/coarse boundary.
- Manual `meshSegments` 128/256 with HQ on: rings follow the coarse spacing (or HQ disables under an override).
- fps at 1080p at the Phase 0 views, HQ on and off; first-toggle frame time (compile) < 50 ms.
- Debug 3 (height) and 2 (normals): no change in the normals view when toggling (normals are analytic).

## 6. Risks and open questions (decisions for the user)

1. **"Sub-datum".** Confirm the resolution reading. If it meant below-sea-level/seabed detail, this is a different and
   much smaller task.
2. **Camera floor.** Keep 0.4 km, or let HQ lower it (0.1 km, ~0.07 m/px) once the probe exists? Lower floors expose
   k6/k7 (8 m, 3 m) and the 20 m finest cell; another level or two (10 m, 5 m) would be needed, and the cm precision
   floor starts to matter at R ≥ 2000.
3. **Budget.** Is ≤ 2 ms at 1080p (roughly 90 → 78 fps low down) acceptable for an opt-in toggle?
4. **Frozen seas.** Flat (as planned) or pressure ridges as part of this work?
5. **Fine-style refactor touches the HQ-off look.** It should be bit-identical; if a driver reorders the maths, tiny
   differences in the fine normals are possible. The byte-identical check is the gate.
