# Planet Forge: data contracts

Every part of the project (Python asset tools, TS generator, three.js renderer) codes against this file.
If you need to change something here, say so in WORKLOG.md.

## 1. Cube-sphere mapping (`src/core/cube.ts`, GLSL copy `src/shaders/cube.glsl`)

- Six faces in GL cubemap order: `0 +X, 1 -X, 2 +Y, 3 -Y, 4 +Z, 5 -Z`.
- Each face has a basis `(n, u, v)` with `u × v = n` (see `FACE_BASIS`).
- Grid coordinates `(s, t) ∈ [-1, 1]²`. Direction = `normalize(n + tan(s·π/4)·u + tan(t·π/4)·v)`.
  The tan warp makes texel area nearly uniform over the sphere. Inverse: `s = atan(c)·4/π`.
- Use `faceToDir`, `dirToFace` and `sampleDir`. The face tie-break order is fixed (x, then y, then z).

### Texel layout and gutters
- Interior resolution `N` per face. Stored size `T = N + 2`: a 1-texel **gutter** on every side.
- Texel `i ∈ [0, T)` has its centre at `s_i = (i − 0.5)·2/N − 1`. Texels `1..N` are the interior and `0` and `T−1` are gutters.
- The gutter holds the neighbouring face's value at that direction, so GPU bilinear filtering is seamless.
  Noise passes can evaluate the gutter directly (the function is defined by direction). Passes that change
  data (erosion, blur) must call `refillGutters` afterwards.
- Storage is row-major per face: `index = (face·T + y)·T + x`, with `x` along `s` and `y` along `t`.
  Multi-channel arrays interleave channels: `index·C + c`.
- In GLSL, `cubeTexCoord(dir, N)` returns `(u, v, layer)` for a `sampler2DArray` (6 layers, `T×T`).

## 2. PlanetData (`src/core/types.ts`)

| field | type | content |
|---|---|---|
| `height` | Float32 6·T·T | elevation in **metres relative to sea level** (sea level is always 0) |
| `splat0`, `splat1` | RGBA8 6·T·T·4 | weights for layers 0–3 and 4–7. All 8 channels sum to ~255 |
| `climate` | RGBA8 | R temperature (K/2, so 0..510 K), G volatile wetness, B flow accumulation, A geologic unit id |
| `radius` | number | datum radius in metres (small rocky worlds, ~300–3,500 km) |
| `info` | PlanetInfo | bulk physics, formation history, geologic units, render hints (see `types.ts`) |

There is no cloud layer. Every world has some atmosphere: the renderer clamps density to a small minimum, so even "airless" worlds get a faint limb haze.

### Layer order (fixed, splat channel index). Geological, not Earth biomes
`0 dust, 1 highland, 2 basalt, 3 sand, 4 rock, 5 gravel, 6 ice, 7 salt`

Albedo textures are deliberately part-desaturated. Each world's colour comes from `info.look.layerTints` (linear multipliers per layer).

## 3. Generator API (`src/gen/`)

- `src/gen/params.ts` exports `GenParams`, `DEFAULT_PARAMS`, `PARAM_SCHEMA` (UI metadata: group, label, min, max, step)
  and `GEN_PRESETS` (named partial params).
- `src/gen/index.ts` exports `generatePlanet(params, onProgress?): Promise<PlanetData>`. It runs in Web Workers in the browser.
- The pure stage functions live in modules with no DOM or worker APIs, so `src/gen/cli.ts` can run them in Node.
- Stages follow a formation history: bulk physics (mass, composition, heat, insolation, atmosphere) → magma ocean and
  primordial crust → bombardment (giant basins, craters) → plumes and volcanism (rises, shields, flood basalts) →
  tectonics (rifts, scarps, lineae) → volatiles (seas, erosion, ice caps) → aeolian and late features → geologic units →
  splat. Erosion is a whole-cube pass in one worker; the other passes run per face in parallel.
- Generation must be deterministic for a given seed and params.

## 4. Terrain texture pack (`public/textures/`, made by `tools/fetch_textures.py`)

`public/textures/manifest.json`:
```json
{
  "resolution": 1024,
  "layers": [
    { "index": 0, "name": "beach_sand", "source": "ambientCG/Ground054", "url": "https://...", "license": "CC0",
      "albedo": "beach_sand_albedo.jpg", "normal": "beach_sand_normal.jpg",
      "orm": "beach_sand_orm.jpg", "height": "beach_sand_height.jpg", "tileMeters": 2.0 }
  ],
  "water": { "normal": "water_normal.jpg", "source": "...", "license": "CC0" }
}
```
- All maps are square, have the same `resolution`, and tile seamlessly.
- `albedo` is sRGB. `normal` uses the **OpenGL convention** (+Y up, green not inverted). `orm` is linear with R = AO, G = roughness, B = metalness.
  `height` is greyscale linear (0 = low, 1 = high) and drives height-based splat blending.
- `tileMeters` is the real-world size of one tile, used for UV scaling.

## 5. Sky (`public/sky/`, made by `tools/make_sky.py`)
- `milkyway.hdr`: equirectangular RGBE (Radiance) HDR, 2048×1024, in the three.js `EquirectangularReflectionMapping` convention
  (`u = atan2(z, x)/(2π) + 0.5`, `v = asin(y)/π + 0.5`, file row 0 = +Y top). Faint nebula and galaxy band only; point stars come separately.
- `stars.bin`: little-endian Float32 records `[x, y, z, r, g, b]` with a unit direction and linear HDR colour·intensity.
- `manifest.json`: `{ "count": n, "hdr": "milkyway.hdr", "stars": "stars.bin" }`.
