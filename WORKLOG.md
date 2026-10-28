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
- **Wilder worlds** (user: "more wild/distorted/pronounced"): a generator agent (Opus) lifted the stacked-relief caps
  and added a distortion knob with lumpy/triaxial figures for all radii (see below).

## 2026-10-28 05:40–06:30 — wilder worlds, figure atmosphere, publish
- **Generator:** relief caps scale with drama (`capK = 0.45 + 0.95·w`). The new `distortion` param (AUTO) builds
  triaxial/lumpy figures, hard-clamped to ±24.5% R. Mean relief is now 5–16% of R by archetype (wild 16.4%, basalt 13.8%,
  cryo 13.0%); extremes reach 39–47% total relief. High calderas on lava worlds become lava lakes (unit 19).
- **Atmosphere follows the figure:** a 64×32 equirect map of the smoothed body shape (about a 10° cap average).
  Altitude for density and haze is measured above it, and the shells grow by the highest point. Lumpy worlds no longer
  float inside a detached spherical halo, and deep basins are not whited out.
- **Molten calderas** glow (crust cracks over a dark melt), with a footprint fade so they don't sparkle from orbit.
  The lava sea gets the same fade.
- **Haze retune:** dense-air worlds (basalt, 0.09 bar) were veiled milky. Haze is now `0.5 + 7k²` (was 13k²) with
  a lower scale height.
- **Publish:**
  - GitHub Pages via the Actions workflow.
  - Cloudflare assets-only Worker at planet-forge.ioupg.com, through the `cf` CLI. `DEPLOY_TARGET=cloudflare`
    switches the Vite base to `/` and enables `@cloudflare/vite-plugin`.
  - The README was rewritten with demo links and screenshots.

## 2026-10-28 afternoon — touch-ups (branch `touchups`, 10 user items, plan in `docs/plan-touchups.md`)
- **Camera:** pan speed comes from the ground distance at screen centre (about 10x faster low down), with throw
  inertia (τ 0.7 s). `flyTo` (ease in-out, log altitude) pulls the view back to the opening framing while a new world
  forges.
- **Materials:**
  - A layer enters the top 3 at zero weight (no pops).
  - Splat edges are ragged (fbm) and blurred 3x3 in the generator, plus a light albedo-harmony pull.
  - Detail octaves get a long-axis Nyquist fade and per-hex-cell brightness jitter.
  - Far away the height-blend window widens (0.25 → 0.35) instead of falling back to plain weights. The first version
    used plain weights and turned Sulfur's dark flows grey from orbit; caught against master in a side-by-side worktree.
- **Relief normal** comes from a baked, mipmapped RGBA16F height-gradient texture (no per-texel facets, no orbit
  aliasing). Rift walls are never narrower than 1.6 texels.
- **AUTO params** show the value the generator resolved, dimmed. Tweakpane snaps on refresh, so a change within half a
  step counts as a resync, not a pin.
- **Basins** (seeds changed, user OK'd): oblique/elongated with butterfly ejecta, scalloped rims, peak / peak-ring /
  flat / bowl floors, 0–4 broken rings, age wear. Antipodal chaos rolls at 60%. New `basinOblique`, `basinRings` and
  `basinAge` knobs.
- **Landmarks:** the planner names up to 16 POIs (basins, volcanoes, canyons, rises, chaos, rayed craters, caps).
  Labels fade by zoom and limb and are decluttered by rank. `L` toggles them.
- **HQ volumetrics:**
  - A 3x2 face atlas (512² per face, RG16F) stores the height where sunlight starts and the shadow's lift above the
    ground. It is rebuilt only when the sun or the relief changes: 9 rebuilds a second under the day cycle with no fps
    change.
  - The haze march (48 steps in HQ) and the low Mie dust test against it.
  - "Dust shafts" (default 3) stretches the shadow volumes upward. Physical shadows on gentle worlds are only a few km
    tall and barely show; stretched, a canyon rim throws a long dark wedge at low sun. Lit ground keeps zero lift, so
    shafts still start where the ground shadows do.
  - Cost on a 1080 Ti at 1800x1012: low altitude 66 → 56 fps, none from orbit. On by default.
  - Debug aid: `forge.state.hqDebug` = 1 shows the shadow-map verdict on the ground (matches the terrain's own
    shadows), 2 shows the haze glow only.
- **Tour** (button / `P`):
  - Orbit pass over the lit landmarks, with captions on arrival.
  - Terminator view, aimed from the horizon dip.
  - Cross-lit low flyby. Straight down-sun went black behind volcano flanks.
  - Climb over the night side to a crescent shot: dot(c,S) = -cos(asin(R/D) + ε), with ε drifting from -5° to +0.15°
    so the star rises past the limb.
  - Any input cancels it; auto-rotate and labels are restored afterwards.
- README screenshots retaken side-lit (65° phase). Basalt is now shot from the lava-sea side.
