# Work log

Newest entries at the bottom. Times are local.

## 2026-10-28

- **02:55** Scaffolded the repo (vite 8, three 0.186, tweakpane 4, vitest, TS 5.9).
  Wrote `CONTRACT.md`, `src/core/cube.ts` (tan-warped cube sphere, 1-texel gutters, bilinear `sampleDir`, `refillGutters`),
  its GLSL twin `src/shaders/cube.glsl`, and `src/core/types.ts` (PlanetData, 8 fixed splat layers). Cube tests pass.
- Decisions:
  - Live generation runs in TS Web Workers so the viewer controls respond immediately. Python (uv) handles offline assets: the texture pack and the HDR sky.
  - Custom `ShaderMaterial` with its own GGX instead of patching `MeshStandardMaterial`. There is one sun plus ambient, and owning the shader keeps it portable to the CDLOD engine.
  - Height, splat and climate are stored as 6-layer `DataArrayTexture`s, which matches the engine's cube-face tiles.
  - Erosion is a whole-cube pass. Buffers are transferred between workers (no SharedArrayBuffer, so no COOP/COEP headers needed).
- **03:10** Asset agents (Sonnet) finished:
  - Sky: `tools/make_sky.py` writes a procedural Milky Way (`public/sky/milkyway.hdr`, RGBE 2048×1024) and 15k blackbody-coloured stars (`stars.bin`). Preview is in `docs/sky_preview.jpg`.
  - Textures: `tools/fetch_textures.py` pulls 8 CC0 ambientCG sets (2K, downsampled to 1K) and packs albedo/normal(GL)/ORM/height plus a synthesized FFT water normal. 20.9 MB total. See `public/textures/ATTRIBUTION.md` and `docs/textures_preview.jpg`.
  - The generator agent (Opus) is still running. Renderer work has started in `src/render`.
- **03:20** Renderer v1 is up: displaced cube-sphere, triplanar 4-of-8 splat PBR with height blending, ocean/lava/ice shell, post-process
  Rayleigh+Mie atmosphere using the depth buffer, HDR sky with point stars, sun glare, bloom, ACES, terrain-aware orbit camera
  with horizon tilt, and a Tweakpane UI. Procedural detail relief lives in a shared GLSL height function (vertex and fragment).
- **03:35** **Direction change (user):** small believable *rocky* worlds built through a formation history (core formation,
  bombardment, volcanism, tectonics, volatiles), with features sometimes blown out of proportion. Not Earth-like. No cloud layer,
  but there is always some atmosphere.
  - Contract: the 8 layers are now geological (dust, highland, basalt, sand, rock, gravel, ice, salt). Clouds are removed.
    New `PlanetData.info` holds bulk physics, a history timeline, geologic units and look hints.
  - The generator agent (Opus) was redirected mid-flight with the formation-pipeline design. Its infrastructure (noise, erosion, workers, CLI) is kept.
  - A texture agent (Sonnet) re-fetched a geological set (ambientCG Ground099/Ground022/Rock050/Ground097/Rock022/Ground108/Ice002/Ground031).
    The albedos are part-desaturated so per-world tints can colour them. 18 MB.
  - Renderer: clouds removed; the look is driven by generator hints ("auto look"); geologic-map debug view; HUD shows bulk facts and a formation timeline.

## 2026-10-28 03:58 — real generator wired, seams, perf
- `src/app/generate.ts` now calls `generatePlanet` (gen/index.ts); dev stub deleted. Archetypes: rust, cinder, grey moon, ice shell, old ice, sulfur, basalt, cryo, wild (Ceres-scale, no water seas).
- Face-edge seam lines were a renderer bug: implicit-derivative mips on `tc` (jumps at cube edges -> coarsest mip). Splat/climate now use `textureLod` with LOD from `dFdx(vDir)`.
- Perf (GTX 1080 Ti, 1689x1269): terrain was the whole frame (165 fps without it vs 31 with).
  - Adaptive mesh density from on-screen ground size (~5 px/quad, cached 96..384 geometries).
  - Hex-tiling grid shared per projection (not per layer/map), fixed 2 samples per lookup
    (D3D flattens data-dependent branches, so skipping samples in branches does not help),
    top-3 splat layers instead of 4.
  - Result with hex-tiling on: orbit 33 -> 66 fps, planet filling screen 30 -> 57, low 49 -> 78, ground 67 -> 94.
- Atmosphere scale heights clamped below the shell height (generator hints gave a hard-edged halo).

## 2026-10-28 04:00–05:40 — surface detail, light, haze, publish prep, presentation
- **Fine relief:** sub-heightmap bump octaves (later replaced, see below).
- **Ground haze:** a separate, dithered 16-step haze march inside R + 6H. Haze strength and height come from surface
  pressure (k = (log10 p + 7) / 5): a faint exospheric hint on airless bodies, a dusty horizon on thin-air worlds,
  tinted from the dust layer.
- **Shadows and AO:** 24-step heightmap ray-march cast shadows (soft penumbra), a 2-scale cavity AO baked on the CPU
  (summed-area tables), texture micro-shadowing, an opposition surge. Dry layers are matte (roughness floor, specular
  scale); ice and salt stay glossy.
- **Atmosphere vs. sub-datum terrain:** the ground sphere is now the lowest terrain (`uGroundRadius`), density continues
  below the datum (capped at -0.7 H), and haze sun-occlusion uses the same sphere. Fixes the dark fake horizon and
  basin whiteout.
- **Publish prep:** base-relative asset URLs, Vite base `/planet-forge/` for build and preview, GitHub Pages workflow
  (typecheck, tests, build, deploy).
- **Detail styles (user: "dunes texture doesn't fit all", "detail horizon too close"):**
  - The procedural relief is one spectrum (uDetailScale / 2.15^k) evaluated with analytic gradients (simplex with
    derivatives, plus a cheap 2x2x2 Worley).
  - Four styles: ridged, billowy, cracked, pitted. Landform octaves (geometry) follow the archetype; fine octaves
    (normal only) follow the local material: dunes on sand, crack networks on ice and salt, lobes on basalt, craterlets
    in regolith. Craterlets thin out where there is air.
  - The macro normal uses the baked heightmap only. Detail fades at about 3 px per wavelength on the geometric-mean
    footprint (the grazing long axis alone erased it near the camera), so it now reaches about 3x farther.
- **Planet cache:** IndexedDB (localStorage is too small: about 25 MB per 512² world). Keyed by params plus a
  build-time hash of the generator source, LRU with 6 entries, off in dev. `#archetype/seed` URLs make worlds
  shareable and cache-friendly.
- **Presentation (user ideas):**
  - A faceted "cyber-space" hologram stands in while a world forges: it blinks, fills in with progress and dissolves
    when the world lands. It replaces the loading screen and progress bar; during live slider tweaks it is a faint
    overlay.
  - Bulk facts decode into the HUD one by one like scan results while forging.
  - The formation history plays as quiet film-style captions (T toggles).
- **Night side:** planetshine fill from the parent giant (wrapped Lambert, about 1:8 vs. the sun) plus a higher space
  ambient. The night side used to sit about 1000x below the day side and crushed to black under ACES.
- **Wilder worlds** (user: "more wild/distorted/pronounced"): a generator agent (Opus) is lifting the stacked-relief
  caps, adding a distortion knob and lumpy/triaxial figures for all radii. In progress.
