# Planet Forge

Procedural small-planet generator and viewer for testing what a cube-sphere CDLOD planet engine would use: data layout, terrain, splat materials and look.
Built with Vite, TypeScript and three.js (WebGL2), with an HDR pipeline, physically based shading and ACES tone mapping.

```
npm install
npm run dev          # http://localhost:5188
npm test             # vitest: cube mapping, generator determinism, seams, splat sums
npm run gen -- --seed 42 --res 512 --preset terran --out out/terran   # offline bake + previews (Node)
```

Offline asset tools (Python + uv, in `tools/`):
```
cd tools
uv run python -I fetch_textures.py   # download + pack CC0 PBR terrain sets (ambientCG) -> public/textures
uv run python -I make_sky.py --seed 7  # procedural Milky Way HDR + star catalogue -> public/sky
```

## How it fits together

| Part | Where | What |
|---|---|---|
| Contract | `CONTRACT.md`, `src/core/` | Tan-warped cube sphere, 6 faces of N² texels with a 1-texel gutter; height / splat / climate / cloud arrays |
| Generator | `src/gen/` | Plates, continents, ridges, craters and volcanoes, then droplet erosion in direction space (no seams), climate, biomes and 8-layer splat, then clouds. Runs in a Web Worker pool and also in Node (CLI) |
| Renderer | `src/render/`, `src/shaders/` | Displaced cube-sphere mesh; terrain shader blends the top 4 splat layers with triplanar and height-based blending, GGX lighting and procedural detail relief; ocean, lava or ice shell; clouds with shadows; post-process Rayleigh/Mie atmosphere; bloom; ACES |
| Assets | `public/textures`, `public/sky`, `tools/` | 8 CC0 ambientCG material sets plus a synthesized FFT water normal; procedural HDR sky |

## Controls
- **Drag**: orbit. **Wheel**: zoom (exponential, terrain-aware). **Right-drag / shift-drag**: heading and pitch. The view tilts toward the horizon as you descend.
- **R**: new seed. **H**: hide UI. **0–9**: debug views (lit, albedo, normals, height, splat, biomes, temperature, moisture, water flow, cube faces).
- Preset bar: Terran, Archipelago, Dune world, Ice world, Volcanic, Barren moon, Alien.
- Panel: every generator parameter (live regeneration), look, ocean, clouds, atmosphere, light, post, and debug.
- **Export** writes a single `.planet` file (JSON header plus raw face arrays, see `src/app/export.ts`) for engine import tests.

## Notes
- Units: generator heights are metres relative to sea level. The renderer works in km with the planet at the origin.
- Texture tiling is stylised (`texture scale`), because real-metre tiling is invisible from orbit. A real CDLOD engine would switch to true scale near the ground.
- See `WORKLOG.md` for the build log and decisions, and `docs/notes-*.md` for per-part notes.
