# Close-up quality plan (branch `exp/closeup`)

User ask (2026-10-30): drop the eruption plumes; make low fly-by views look better without heavier texturing.
Fix the "crocodile skin" detail, the shimmering light on the ice world, the lack of variety, add rock/debris clutter,
and try parallax mapping if it fits the performance budget.

Plan reviewed by Fable (design consult), checked against the code. Baseline: GTX 1080 Ti, 1400x850, ~70-85 fps at
2-6 km above the ground.

## What the baseline shows and why

- **Crocodile skin.** The 5 fine detail octaves (k3..k7: 604, 281, 131, 61, 28 m) share one style per material, so
  ice and salt get a Worley crack net at every scale. The crack profile is only C0 at the trough edge, which draws a
  hard polygon outline, and the crack slope is about 4-5x stronger than the other styles at the same weight. The ice
  and salt textures (Ice002, Ground031) are crack textures too, and at 250x they tile at about 750 m, the same size as
  the k3 plates: two polygon nets at one scale.
- **Ice shimmer.** Ice keeps its texture roughness (~0.21) under a 6x sun, and the high-frequency normals alias
  (k7 crack troughs are ~2 px wide at 2 km and never fade). There is no specular anti-aliasing.
- **No variety.** Style and amplitude are the same everywhere for a material. Nothing depends on slope, cavity or region.
- **Geometry.** At R >= ~450 km the mesh carries no procedural relief at low altitude: the footprint floor is 2 vertex
  spacings and the mesh caps at 384 segments, which undersamples the 512 heightmap.
- **Scale of clutter.** The camera never gets lower than ~1 km over the baked surface: ~0.9 m/px there, ~1.9 m/px at
  2 km, ~5.5 m/px at 6 km. Rocks must be blocks of 3-40 m (ejecta), not 1 m pebbles, and their window must scale with altitude.

## Phase A: terrain shader (cost ~0, maybe cheaper)

1. **Cracks.** Smooth (C1) crack profile with a gentler slope. Per-octave style masks: cracks only at k3-k4
   (1.0, 0.6, 0.15, 0, 0), pits fade from k5. k6-k7 use a cell-free octave function, so the shader skips 2 Worley evaluations.
   Crack-specific footprint fade. No cracks on slopes. Crack weight moves to billowy/ridged instead of disappearing.
   Region noise (~30 km) makes crack fields come and go.
2. **Texture vs. procedural scale.** Per-layer texture scale (ice 0.25, salt 0.3) and per-layer texture normal strength
   (ice 0.35, salt 0.45, basalt 0.8), so the ice texture reads as fine fracture grain inside the plates. The hex grid
   stays on the unmultiplied scales.
3. **Ice shimmer.** Screen-space normal variance turns into roughness (Tokuyoshi/Kaplanyan), plus a 0.32 roughness
   floor for glossy layers and more roughness far away.
4. **Variety from data that is already sampled.** Dust settles in cavities and on flats. Scree is brighter and rougher on
   slopes. Region jitter of roughness and albedo, roughness jitter per hex cell, regional amplitude of the fine relief.
5. **Geometry.** `detailM` stops when an octave is fully faded. More mesh segments at low altitude (768 on big bodies,
   512 on small ones).

## Phase B: instanced ejecta blocks (~1 ms)

- Two camera-anchored levels hashed by world cell (no popping): L0 8 m cells (2-8 m blocks) below 2.5 km, L1 40 m
  cells (8-40 m) below 12 km. Each is 96x96 instances.
- A placement pass (a full-screen quad into a 96x96 float MRT) works out each instance from the cell hash.
  - Density comes from the splat (rock > gravel > basalt > highland > ice > dust), slope and cavity AO. None under the sea.
  - Sizes follow a power law.
  - Each block sits on the actual mesh triangle (same tan grid and diagonal as `geometry.ts`), so it never floats when
    the procedural detail is fragment-only.
- Rocks are noise-displaced icospheres. They use the terrain's lighting (shared chunk), its cast shadow at the rock,
  a fake base contact AO and the rock layer texture. Haze works for free through the depth buffer.
- Shadows start as coplanar multiply decals: a contact blob plus a lobe stretched along the sun. A camera-local
  shadow map only if decals fail.

## Parallax mapping: skip

Triplanar x 2 hex cells x 3 layers multiplies the march about 18x. At 250x texture scale a height parallax implies
tens of metres of relief that swims with the view. At real texture scale (2-3 m tiles) it is sub-pixel from 1-6 km.
The budget goes to rocks instead. Optional later: a near-field grain layer (dominant layer and projection only,
luminance and normal only).

## Pitfalls

- `dFdx(N)` must stay in uniform control flow at the top level of `main`.
- D3D flattens data-dependent branches. Remove work with constant loop bounds or separate functions, not uniform branches.
- Use uint PCG hashes for cell indices up to ~1e5. Float hashes correlate at that size.
- `uSegments` must follow `view.segments` every frame, or rocks float.
- Mask rocks under the sea and in debug views.
