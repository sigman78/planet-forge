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

## 2026-10-30 — close-up quality (branch `exp/closeup`, plan in `docs/plan-closeup.md`)
- **Dropped the eruption plumes.** The branch starts from `e9cb68c`, before the plume commits. They did not fit the planned look.
- **Fable design review** of the low-flyby look. Its plan and reasoning are in `docs/plan-closeup.md`.
  Parallax mapping was skipped: triplanar x 2 hex cells x 3 layers multiplies the march about 18x, and at 250x texture
  scale it would fake tens of metres of swimming relief.
- **Phase A (terrain shader):**
  - **Crack skin removed.**
    - Cracked plates now appear only at the two coarsest fine octaves. Craterlets thin out toward the finest octave.
    - The two finest octaves use a crack-free function, which drops 2 Worley evaluations per pixel.
    - Smooth (C1) crack profile, 0.6x crack slope, and a crack-specific footprint fade.
    - No plates on slopes: their weight goes to ridged relief.
    - ~30 km region noise switches crack fields on and off and shifts the plate size.
    - Rounded creases and a steeper falloff on the finest billowy octaves (no more crumpled paper).
  - **Ice and salt textures** tile 4x / 3.3x smaller with 0.35 / 0.45 normal strength, so the texture cracks read as
    grain inside the plates instead of a second plate net at the same size.
  - **Ice shimmer:**
    - Specular AA from screen-space normal variance (Tokuyoshi/Kaplanyan).
    - Glossy roughness floor of 0.32, plus extra roughness far away.
  - **Variety** (`weathering` slider):
    - Dust settles in hollows and on flats.
    - Brighter, more ridged scree on slopes.
    - Regional drift in roughness, brightness and ice hue.
    - Regional smooth/rough patches in the fine relief (two noise scales).
  - **Mesh:** up to 768 segments below 25 km on bodies >= 600 km (512 on smaller ones). `detailM` stops at the first
    fully faded octave. The 768 grid takes ~220 ms to build, so it is pre-built at idle when a world lands.
  - **fps** (1080 Ti, 1400x850, 2/6/25 km and top-down, before -> after):
    - ice shell 95/90/87/89 -> 101/96/90/91
    - rust 104/89/85/104 -> 110/106/94/94
    - grey moon 90/85/80/94 -> 97/90/81/107
    - sulfur 92/83/82/79 -> 86/79/72/94 (R 725 km, the 768-segment mesh)
- **Phase B (surface rocks, `src/render/rocks.ts`, `rocks` slider):**
  - **Three levels of instanced blocks.** Each level is a 96x96 window of world cells that follows the camera,
    mostly ahead of it.
    - 30 m cells, 2-8 m blocks, below 3 km
    - 120 m cells, 6-25 m blocks, below 9 km
    - 450 m cells, 20-80 m blocks, below 30 km
    - A block of radius r stays above ~2 px out to about r x 1000, so each window is sized to that reach.
  - **Placement pass on the GPU** each frame (288x96 float target, 3 texels per instance).
    - A PCG hash of the world cell picks jitter, size (power law) and seed, so rocks stay put while the window moves.
    - Density comes from the splat (rock > gravel > basalt > highland > ice > dust), slope, cavity AO and a
      rock-field noise. No rocks under the sea.
    - Each block sits on the rendered mesh triangle: same tan grid, diagonal and vertex displacement as the terrain.
    - Terrain cast shadow is sampled once per rock.
  - **Rocks:**
    - Lumpy, flattened, faceted icospheres with a per-instance noise shape.
    - Real-scale texture from the layer they came from, slightly brighter than the regolith.
    - Same BRDF and cast shadow as the ground (shared `terrain_light.glsl`).
    - Base contact occlusion, and bounce light from the sunlit ground (otherwise shadowed faces are black on airless worlds).
    - Blocks below ~1.5 px shrink away. Blocks grow in and out at the window edge.
  - **Shadows:** tapered decal per rock in its triangle plane, stretched away from the sun by its elevation and
    multiplied into the ground. Skipped where the terrain is already in shadow.
  - **Cost:** about 1.2 ms (ice 2 km 101 -> 90 fps, sulfur 2 km 86 -> 78). Every test view stays >= 70 fps.
  - **Known gaps:**
    - The window re-hashes when its anchor crosses a cube-face edge.
    - Decals can clip where a long shadow crosses a mesh edge.
    - The rust texture normal still reads as streaky "fur" at very low sun.

## 2026-10-30 — rocks across cube edges, volumetrics off, mood grade

- **Rocks no longer reshuffle at cube-face edges.** Before, each level's window ran on the anchor face's cell grid
  past the edge. When the window centre crossed the edge, every cell was re-indexed and re-hashed in the new face's
  grid. Now each cell belongs to the face it lies on. Each level renders one 96x96 window per face that its rock area
  touches (up to 3 at a corner), stacked in a 288x288 target. Cells off a window's own face exit before any terrain
  work, so near an edge the placement cost stays about the same.
  - The edge fade is measured from the unsnapped centre in the rock's own face grid. It changes smoothly
    (it used to step by a cell as the window snapped) and the same way in every window.
  - Check: swept the camera east across lon 45° (face 4 to face 0, rust 24672) in 0.02° steps and read back
    the placement targets. Old code: 0% of rocks survive the flip. New code: 100% at every step for levels 1-2.
    A second sweep at 0.4 km over lon 135° (face 0 to 5, lat -29°): level 0 keeps 100%, level 1 99.93% (a couple of
    rocks moved over 3 m at one step, most likely a mesh-density change). The 3-face corner case is untested.
- **HQ volumetrics are off by default** (`state.hq`). The terrain shadow map's dust shafts added little to the
  picture. The toggle and the 'dust shafts' slider stay in the Atmosphere folder.
- **Mood grade** (`mood grade` slider, Atmosphere folder, 0-3, default 2), at the end of the atmosphere pass in HDR:
  - **Strength:** set by the air's extinction at the camera (`1 - exp(-ext * 80 km)`), and off on the night side
    (planetshine lights the ground there, not this sky). Orbit and airless worlds are untouched.
  - **Scope:** grades only the scene seen through the air. The inscatter is added after the grade, since it already
    has the sky's colour (Fable's review: grading it double-tints the haze).
  - **Tint:** shadows take the colour of the sky's scattered sunlight (Rayleigh + Mie + haze colour, times the sun
    colour, chroma x1.4). Sunlit tones keep the sun's colour.
  - **Dust veil:** dust and haze lower contrast (around a pivot set by exposure) and saturation. Clean Rayleigh air
    barely does.
  - **Result:** at the default 2, Earth-like air gives clearly cooler shadows and sunlit sand stays warm (1 was too
    subtle once the inscatter was left out). On the rust world it stays mild, because its sky is already the ground's
    colour.
- **Fable review of close-up materials:** `docs/ideas-closeup-materials.md`. It covers why the detail textures override
  the relief, a parent-mineral -> weathering-products material model, and ranked cheap changes.

## 2026-10-30 — rock normal precision, ice sheen back

- **Rock facets shimmered** (large planets, grazing light). The flat facet normal came from `dFdx/dFdy` of the
  world position, which is ~1e3 km from the planet centre. There float32 steps (6-25 cm) exceed the pixel-to-pixel
  change on a close block, so the normal was mostly rounding noise and changed on every camera move. It now comes
  from the small rock-relative offset (`vOffset`). Check on rust radius 2000 km with a 10° sun, nudging the camera
  ~2 cm: pixels on a 77 m block that change sharply went from 52 to 24. The rest are the terrain's own changes.
- **Ice lost its sheen and went plain or dirty white** after the close-up pass (`58aa381`). Causes and fixes:
  - **Gloss floor:** the 0.32 roughness floor and +0.3 distance roughening for glossy layers are now 0.22 and +0.15.
    The specular AA kernel went from 0.5x variance (cap 0.18) to 0.3x (cap 0.1).
  - **Dirty white:** ice and salt hollows collected the grey dust colour. They now collect frost: the ice's own
    albedo, brighter and a little desaturated, staying fairly glossy.
  - **Plain white:** ice/salt textures had been shrunk 4x / 3.3x with normals at 0.35 / 0.45, so from mid range the
    crack grain averaged out. They are now 2.5x / 2.2x with normals at 0.55 / 0.6.
  - **Glints:** the old sheen was mostly glints from aliased sub-pixel normals, which was the shimmer. They are back as
    *world-anchored glints*: each world cell of ~1.5 px holds (or not) one random facet (~0.35 rad tilt) that flashes
    when it mirrors the sun. Two power-of-two cell sizes cross-fade with the footprint, and glints fade beyond
    ~50 m/px. They twinkle with the view but don't crawl. Shimmer check (ice shell 4242, 8 km, 18° sun, ~1 m camera
    nudge): pixels that change sharply, pre-close-up build 128, now 1.
  - **Highlight toned down:** the smooth specular lobe on ice/salt is halved (`brdfS` takes a specular scale). Under
    a 6x sun at grazing angles it blew out to plain white; the glints carry the sparkle.
  - **Glint tuning:** at 50% facet density, a 6.8° tolerance and 12x strength, the glints lifted the whole field
    (near-ground mean 231 vs 178 pre-close-up). Now 30% density, ~4.8°→2.1° tolerance, 5x: mean 193, crack detail
    visible through the highlight.
- **Frozen seas no longer move.** Ocean mode 2 (sea ice, e.g. ice shell) used the water's wave normals, which drift
  with `uTime`, so the ice looked like slow water. `waveNormal` takes the time explicitly; sea ice passes 0.

## 2026-10-30 — frozen seas folded into the terrain (Fable inspection)

- **Owner report:** a crack in the sea ice you could see under, and the surface shifting between the lit and debug
  views low over the ice shell. Fable diagnosed it (runtime-only patches, red = visible terrain below the datum,
  pixel counts over 8 shoreline spots):
  - **Hole at steep shores:** `ocean.glsl` discarded shell pixels where the *bilinear baked* height was over 2 m.
    The mesh is vertex-sampled and linear across ~1 km triangles, so on cliffs whole triangles sat up to ~100 m
    below the datum with the ice above them discarded.
  - **Lattice on gentle shores:** the 160-segment shell's flat facets sag R·θ²/4 (~8.5 m at R 352 km) between
    vertices, and shallow seabed poked through.
  - **Debug shift:** debug views hide the shell, and `surfaceRadiusKm` keyed the camera floor on
    `ocean.visible`. The floor dropped to the seabed, so the camera re-tilted (20° -> 25°) and `near` jumped
    0.15 -> 1 km.
- **Fix (owner's idea): frozen seas are part of the terrain.**
  - **Shape:** `elevationKm` clamps to the datum when `uSeaIce` is set. That one point feeds the mesh, rock placement,
    both sun-shadow marches (terrain and HQ map), the camera floor (CPU mirror), the atmosphere ground radius and the
    figure texture.
  - **Material:** the fragment classifies ice by the per-pixel height (a smooth shoreline; the mesh gave a stair of
    triangle edges) and keeps it off ground whose drawn height visibly climbs. There it flattens the macro normal,
    swaps the splat to the ice layer (cracks, gloss, glints, frost come along), tints a touch bluer, and drops the
    seabed AO and settling.
  - **The shell is now only for water and lava.**
- **Shell fixes for water/lava:**
  - Lava no longer discards on the baked height; the depth test makes the shore.
  - The shell's vertices are pushed out by θ²/4 so its facets no longer sag below the datum.
  - `seaSolid` (any sea) is the camera floor and the rock mask, independent of whether the shell is drawn.
  - Rocks are masked within 3 m of the datum or on the placed point at the datum.
- **Check (ice shell 4242):**
  - Debug view 1 over the basin at 0.6 km: camera position, pitch and near are identical to the lit view.
  - The steep shore at lat 0.4631, lon -2.7096 shows hills rising out of flat ice with smooth shorelines.
  - Water and lava modes still render through the shell.
- **Open:** water still fades on the baked height at the shore (`alpha *= smoothstep(-2, 1, depth)`), which can
  leave straight-edged gaps at steep shores (Fable's follow-up).

## 2026-10-30 — camera without gimbal lock, keyboard fly

- **Gimbal lock (user):** the camera stored lat/lon/heading and built its frame from the world up. Orbiting stopped at
  ±89° latitude, the heading spun near the poles, and east-west drags sped up as 1/cos(lat).
  - `controls.ts` now keeps one quaternion frame (right, local up, forward) and eases it with a slerp. Orbit drags,
    throws (an angular-velocity vector), auto-rotate and heading turns are all rotations of that frame.
  - lat, lon and heading are getters read from the frame, so the HUD, the tour and `setView` keep their API.
  - `flyTo` moves along the great circle, carries the heading with it and blends in the remaining twist. It lands
    exactly on the requested lat/lon/heading.
  - Verified: dragging north runs straight over the pole (lat 1.56 → 1.08 on the far side, heading 0 → π), and the camera has no roll.
- **Keyboard fly (user):**
  - W/S fly along the ray under the cursor, so the point being flown at stays under the cursor (screen centre when the cursor is off the canvas).
  - A/D strafe, E/Q go up/down, arrows turn left/right (up/down = W/S), shift is ×4.
  - Speed is 1.2 × the height above the ground per second, so the approach slows near the ground and the terrain clamp stops it.
  - Keys cancel the tour or a flight, and are ignored while typing in a pane field.
  - Altitude below the datum (deep basins) now eases linearly instead of in log space.
  - Help line updated.

## 2026-10-30 — HQ terrain: sub-datum mesh rings (branch exp/hq-subdiv)

- **Request (user):** an HQ mode toggle that adds procedural geometry finer than the baked height, measures its cost
  and lets the camera go closer. Fable's plan is in `docs/plan-hq-subdivision.md`.
- **Rings:** `src/render/hqTerrain.ts` draws up to 9 camera-centred, cube-aligned grid rings (N = 64 cells per side,
  each level half the cell of the one outside it) on the face under the camera.
  - The vertex shader displaces them with the full height: baked + landform octaves + the fine octaves the fragment
    normals already paint (`terrain_fine.glsl`, a vertex-side mirror of the fragment's fine relief; keep in sync).
  - Origins are snapped to the parent grid. Each ring morphs onto its parent toward its edge, and the outermost one
    morphs onto the coarse mesh triangles, so the levels meet without cracks or skirts. Levels fade in by pixel size and
    the whole thing fades out between 14 and 20 km above the ground.
  - The coarse mesh under the rings sinks by 3 km, so depth testing rejects it. There's no discard.
  - The rings use exactly the coarse terrain's fragment source. A `#define` variant compiled ~40% slower on D3D;
    `uHQLevel` (0 on the coarse mesh) drives debug view 11, "HQ levels".
- **Closer:** a 1-pixel probe evaluates the ring surface height under the camera (async readback). With HQ on, the
  ground clamp uses it and the floor drops from 0.4 km to `HQ floor` (default 0.1 km, Debug tab).
- **Rocks** are placed on the ring triangles (shared `terrain_hq.glsl`). The first version inlined the ring vertex
  rule per level and corner. On D3D that made a shader that hung the GPU process (context lost), so the level loop now
  only finds the ring, and one 3-corner loop builds the triangle.
- **Cost** (GTX-class, 1920×1080, rust 26508 rugged spot, rocks on, GPU timer medians; HQ off is ~16 ms):

  | height above ground | N = 128 | N = 64 |
  |---|---|---|
  | 0.1 km, horizon | +8.2 ms | +5.9 ms |
  | 0.4 km, horizon | +6.5 | +5.2 |
  | 2 km, horizon | +4.7 | +4.0 |
  | 6 km, horizon | +4.3 | +2.1 |
  | 2 km, looking down | +2.7 | +0.8 |

  - Rock placement goes from 0.22 to 0.89 ms.
  - Most of the extra cost is fragment shading of nearer, steeper surfaces: the ground is now closer to the camera, so
    more detail octaves pass their pixel-size fade.
  - The 0.1 km row compares HQ on at 0.1 km with HQ off at its own 0.4 km floor; HQ off can't go lower.
  - HQ off vs master (side-by-side worktree run): same GPU time. The one view where master is frame-stable is
    byte-identical; at the other two, master itself gave different hashes between runs, so they couldn't be compared.
- **Not yet checked:** popping while flying low, anchor-face crossings, the frozen sea on ice shell under the rings, wireframe.
- **Optimize and cap (user):**
  - **Timing method:** GPU timer queries on this machine flip between two clock states (~16 vs ~20 ms for the same frame).
    Cost runs now pause the app's own frames and compare configs on the best of several 12-frame wall-clock runs, from
    the same camera for every config (`.playwright-mcp/final.js`).
  - **Where the time went:** shading, not vertex work.
    - The outer ring was most of the cost: in the far grazing band its cells are ~40 px wide and ~1 px tall, and 2×2
      pixel-quad shading of slivers that thin wastes most of the work. Flattened onto the coarse surface it cost the same, so
      the cost was triangle density, not relief.
    - Its morphed band slid onto the coarse triangles but kept all its own triangles, and the coarse mesh was also drawn
      in a 1.25-cell overlap band.
  - **Changes:**
    - Default ring size is 32 cells (was 64). Ring size is switchable at runtime (`setCells`, Debug tab: 32 or 64).
    - The outer ring collapses like the inner ones (odd vertices onto even, zero-area triangles). Its cells take the
      diagonal of the coarse cell they lie in (two index variants by grid parity), so collapsed it is exactly the coarse
      mesh. That fixed coarse patches at its edge and removes any pop when the rings fade out. Rock placement follows the
      same diagonal rule.
    - The coarse mesh sinks everywhere inside the outer ring except its edge vertices (overlap inset 2.5 → 0.5 ring cells).
    - Each ring is split into 8×8-cell blocks, drawn nearest the camera first. Blocks outside the view are culled with a
      conservative height bound (ground under the camera ± (0.2 km + 2 × horizontal distance)). This saves vertex work;
      the near-to-far order made no measurable difference.
    - Debug tab: `HQ ring cells` (32/64), `HQ levels` (cap, 1–9), `HQ cell px` (level threshold).
  - **Cost now** (rust 26508 rugged spot, rocks on; ms over HQ off, same camera):

    | view | 32 cells (default) | 64 cells | 32, cap 4 levels | 32, 20 px |
    |---|---|---|---|---|
    | 0.1 km, horizon | +2.0 | +4.5 | +1.9 | +1.7 |
    | 0.4 km, horizon | +2.2 | +4.6 | +2.2 | +2.2 |
    | 2 km, horizon | +1.6 | +3.4 | +1.4 | +1.6 |
    | 6 km, horizon | +0.1 | +1.4 | +0.1 | +0.5 |
    | 0.4 km, looking down | +0.7 | +3.6 | +0.9 | +0.6 |

    - Before this round, the same 0.1 km view cost +5.9 ms (64 cells).
    - The level cap and the level threshold barely move the cost: the far, coarse levels are what cost, not the fine ones.
    - Outlier: the 2 km looking-down view measured HQ off ~4 ms *slower* than HQ on in every round; not explained yet.
  - **Trade-off:** 32-cell rings carry relief half as far out (the outer ring reaches ~13 km instead of ~26 km), so
    mid-distance ridges are smoother than with 64.

- **Diagnosis: close-range quality, rolling rocks, the floor, wire see-through (user).** Measured on rust 26508 (R 798 km,
  768 segments) and basalt 7; scripts `.playwright-mcp/drift.js`, `breakdown.js`, `cull.js`, `wire.js`.
  - **Rocks move because they sit on the drawn mesh.** `rocks_place.frag.glsl` takes the rock's position from the
    rendered triangle (coarse mesh or morphing HQ ring) and its up vector from that triangle's normal, every frame.
    Tracked level-0 rocks (world cell id) while the camera walked 1 m per step at 150 m above ground:

    | | slide per metre of travel | tilt per metre | lost per 10° turn (within 1 km) |
    |---|---|---|---|
    | HQ on (9 levels) | 0.10 m mean, 6.5 m max | 1.2–2.8° mean, 180° max | 23 rocks; size changes 0.18 m mean |
    | HQ off (400 m floor) | 0.01 m | 0.01° | — |

    The ring morph slides odd vertices one cell and the collapsed triangles have no normal (the 180° flips). Turning
    moves the window centre (`ahead` = 0.3 window along the heading), and the edge fade is measured from that centre, so
    looking around grows/shrinks every rock in the outer 30 % of the window and drops the ones past it. The mesh density
    switch (384/512/768) moves every coarse triangle too.
  - **Floor:** 400 m without the probe (`controls.ts` minAltitude), 100 m with it (`hqFloor`), probe = nadir only + 3 m.
    At 10 m: the near plane floor is 20 m (`clamp(alt·0.25, 0.02, 200)`), so the ground around the camera is clipped,
    and a slope a few metres ahead rises over the camera (`.playwright-mcp/floor-10m.png`). A probe dropout snaps
    minAltitude back to 400 m. `EXT_clip_control` is available here and three 0.186 has `reversedDepthBuffer`; the
    atmosphere pass unprojects `d*2-1` and would need the reversed mapping.
  - **Why HQ geometry shows little at 100 m:** the finest procedural octave is ~28 m (6 km / 2.15^7); the finest ring
    cell is 3.2 m, so the rings already carry every octave there is. Below 28 m only the textures remain. More levels buy
    nothing without octaves 8–10 (13 m, 6 m, 2.8 m) and sub-metre rocks.
  - **Frame breakdown** at 0.4 km, HQ on, 1280×800 (best-of 12-frame wall time, ms): full 10.9; coarse mesh 0.3
    (full sphere vs one face: 1.0 vs 0 — not worth culling); rock placement 0.9 + rock draw 0.8; HQ rings 1.6;
    atmosphere 16 steps 1.2 (0.2 with ground in view); bloom 0.85; SMAA 0. Terrain fragment shading is 5.7 ms
    (coarse mesh alone 8.0 vs nothing but sky and post 2.3), whichever mesh draws it: the terrain shader over the screen
    is more than half the frame.
  - **Wire mode see-through is inherent:** only `terrainMat.wireframe` is set; the ocean/lava shell stays solid, and in
    lava mode it is never discarded (depth test only), so it shows through the lines everywhere (`wire-hq.png`,
    `wire-nohq.png`; `wire-solid.png` is clean). The coarse mesh sunk 3 km under the rings shows as a second lattice.

- **Rocks placed from the height field; reversed depth buffer; HUD height above ground (user).**
  - **Rocks no longer sit on the drawn triangles.** `rocks_place.frag.glsl` takes a rock's direction from its world
    cell, its height from `hqHeightM` at the footprint the terrain is drawn at there (`drawnFootprint`: the finest
    HQ ring holding the point, morphed as `hqRingVertex` does, or the coarse mesh's footprint outside the rings),
    and its up vector from the ground a rock diameter either side. Size, layer and density depend on the cell alone.
    So rocks never slide or tilt with the mesh; their height breathes with it as the rings refine, which is what the
    ground itself does. The old 4-corner coarse triangle and 3-corner ring triangle (7 height evaluations) are gone;
    the new path is 3 (or 1 for an empty cell). Placement cost 0.9 → 0.37 ms.
  - **Rock windows are centred on the nadir** (were pushed 30 % of the window ahead along the heading) and blocks
    shrink away toward the window edge by their ground distance from the nadir, in the vertex shader (`uReach`),
    instead of by distance from the swinging centre in the placement pass. Forward reach of level 0 is 1.4 km now
    (was 2.3); the 2–8 m blocks beyond that are under ~6 px.
  - Same drift test as above (level-0 rocks, 1 m steps at 150 m above ground, HQ on, 9 levels):

    | | slide per metre | tilt per metre | per 10° turn (within 1 km) |
    |---|---|---|---|
    | before | 0.10 m mean, 6.5 m max | 1.2–2.8° mean, 180° max | 23 rocks lost, size ±0.18 m |
    | after | 0.02 m mean, 0.29 m max (vertical, morph bands) | 0.11° mean, 2.2° max | 0 rocks lost, size unchanged (slide max 0.09 m, tilt max 1.3°) |

  - **Reversed depth buffer** (`reversedDepthBuffer: true`; `EXT_clip_control` is present here, three 0.186 flips
    depth funcs, clear depth and polygon offset itself). Shared uniform `uRevZ` tells the shaders that put things at
    the far plane (stars, sun: depth 1e-5 instead of 0.99999) and the atmosphere pass (depth is clip z/w itself:
    unproject with `d`, sky at `d <= 1e-7`). The HQ block culling frustum takes `camera.reversedDepth`. Near-plane
    floor 20 m → 5 m with the reversed buffer (`controller.nearFloor`), 20 m without. Checked: 100 m horizon view,
    sky with stars, orbit, and a lava world's far shoreline; no console errors.
  - HUD `camera` line shows metres above ground next to the datum altitude (the "alt" the user compared against was
    the datum altitude).
  - Floor stays at 100 m (user: the current closest is about right; HQ shows there).
