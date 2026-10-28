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
