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
