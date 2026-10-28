# Touch-up plan (2026-10-28)

Ten requests from the owner, reviewed with Fable (code-grounded; line refs checked).
Effort: S = hours, M = about a day, L = several days. GPU cost is against the GTX 1080 Ti budget (terrain is the whole frame).

Three shared building blocks cover several items:
- **`controller.flyTo()`**: a camera tween that any pointer input cancels. Used by #2 and #10.
- **Baked normal texture**: mipmapped, built on the CPU like the AO texture. Used by #4 and #6.
- **`PlanetInfo.pois`**: named features from the generator. Used by #7 and #10, and possibly by the captions.

---

## 1. Faster low-orbit pan with inertia — S, no GPU cost
**Cause:** drag speed is `altitude/R · fov` (`controls.ts:80`). Near the ground the view tilts toward the horizon, so the ground at screen centre is about `alt / sin(pitch)` away, much farther than `alt`. The pan is far too slow there, and there is no velocity state.
**Fix:**
- Scale the pan by the distance to the ground at screen centre: `D = clamp(alt / max(sin(pitch), 0.15), alt, horizonDist)`.
- Track a smoothed (EMA) drag velocity. On release, keep applying it with exponential decay (τ ≈ 0.6 s).
- Pointer-down, `flyTo` and the tour stop the inertia.

## 2. Pull back to the start view while forging — S, no GPU cost
**Cause:** the hologram starts at the old radius, and the camera reframes only when the radius changes by more than 15% (`main.ts` regenerate).
**Fix:** `previewWorld()` already gives the new radius before forging starts. On the swap path only (not live slider tweaks, not cache hits):
- `holo.begin(previewR)`
- `controller.flyTo({ altitude: 2.6·R, userPitch: 0, heading: 0 }, ~2.5 s, easeInOut)`, in log-altitude.
- Cache hits and live regens (where the radius slider can move) do not take that path. On those, keep the reframe when `|R − prevR| / prevR > 0.15`, but replace the instant jump with a short `flyTo` (about 0.6 s) to 2.6·R.

## 3. Show resolved values instead of -1 — M, no GPU cost
**Cause:** Tweakpane binds `gen` directly, so every AUTO knob shows -1. The resolved values exist in the worker (`plan.s`, `plan.bulk`, `plan.distortion`, feature counts) but never leave it.
**Fix:**
- Add `PlanetInfo.resolved`, filled in `buildInfo`. The cache and export carry it for free, and the generator hash invalidates old cache entries.
- Bind the pane to a shadow object `shown`. Fill it from `previewWorld` right away (cheap), then from `info.resolved` when the world lands.
- Moving a slider writes that value into `gen`, which pins it. The row label shows the state: `Volcanoes · auto` until pinned, then `Volcanoes`.
- Add a "reset to auto" button for each folder.
- `GenParams` keeps the -1 sentinel unchanged.

## 4. Detail shimmer at distance and grazing angles — S (fades) / M (with #6), about 0 GPU cost
**Anisotropic filtering is not the cause.** It is already 16× (`terrainTextures.ts:114`), and the hex-tiling `textureGrad` gradients are correct. The real sources:
1. Texture normals fade by distance only (60–900 km, `terrain.frag.glsl:357`). At grazing angles the footprint goes past the 16:1 filtering cap long before 900 km.
2. Procedural fine octaves fade on the geometric-mean footprint, so along the long axis a wavelength can drop below 1 px with nothing to filter it.
3. The macro normal comes from the R32F height texture, which has no mipmaps (`planetTextures.ts:81`), so it aliases from orbit.

**Fix:**
- Fade fine octaves at Nyquist on the long axis: `f *= 1 - smoothstep(0.5, 1, max(fpA, fpB) / s)`.
- Fade texture normals by footprint in tiles, in addition to distance.
- Source 3 is fixed by the baked normal texture (#6).
- Optional: Toksvig/LEAN-style variance into roughness. The lost normal variance becomes roughness instead of sparkle; this matters most for glossy ice and salt.
- **Triage first:** zero `fineDetail`, then `normalStrength`, then `macroNormal`, and see which one kills the shimmer.

**Repetition:** hex-tiling already breaks it up. A free ±10% brightness and roughness jitter per hex cell (the hash is already computed) is enough. Extra tile variants would double the 18 MB of textures and the sample count.

## 5. Crisp material spots (Rust) — S (renderer) / M (generator), no GPU cost
**Causes:**
- *Renderer:* only the top 3 of 8 layers are kept (`frag:283`). When layers 3 and 4 swap places, a layer pops in at full weight.
- *Renderer:* the height blend keeps only layers within 0.25 of the max, which sharpens edges further.
- *Generator:* large additive masks (+2.5 to +6) and a binary `tect` mask put whole transitions inside one texel (about 1.8 km).
- *Albedo:* dust and basalt differ about 8:1 in luminance, so every edge is a strong contrast edge.

**Fix:**
- a. Continuity: `wt[k] = max(wt[k] - w4, 0)` for the three kept layers. No cost, and it removes the pops.
- b. Widen the height-blend window with the screen footprint.
- c. Generator: sqrt the big masks, blur them 3×3 before the splat, and add noise-ragged edges (`smoothstep(.3, .7, mask + .3·n2)`).
- d. An `albedoHarmony` look knob that pulls each layer's tint luminance toward the world mean. Renderer only.

## 6. Canyon "scratches" look pixelated — M, slight GPU *win*
**Cause:** these are mostly graben about 3 texels wide with 1-texel walls (`terrain.ts:219`).
- Slope comes from a 1-texel central difference, so the rock splat is quantised per texel.
- The macro normal comes from bilinear height, so it is faceted per texel.
- Triplanar weights `pow(|N|, 6)` flip projection from facet to facet. That makes the "spots".

**Fix:**
- Bake a mipmapped world-space normal array (oct-encoded RG8 or RGB8, with gutters) on the CPU. Bilinear gradients are C0 (no facet edges), and the mips also fix orbit aliasing (#4). One fetch replaces four `surfPosBaked` samples.
- Compute the generator slope from 3×3-smoothed height, with a wider rock smoothstep.
- *Later:* derive rock-by-slope in the shader from the final normal. This needs a 4th blended layer.

## 7. POI labels at global zoom — M, no GPU cost (DOM)
**Today:** basins, volcanoes, the main canyon and the first stripe already get `makeName()` names (Planitia, Mons, Chasma, …). Rises, scarps, chaos, rayed craters and grooves have no names. `WorldPlan` never reaches the main thread.
**Fix:**
- Add `PlanetInfo.pois: { kind, name, dir, radiusRad, rank, text }[]`, built in `buildInfo`. It is deterministic, so it is cached and exported for free.
- Name the rest with IAU-style suffixes: Rupes, Chaos, Dorsum, Sulcus, Undae, Lacus.
- Rank by salience and cap at about 14.
- Draw DOM labels in the HUD style (dot + leader line), projected every frame.
- Cull analytically at the horizon, `angle(dir, cam) < acos(Rground/|cam|) − margin`, with a fade at the limb.
- Show them above about 0.8 R altitude. Declutter overlapping labels by rank. `H` hides them too.
- *Second pass:* mask-based features (dune fields, playas, lava lakes) need centroids from the stage cube.

## 8. Rust worlds all look alike — M, CPU only
**Cause:** more is fixed than just the ring waves:
- The first basin is always the full `basinSize` (`world.ts:533`).
- It always has a central peak when r > 0.22.
- It has 2–3 rings at a fixed spacing of 1 + 0.42k, width 0.045, height 0.7/k (`terrain.ts:154`).
- Rust always has antipodal chaos.
- Rises always sit on the dichotomy boundary, and the canyon always starts from a rise.
- The relief caps then flatten the deepest basins to the same floor.

**Fix:** a random type roll for each basin. Today's look stays as one possible roll.
- Shape: elliptical or oblique, with butterfly ejecta.
- Centre: peak-ring, central peak, or flat flooded floor.
- Age: a degraded old basin gets a smoother profile and a broken-up rim.
- Rings: 0–4, spacing 1.3–1.8×, random widths, with radial sculpture from azimuthal noise.
- Secondary crater chains.
- The first basin's size becomes `basinSize · (0.6 … 1)`, with some chance of no giant basin at all.
- Rust gets a chance to skip the antipodal chaos.
- New AUTO knobs: `basinRings`, `basinAge`, `basinEllipticity`. Drama and the caps stay.
- ⚠ This changes existing seeds, including the README worlds (`#rust/78915` and others), so the screenshots must be redone.

## 9. HQ volumetric dust with terrain shadows — L
**Today:** there is no HQ mode. The haze march is 16 fixed steps, and its sun occlusion uses only the smooth ground sphere. `uJitter` exists but is unused.
**Proposed (Claude): a shadow-height map.** For each cube-face texel, store the altitude above which a point is sunlit. For a flat heightfield under a parallel sun, being lit is monotonic with altitude, so one threshold per column is exact. On a curved, distorted body it is an approximation (horizon mapping), but a good one at haze altitudes. The lookup is `cubeTexCoord(sampleDir)` per haze step, which already exists.
- Build it with a GPU pass that marches toward the sun for each texel (6 × 256–512², about 64 steps).
- Rebuild only when the sun, the planet or the exaggeration changes. Spread it over frames when the day cycle runs.
- Each haze step does one fetch: `lit = alt > hs(dir)`.
- It works at every zoom (no ortho-map resolution trade-off).
- It can replace the 24-step terrain shadow march at orbit range, a perf win in the terrain shader.

**Alternative (Fable):** a sun-space orthographic depth map (2048², about 0.6 km texels at R = 600 km), plus 1 fetch per step.

**HQ toggle:**
- 32–48 haze steps, with blue-noise temporal jitter and light TAA or a bilateral upsample.
- Shadowed in-scatter.
- More atmosphere steps.

**Cost:** about 1 ms when the map is rebuilt, plus about 1 fetch per haze step. Off by default.

## 10. Auto-tour button — M, no GPU cost (needs #2 and #7)
The planet occludes the sun disc correctly (depth 0.99999 with the depth test on), so a "barely peeking" star works.
A segment script on top of `flyTo`:
1. **Global pass** at about 2.6 R, slewing through the top POIs; captions name each one.
2. **Terminator view**: lon = sun ± 90°, about 1.2 R, heading across the terminator. The low local sun comes from sitting on the terminator; `sunElevation` only tilts the terminator toward the poles.
3. **Flyby**: descend to 15–40 km over POI #1 (along a rift tangent if it is a canyon) and dolly for about 8 s with auto-tilt.
4. **Lift-off**: exponential climb to about 3 R while moving to the night side.
5. **Crescent**: place the camera so `dot(n, S) = −cos(asin(Rlimb / D) + ε)`. `Rlimb` includes the max relief. Bloom does the rest. Hold for about 6 s, then hand control back.

Auto-rotate and inertia are suspended during the tour. Any input cancels it. The sun and look settings are restored afterwards.

---

## Order
- **Batch A, quick wins:** #1, #2 (with `flyTo`), #5a top-3 continuity, #5d albedo harmony, #4 footprint fades and hex-cell jitter. Then #3.
- **Batch B, surface quality:** baked normal texture (#6 and #4 source 3), smoothed generator slope, splat edge softening (#5c).
- **Batch C, generator:** #8 basin variety, then #7 POI data and labels.
- **Batch D, showpieces:** #10 tour, then #9 HQ volumetrics (shadow-height map, which can also replace the terrain shadow march).

## Decisions for the owner
- #8 changes how existing seeds look. Is that OK? The alternative is a versioned generator flag.
- #3: is "moving a slider pins the value" the right UX? The alternative is an explicit auto checkbox on each row.
- #9: shadow-height map or sun-space ortho map?
