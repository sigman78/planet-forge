# Terrain fragment shader: cost map and optimisation plan

Branch `exp/hq-subdiv`, 2026-10-30. Analysis of `src/shaders/terrain.frag.glsl` (527 lines) and the sources it pulls in:
`cube.glsl`, `noise.glsl`, `atmosphere_common.glsl` (via `COMMON`, planetView.ts:17), `terrain_common.glsl`,
`terrain_light.glsl`. The program is `COMMON + terrainCommon + terrainLight + terrainFrag` (planetView.ts:275); the nine
HQ ring materials compile the identical fragment source (hqTerrain.ts:158) and three.js shares one program between
them, so everything below applies to the rings and the coarse mesh alike.

Measured context (WORKLOG, 2026-10-30): 1280x800, 0.4 km above ground, whole frame 9.8 ms, terrain fragment shading
5.7 ms (coarse mesh alone 8.0 ms vs sky + post 2.3 ms). GTX-class card, Windows, ANGLE over D3D11.

Two caveats drive the whole plan:

1. **D3D flattens per-pixel branches.** fxc keeps `if` as a real branch only when it decides to; a condition computed
   from per-pixel data (a splat weight, a blend weight, a footprint) is usually flattened into selects, so both sides
   run. Every count below assumes the flattened case: *all* gated work runs on *every* pixel. Uniform-valued
   conditions are usually honoured, but `terrain_common.glsl:39-41` reports one case where a uniform branch did not
   save anything, so even those must be measured. The only mechanism that reliably removes work is a compile-time
   `#define` (a different program).
2. **Op counts are not milliseconds.** The counted work (section 1.3) comes to roughly 7k scalar ops and ~90 texture
   fetches per pixel. At the measured 5.7 ms that is far below what the card can do in that time, so the shader is
   not simply throughput-bound: register pressure (occupancy), serial fetch chains (the shadow march), anisotropic
   filtering at grazing angles and 2x2 quad overshade on sliver triangles (WORKLOG, HQ section) make up the rest.
   Every proposal therefore ends with a measurement, not an arithmetic saving.

---

## 1. Map of `main()`

Line numbers are `terrain.frag.glsl` unless prefixed (`TC` = terrain_common.glsl, `TL` = terrain_light.glsl,
`N` = noise.glsl, `A` = atmosphere_common.glsl, `C` = cube.glsl).

### 1.1 Stages in order

| # | Stage | Lines | What it does | Per-pixel cost (counted) | Scales with |
|---|---|---|---|---|---|
| A | Setup, footprint | 247-263 | `normalize(vDir)`, `dFdx/dFdy(vWorldPos)`, `dFdx/dFdy(vDir)`, `cubeTexCoord` (C:26, one `dirToFace` = 2 `atan` + divide), LOD from `log2` | 4 derivative ops, 2 atan, 1 log2, ~40 ops | constant |
| B | Height, macro normal, climate | 264-277 | `tHeight` lod0 (R32F, bilinear, no mips), `tGrad` (RGBA16F, mips), `tClimate` (RGBA8, mips); sea-ice mask; 2 `normalize` | 3 `textureLod` fetches, ~30 ops | constant |
| C | Splat weights | 279-285 | `tSplat0`, `tSplat1` fetches; 8-wide `mix` for sea ice (loop 285, flattened) | 2 `textureLod`, 8 mix | 8 layers |
| D | Fine-style prologue, region noise | 287-309 | `fineStyle` = 8 vec4 madds (289); `macro` = 2 x `fbm3` = 6 `snoise` (295); `gRegion` = 1 `snoise` (296); `region2` = 2 `snoise` (297); 6 smoothsteps | **9 `snoise`** (~90 ops each, est. ~800 ops), ~60 ops | constant; depends only on `n` |
| E | Detail gradient (procedural relief normal) | 311-315 -> 177-214 | Loop k=0..7, `break` when the footprint fade hits 0 (192-193). k<3: `styleOct` with `uLandStyle`; k=3..5: `styleOct` with the fine style; k=6,7: `styleOctSmooth`. `styleOct` (TC:53) = `styleOctSmooth` (1 `snoiseGrad`, N:66) + `cellular2` (N:123: 2x2x2 = 8 `hash33`, 8 distance tests, 2 sqrt) + crack/pit math (1 exp) | **8 `snoiseGrad`** (~120 ops each) + **6 `cellular2`** (~280 ops each + ~40 crack/pit); est. **~2900 ops**. Octave fades (192, 202): 4 smoothsteps per octave | octave count (8), cell octaves (6). Trip count is data dependent but see 2.2 |
| F | Debug 4 early return | 317-322 | `uDebug == 4`: uniform int branch, returns **before** the texture stack | - | - |
| G | Top-3 layer selection | 324-341 | 3 passes x 8 compares (329); `w[best] = -1.0` (332) is a **dynamic write into a local array** x3; continuity subtraction (336-341) | ~80 ops + 3 dynamic-index writes | NLAY x LAYERS = 24 |
| H | Triplanar setup, hex cells | 343-358 | `pow(abs(Nm), uTriSharp)` x3; 3 uv sets + 6 gradient vec2s; `makeHex` x3 (100-125): floor/fract, 3 compare-swaps, `pow(w,7)` x2, 2 `hexRot` (hash12 + sincos each), 2 `hash22`, 2 `hash12` | 3 pow + 3 x (2 pow, 2 sincos, 6 hashes, ~50 ops) = est. ~300 ops. The `bw > 0.02` gates (356-358) are per pixel: assume all 3 run | planes (3) |
| I | Albedo + height fetch | 360-372 | per layer k (3) x plane (3): `triAlbedo` (128-137) = 2 `textureGrad(tAlbedo)` (hex cells 1 and 2), luminance weights | **18 `textureGrad`** (sRGB RGBA8 1024^2 x8 array, trilinear, aniso <= 16), ~15 ops each for uv/gradient rotation | NLAY x planes x hex cells = 3x3x2 |
| J | Height blend | 374-388 | window from footprint, 3-way max/normalise | ~40 ops | NLAY |
| K | Normal + ORM fetch | 390-416 | per layer x plane: `triNormal` (147-155) = 2 `textureGrad(tNormal)` + 2 `transpose`-rotates; `triOrm` (139-144) = 2 `textureGrad(tOrm)` | **36 `textureGrad`** (18 normal + 18 ORM), ~20 ops each | 3x3x2x2 |
| L | Normal assembly, specular AA | 417-428 | whiteout blend, `normalize`, `dFdx/dFdy(N)` | 2 derivative ops, ~40 ops | constant |
| M | AO, roughness | 430-444 | `tAO` fetch (431), gloss loop (434), 3 clamps, `pow(..., 0.25)` | 1 `textureLod`, 1 pow, ~30 ops | constant |
| N | Macro variation, weathering | 446-456 | `tAO` fetched **again** (451, same args as 431), 3 mixes, luminance | 1 `textureLod` (redundant), ~40 ops | constant |
| O | Wetness, channels | 459-465 | smoothsteps | ~15 ops | constant |
| P | Sun light through the air | 470 -> A:77 | `sunLightAt` -> `opticalDepthToSun(p, 6)` (A:59): 2 `raySphere`, loop 8 with uniform break at 6, each step `atmoDensityAt` (A:50) -> `atmoAltitude` -> `figureKm` (A:26): `atan`, `acos`, 1 `tFigure` fetch, 3 `exp` | **6 `textureLod(tFigure)`**, 6 atan, 6 acos, 18 exp, 2 sqrt, est. ~450 ops. Skipped only when `uAtmoDensity <= 0` or `uFigureOn <= 0` (uniform branches, A:78, A:27) | fixed 6 steps |
| Q | Cast shadow | 473 -> TL:38 | `terrainShadow`: start point = 1 `bakedHeightM` (TL:41) then loop i<24 (TL:45): `length`, divide, `cubeTexCoord` (2 atan), `tHeight` fetch, `elevationKm`, `min`, **data-dependent `break`** (TL:51) | **1 + <=24 `textureLod(tHeight)`**, **<=50 atan**, est. ~70 ops/step = ~1750 ops. The `dot(n,Lsun) > -0.05 ?` guard (473) is per pixel: assume it runs | steps (24); for lit pixels `t > tMax` stops it at ~21 steps (R 800 km, N 1024: t0 ~1 km, x1.28 per step, tMax 160 km) |
| R | BRDF | 475-481 -> TL:12 | `brdfS`: `normalize`, 4 dots, `pow(1-VdH,5)`, `pow(VdL,6)`, divides | 2 pow, est. ~60 ops | constant |
| S | Ice glints | 482-485 -> 234-244 | `iceGlints`: `log2`, 2 x `glintLevel` (226): `glintPcg` (integer hash, ~20 int ops), `log`, `sqrt`, 2 sincos, smoothstep | 4 sincos, 2 log, 2 sqrt, est. ~150 ops. Gate `glossy > 0.02` (482) is per pixel: assume it runs on every world | constant |
| T | Ambient, planetshine | 486-490 | 2 smoothstep/clamps, 2 dots | ~25 ops | constant |
| U | Lava | 493-502 | `uLavaGlow > 0` uniform branch; inside: `snoise` + `fbm3` (3 `snoise`), `pow(...,8)` | 4 `snoise` (est. ~360 ops) + 1 pow, only on lava worlds if the branch is honoured | constant |
| V | Debug views | 505-524 | chain of uniform-int compares; debug 5 indexes `uUnitColors[32]` dynamically; debug 9 calls `dirToFace` | negligible when `uDebug == 0` (branches are uniform) | - |

### 1.2 Fetch count per pixel (all gates flattened)

| Sampler | Format, filtering | Fetches | Where | Notes |
|---|---|---|---|---|
| `tAlbedo` | RGBA8 sRGB, 1024^2 x 8 layers, trilinear, aniso 16 (terrainTextures.ts:52-55, 114) | **18** `textureGrad` | 369-371 -> 130, 132 | 3 layers x 3 planes x 2 hex cells |
| `tNormal` | RGBA8, same | **18** `textureGrad` | 399, 405, 411 -> 149, 151 | alpha channel is a constant 255 (terrainTextures.ts:99) |
| `tOrm` | RGBA8, same | **18** `textureGrad` | 402, 408, 414 -> 141, 143 | alpha 255 (ts:103); `.b` (metal) is ~0 for all 8 natural layers |
| `tHeight` | R32F, bilinear, **no mips** (planetTextures.ts:132) | 1 + 1 + <=24 | 264; TL:41; TL:49 | the 24 are a serial chain (see 2.2) |
| `tGrad` | RGBA16F, mips, aniso 8 (but `textureLod` -> no aniso) | 1 | 269 | alpha channel is written as 0 and never read (planetTextures.ts:121) |
| `tClimate` | RGBA8 | 1 | 277 | `.a` used only by debug 5 |
| `tSplat0`, `tSplat1` | RGBA8 | 2 | 280-281 | |
| `tAO` | R8 | 2 (identical) | 431, 451 | redundant; CSE likely but not guaranteed |
| `tFigure` | 2D, `textureLod` | 6 | A:29 via 470 | per `atmoDensityAt` step |
| **Total** | | **54 big array fetches + 8 data + <=25 shadow + 6 figure = up to ~93** | | |

Dependent chains: `tSplat0/1` -> sort -> array layer `L = idx[k]` -> all 54 `textureGrad` (the layer index is a
dependent read); `tAlbedo.a` -> height blend `hb[k]` -> gate on the 36 normal/ORM fetches (control dependency only;
the coordinates do not depend on the albedo). Shadow: fetch i -> `s` -> `break` -> fetch i+1 (true serial chain).

### 1.3 Noise and transcendental count per pixel

| Function | Calls | Est. ops each | Est. total | Where |
|---|---|---|---|---|
| `snoise` | 9 (+4 lava) | ~90 | ~800 (+360) | 295-297 (496) |
| `snoiseGrad` | 8 | ~120 | ~960 | detailGrad -> TC:44 |
| `cellular2` + crack/pit math | 6 | ~320 | ~1900 | TC:59-82 for k=0..5 |
| `makeHex` | 3 | ~100 | ~300 | 356-358 |
| `glintLevel` | 2 | ~70 | ~150 | 242 |
| Shadow march step | <=24 (+1) | ~70 (2 atan ~20 each) | ~1750 | TL:45-53 |
| `sunLightAt` | 1 (6 steps) | ~450 | ~450 | 470 |
| Everything else (uv math for 54 fetches, blends, BRDF, weathering, selection) | | | ~800 | |
| **Total** | | | **~7000-7500 scalar ops (estimated)** | |

Transcendentals (fxc expands `atan` to ~20 instructions; the rest go to the SFU at 1/4 rate): atan 2 + 50 + 6 = **58**,
acos 6, exp ~27, pow ~13, sincos 10, log 4, sqrt/rsqrt ~40.

Rough shares of the counted ALU: detailGrad ~40 %, shadow march ~24 %, prologue noise ~11 %, texture address/blend
math ~11 %, sunLightAt ~6 %, hex ~4 %, glints ~2 %.

### 1.4 Constant vs scaled

- **Per-pixel constant:** A, B, D (prologue noise), H (hex), L-T, P (6 fixed steps), S.
- **Scales with NLAY (3) x planes (3) x hex cells (2) x maps (3):** I + K = 54 fetches. Halving any factor halves the
  stack. LAYERS = 8 only touches cheap vector math (C, G, 285, 289, 319, 337).
- **Scales with octaves:** E (8 octaves, 6 with cells). Fades exist (192, 202) but only reduce work if fxc keeps the
  `break`/guards as real branches (unverified; the loop is unrolled, see 2.2).
- **Scales with steps:** Q (24, ~21 effective for lit pixels).

---

## 2. Ranking and findings

### 2.1 Top cost centres (ranked)

1. **The triplanar x hex x 3-layer texture stack (I + K): 54 `textureGrad` on 1024^2 RGBA8 arrays with 16x
   anisotropy.** In a horizon view most ground pixels are at grazing angles where each fetch takes many bilinear
   taps, and the 18 distinct (layer, plane, cell) uv streams per map defeat texture-cache locality. It also
   dominates register pressure: three `Hex` structs (16 floats each), `hwX/Y/Z[3]` (18 floats), `ah[3]`, three
   tangent normals, 6 gradient vec2s are all live across the two loops. Cost formula: NLAY x planes x cells x maps.
2. **`detailGrad` (E): 8 `snoiseGrad` + 6 `cellular2`, est. ~2900 ops.** At 0.4 km over the horizon, pixels within
   ~3 km of the camera legitimately pass all 8 octaves (finest octave 28 m: full below a 2.8 m footprint, gone at
   7.9 m, i.e. ~3 km and ~8 km along the view with the default 6 km detail scale, 45 deg fov, 800 px high; the
   geometric-mean footprint at grazing angles brings both a little closer), so only the far band (ground beyond
   ~8 km, roughly the top 13 % of the ground rows in a horizon view) can save anything from the fades, and only if
   the compiler honours them. The Worley part (`cellular2`, 2/3 of the stage) is what makes the cell octaves 3x the
   price of the smooth ones.
3. **The cast-shadow march (Q): up to 25 `tHeight` fetches + 50 `atan` in a serial chain.** The data-dependent
   `break` (TL:51) makes fetch i+1 wait for fetch i; for lit pixels the loop runs ~21 steps before `t > tMax`.
   That is ~21 full texture latencies in sequence per warp, hidden only by occupancy, which the texture stack has
   already pushed down. The result depends only on `n` and the sun direction (it samples the baked heightmap only),
   so it is exactly bakeable (see 3.2).
4. **The prologue noise (D): 9 `snoise`, est. ~800 ops.** `macro`, `gRegion`, `region2` and everything derived from
   them (`fineStyle`, `gFineAmp`, `crackM`) depend only on the surface direction `n`: a texel-resolution bake
   reproduces them exactly (their finest feature is ~4-5 km of arc; N=1024 at R=800 km is 1.2 km per texel).
5. **`sunLightAt` (P): 6 `tFigure` fetches, 12 atan/acos, 18 exp, est. ~450 ops** for a quantity that varies over
   kilometres. (Also paid per pixel by `rocks.glsl:98` and `ocean.glsl:77`.)

### 2.2 Things that look redundant or suspicious

- **`tAO` is fetched twice with identical arguments** (431 and 451). fxc usually CSEs identical sample instructions,
  but there is no reason to depend on it; fetch once into a local.
- **`length(cameraPosition - vWorldPos)` is computed twice** (251 `fpIso`, 418 `camDist`); `dot(n, Lsun)` three times
  (472, 473, 486). Trivial, CSE'd, but free to clean up.
- **`w[best] = -1.0` (332)** is a dynamic write into a local array, three times. fxc lowers that to an indexable
  temp (`x0[]`); on NVIDIA that can become local memory traffic. A select form (`w[i] = (i == best) ? -1.0 : w[i]`
  over the unrolled 8) is the same result with no dynamic indexing.
- **`uUseCells` is dead.** The only write in `src/` is the constant `uUseCells: u(1)` in the `PlanetView`
  constructor (planetView.ts); nothing in `applyLook` or elsewhere drives it, so the uniform branch in `styleOct`
  (TC:55) is always taken. The note in TC:39-41 ("a uniform branch alone would not: D3D flattens it")
  may have been observed with the uniform stuck at 1. Treat "uniform branches are honoured" as unverified for this
  program until the knob tests in 5.1 say otherwise.
- **The detailGrad loop is unrolled** (the `k < 6` split in TC:40-41 only removes the Worley code for k=6,7 if `k` is
  a compile-time constant per copy, which the author reports it does). After unrolling, the `if (f <= 0.0) break;`
  (193) becomes nested per-pixel guards. Whether fxc keeps those as branches or flattens them decides whether the
  far band of the screen pays for 8 octaves or ~5. Unknown; measurable (5.2 c, d).
- **`detailFade` on the texture normals (419) fades between 60 and 900 km**, so at any low altitude it is 1.0: no work
  is saved by it, and it cannot be used as a cheap-path switch.
- **`makeHex` hashes each cell three ways** (`hexRot` -> `hash12`, `hash22`, `hash12(v + 17.1)`: 123, 121-122): one
  `hash33` per cell would do. Minor.
- **`tri*` recompute `uv * sc`, `gx * sc`, `h.r1 * uv + h.o1`, `h.r1 * gx`, `h.r1 * gy`** three times per
  (layer, plane) across `triAlbedo`, `triNormal`, `triOrm` (129, 140, 148). After inlining fxc may CSE across the two
  loops, but the loops are separated by the height-blend gate; computing the two rotated uv/gradient sets once per
  (layer, plane) and passing them in is cheaper and smaller.
- **Vertex-side duplicate:** the HQ ring vertex shader evaluates the same 9 `snoise` prologue (terrain_fine.glsl:42-44)
  and the same octaves per vertex. That is vertex cost, not fragment, but a baked prologue (3.3) removes it there too
  and ends the "keep in sync" burden stated in terrain_fine.glsl:2-4.
- **Not a redundancy, but worth knowing:** at 768 segments the coarse vertex shader's `detailM` carries ~25 % of
  octave 0 and nothing finer (`octaveFade` with a 3.3 km vertex footprint, TC:22-24), so the fragment's `detailGrad`
  is the entire procedural relief on the coarse mesh. Nothing in E can be moved to the coarse vertex stage without
  losing it; on the rings it could, but the shader is shared.
- **Uniform-gated blocks that cost on every world if fxc flattens them:** lava (493-502, 4 `snoise`), glints
  (482-485, per-pixel `glossy` gate so flattened regardless), `sunLightAt` (A:78), `terrainShadow` (TL:39),
  `detailGrad` (178). Only the tiers (section 4) make these reliably free.

---

## 3. Proposals

Savings are estimates of the *counted* work unless a measurement exists; translate to ms only with section 5.
"D3D" says whether the proposal depends on a branch being honoured.

### 3.1 Zero-edit knobs (do these first; they are also the diagnostics)

| Proposal | Expected saving | Visual risk | Difficulty | D3D |
|---|---|---|---|---|
| **Anisotropy 16 -> 4 (or 2) on `tNormal` and `tOrm`**, keep 16 on `tAlbedo` (terrainTextures.ts:55, 114). A sampler-state change: set `.anisotropy` and `needsUpdate = true` (re-uploads ~100 MB once). | If the stack is filter-bound: 10-25 % of the shader (estimated). Also the cleanest test of *whether* it is filter-bound. | Low: normal/roughness detail blurs along the view at grazing angles, where it is already smeared by the macro slope. | Trivial | Safe (no branch) |
| **Trilinear -> `LinearMipmapNearest`** on the three arrays | Halves taps if filter-bound | Visible mip bands on albedo at low sun; acceptable for normal/ORM only | Trivial | Safe |

### 3.2 Shadow

| Proposal | Expected saving | Visual risk | Difficulty | D3D |
|---|---|---|---|---|
| **S1. Fixed trip count, no `break`** (TL:45-53): `for (int i = 0; i < 22; i++)` with no early exit and `t = min(t * 1.28, tMax)`, so surplus iterations resample the capped point and `min` is a no-op there. (Without the clamp the march would reach past today's 160 km cap on big worlds: at R 1200 km, N 1024 the first step is ~1.5 km and 22 steps reach ~260 km, picking up occluders the current march ignores.) For lit pixels the result is identical (they ran to `t > tMax` anyway, ~21 steps at R 800); for shadowed pixels `s` is already 0 and `min` keeps it. Lets the compiler unroll and issue all fetches before the `min` chain. | Unknown until measured; potentially large because it breaks the serial latency chain. Counted work is +1-3 steps. | None with the clamp (same result up to fp rounding) | Trivial | Safe: removes a branch |
| **S2. Cheap `atan` in the march only**: the march needs texel-level accuracy, not 1e-6; an odd 5th-order polynomial for `atan(c)*4/pi` on [-1,1] is ~6 ops instead of ~20. Add a `cubeTexCoordFast` used by TL:49 only. | ~700 ops of ~1750 in Q (est. 10 % of counted ALU) | None at texel accuracy (error < 0.5 texel at N=1024) | Low | Safe |
| **S3. Bake the ground shadow** into a per-planet face atlas, rebuilt when the sun moves (the `SunShadowMap` class in sunShadow.ts already has the atlas layout, the `angleTo < 0.002` rebuild test and the uniform sharing; add a third channel or a second target that stores `terrainShadow(n, uSun)` evaluated with the existing march). Replace TL:38-55 with one `textureLod` on the atlas; `rocks_place.frag.glsl:125` reads the same map. | Removes ~25 fetches and ~1750 ops (est. 20-25 % of counted ALU plus the latency chain). Rebuild: 6 x N^2 texels x 24 fetches, ~1-3 ms once per sun move at N=1024, less at 512. | Low-medium: the penumbra is identical in principle (same march, same heights) but is now bilinear-filtered at texel resolution (1.2 km at R 800 km) instead of evaluated per pixel; soft edges stay soft, very sharp near-field edges blur by about a texel. Under the day cycle a 512-per-face rebuild every few frames keeps cost flat (the volumetrics atlas already does this: WORKLOG "9 rebuilds a second, no fps change"). | Medium: one more pass, one more sampler in `terrain_light.glsl`, cube-atlas lookup like atmosphere_pass.frag.glsl:23-26 | Safe |

S1 and S2 are the "keep the march" path; S3 supersedes both.

### 3.3 Bake the direction-only fields (prologue noise)

| Proposal | Expected saving | Visual risk | Difficulty | D3D |
|---|---|---|---|---|
| **F1. `tField` cube array (RGBA8, N x N x 6, mipmapped):** R = `macro` (295), G = `gRegion` (296), B = `region2` (297), A = spare (or `gFineAmp`). Generated once per planet by a full-screen pass over the 6 faces using the same GLSL (like sunShadow.ts). The fragment fetches it at `dataLod` next to `tClimate` and drops the 9 `snoise`. `terrain_fine.glsl:42-44` reads the same texture. | 9 `snoise` (~800 ops, est. 11 % of counted ALU) for 1 cheap fetch; the same per HQ vertex. | Very low: finest feature ~4-5 km vs 1.2 km texels at N=1024, R=800 (check small-N worlds: at N=512, R=1200 the finest `region2` term is 2 texels per feature, still fine for a smooth modulator). From orbit the mips *improve* it (per-pixel noise aliases there today; see 295 where the second `fbm3` is already faded for that reason). | Medium-low | Safe |
| **F2. Go further: bake the whole fine-style prologue** (289-309) as a second RGBA8 (`fineStyle` normalised, 4 channels) and fold `gFineAmp` into `tField.a`. Needs `Gh`-derived `flatK`/`steep` (293-294) at bake time from `tGrad` lod 0, which the bake pass has. | Another ~60 ops and the 8-wide loop at 289; mostly a simplification | Low; `flatK` from lod-0 gradients instead of `dataLod` gradients changes the crack/scree masks slightly from orbit | Medium | Safe |
| **F3. Use the dead `tGrad.a`** (half float, written 0 at planetTextures.ts:121) for one of the fields instead of a new texture | Saves one sampler | None | Low | Safe |

### 3.4 Texture stack

| Proposal | Expected saving | Visual risk | Difficulty | D3D |
|---|---|---|---|---|
| **T1. Pack normal.xy + roughness + AO into one RGBA8 array** (`tNormal.a` and `tOrm.a` are constant 255 today; metal `.b` is ~0 for every layer). Reconstruct `z = sqrt(1 - x^2 - y^2)`; `metal` becomes 0 (or a per-layer uniform). `triNormal` and `triOrm` merge into one `triSurf`. | **54 -> 36 fetches (-33 %)**, 32 MB less texture, fewer live registers | Very low: z reconstruction is standard; `F0 = mix(0.04, albedo, metal)` with metal 0 is what it is today | Medium (loader packing in terrainTextures.ts:91-104, two functions in the shader) | Safe |
| **T2. Biplanar instead of triplanar** (Quilez 2020): pick the two largest `abs(Nm)` axes by compare-swap (selects, no branches) and blend with weights `clamp((w - 0.5773) / (1 - 0.5773), 0, 1)^k`. Continuous: wherever the second and third axes trade places both are <= 0.577 and have weight 0, so there is no seam. At the exact cube corner all three clamped weights are 0 (0/0 on normalising): guard with `max(sum, 1e-4)` and fall back to weight 1 on the dominant axis. Two `makeHex`, two uv sets, two plane loops. | **-33 % of the stack** (54 -> 36, or 36 -> 24 with T1), one `makeHex` fewer (~100 ops), 16 floats less live state | Low-medium: identical away from the 8 cube-corner regions of the planet (where `Nm` has three comparable components); there the third projection's contribution disappears and the blend is sharper. With `uTriSharp = 6` the current third weight is already small except right at those corners. Normal whiteout blend works the same with two planes. | Medium | Safe (selects) |
| **T3. Hex-tile albedo (and normal) but sample ORM at the dominant hex cell only** (`W.x` cell): one `textureGrad` per (layer, plane) for ORM | 9 fetches (-17 %) | Low: roughness/AO are low-contrast; a hard cell edge in them is nearly invisible | Low | Safe |
| **T4. NLAY 3 -> 2** (95) with the same continuity subtraction (334-341 using the third weight as `w4`) | -33 % of the stack | Medium: three-way material junctions (dust over rock over basalt) become two-way; splat edges harden slightly. Tier material, not a default. | Trivial | Safe |
| **T5. Hoist the rotated uv/gradient sets** (129, 140, 148) out of the `tri*` functions: compute `(h.r1*uv+h.o1, h.r1*gx, h.r1*gy)` and the cell-2 set once per (layer, plane), pass to all maps | ~150-250 ops, fewer temporaries | None | Low | Safe |
| **T6. Restructure plane-major** (loop over planes outside, layers inside) so only one `Hex`, one uv set and one gradient pair are live at a time; keep per-layer accumulators only. | Unknown; targets occupancy, not op count. Could be the single biggest practical win if the shader is latency-bound; could also do nothing. | None | Medium (the height blend needs all layers' albedo first, so the albedo pass stays layer-major; the normal/ORM pass can be plane-major) | Safe, but any restructuring reshuffles the compiled cost unpredictably: measure |
| **Not recommended: per-pixel layer/plane culling with `if`** (what 366, 369-371, 394, 398-415 already do). The gates are per-pixel; fxc flattens them. The branch-free equivalents are T2 (planes) and T4 (layers). | - | - | - | **Unsafe** |

### 3.5 Procedural relief

| Proposal | Expected saving | Visual risk | Difficulty | D3D |
|---|---|---|---|---|
| **R1. Uniform octave cap from the camera height**: on the CPU, `fp_min = aboveGround * uPixelAngle`; octave k is invisible everywhere when `fp_min / s_k >= 0.28` (192). Pass `uOctaves` and split the loop into the three constant-bound loops the comment at 188 describes, each `#if`/uniform capped. | Nothing at 0.4-6 km (all 8 octaves pass there: `fp_min` is 0.4-6 m, the finest octave is 28 m). Saves 2-3 octaves above ~25 km, where the frame is cheap anyway. | None | Low | Only if the uniform loop bound is honoured; and a uniform bound stops fxc unrolling, which would turn the static `k < 6` split (TC:40) into a dynamic one and *add* Worley work to k=6,7 unless the loops are split first |
| **R2. Fewer cell octaves.** `crackM` for j>=3 and `PIT_M[4]` are already 0 (186-187), and k=6,7 already skip Worley. Drop Worley on k=5 as well (`PIT_M[2] = 0.7`, `crackM[2] = 0.15` today) by moving its crack/pit weight into billowy, like `octaveStyle` does. | 1 `cellular2` (~320 ops, est. 4 % of counted ALU) | Low: the 0.13 km craterlets/cracks become bumps; the two coarser cell octaves keep the plates | Trivial | Safe |
| **R3. Per-world landform Worley off**: when `uLandStyle.zw == 0` (no cracked/pitted landforms: `landCracked` defaults to 0 but `landPitted` to 0.2, planetView.ts:134-135), compile k=0..2 with `styleOctSmooth` | 3 `cellular2` (~960 ops) on such worlds | None on those worlds | Low, needs a define (section 4) | Needs a define: the `uUseCells` uniform does not do it today |
| **R4. Texture-based noise for the fine octaves** (a 32^3 or 64^3 RGBA16F tile of value + gradient, trilinear): one 3D fetch per octave instead of ~120 ops | ~5 x 100 ops; low tier only | Medium: softer, periodic noise; fine for normal perturbation, visible in close-up next to the current simplex | Medium | Safe |
| **R5. Move the landform gradient (k<3) to the vertex shader** | Not viable on the coarse mesh (see 2.2: the mesh cannot resolve those octaves, interpolating their gradient across 1.6 km cells erases the relief). Viable on the rings only, and the shader is shared. | - | - | - |

### 3.6 Lighting and the rest

| Proposal | Expected saving | Visual risk | Difficulty | D3D |
|---|---|---|---|---|
| **L1. `sunLightAt` in the vertex shader** (`varying vec3 vSunCol`; terrain.vert.glsl and terrain_hq.vert.glsl both). | 6 fetches, 12 atan/acos, 18 exp, ~450 ops (est. 6 %) | Low: transmittance varies over km; the planet-shadow cutoff (A:61) blurs across one quad at the terminator | Low | Safe in principle, **but** WORKLOG reports a variant "with an extra varying" compiled ~40 % slower on D3D. Measure the varying's cost alone (a dummy varying) before trusting this. |
| **L2. Compile-time glints** (`#if TERRAIN_GLINTS`) set per world from `layerCoverage` (ice + salt > 0, planetView.ts:167) | ~150 ops + 4 sincos on worlds without ice/salt | None on those worlds | Low (tier mechanism) | Needs a define |
| **L3. Compile-time lava** (`#if TERRAIN_LAVA`, from `oceanMode === 1`) | 4 `snoise` if the uniform branch at 493 is being flattened; nothing if it is honoured | None | Low | Needs a define |
| **L4. Single `tAO` fetch, select-form sort (332), `hash33` per hex cell** | Small, free | None | Trivial | Safe |
| **L6. Make the normal/ORM fetches explicitly independent of the albedo results**: the `if (hb[k] < 0.004) continue;` gate (394) is flattened anyway, but it makes the 36 fetches control-dependent on the 18 albedo results (`hb` comes from `ah[k].a`). Drop the gate and let the `hb[k]` weight (already 0 for dropped layers, 387) do the job, so the compiler can hoist the fetches ahead of the height blend. The splat -> sort -> array-layer chain itself is inherent to layer-indexed arrays and stays. | Unknown; latency only | None (`hb` is exactly 0 where the gate skipped) | Trivial | Safe: removes a branch |
| **L5. Specular AA derivatives (427)**: keep; 2 derivative ops are cheap and they are what stops the ice sparkle. | - | - | - | - |

### 3.7 Far-field path

A per-pixel distance switch is unsafe (flattened). The only branch-free form is a second program on a second draw:
with HQ rings on, the coarse mesh is visible only beyond the outer ring (~13 km at 32 cells) and above the ring fade
(14-20 km), so the coarse mesh could use the medium program while the rings use the high one. At 0.4 km that is only
the thin horizon band (~8 % of ground pixels: ground beyond 13 km spans ~1.8 deg of the 22.5 deg below the horizon),
so the gain is small until the camera rises. Worth doing only once tiers exist (section 4), as a free extra:
`terrainMat.defines.TERRAIN_TIER = hqOn ? 1 : 0`.

---

## 4. Quality tiers

### 4.1 Mechanism

- `material.defines = { TERRAIN_TIER: 0 | 1 | 2 }` on `terrainMat` (planetView.ts:227) **and** on the nine ring
  materials (hqTerrain.ts:155) and the probe/rocks materials that include the same chunks; three.js keys its program
  cache on source + defines, so all terrain materials of one tier share one program. Set `needsUpdate = true` on
  change.
- Feature flags derived in the shader from the tier, each overridable (`#ifndef TERRAIN_PLANES ... #endif`) so single
  features can be measured alone:
  `TERRAIN_NLAY`, `TERRAIN_PLANES` (3/2), `TERRAIN_HEX` (2 cells / 1 / off), `TERRAIN_ORM` (full / dominant cell /
  constant), `TERRAIN_FINE_OCTAVES` (5/4/3), `TERRAIN_CELL_OCTAVES`, `TERRAIN_SHADOW` (march / baked / off),
  `TERRAIN_SUNATMO` (pixel / vertex / none), `TERRAIN_GLINTS`, `TERRAIN_LAVA`, `TERRAIN_WEATHER`.
- **Regression gate first:** add the defines with tier 0 selecting exactly today's code paths and verify the program
  costs the same as the current one (5.1, step 0). The WORKLOG's "a #define variant compiled ~40 % slower" was a
  variant that *added* a varying and code; a define that only removes code should not regress, but on this
  compiler that is a measurement, not an assumption.
- Precompile every tier at load (`renderer.compile` / `compileAsync`; the `hqTerrain.compile` binding in main.ts
  shows the pattern) so switching does not hitch (the D3D compile of a program this size is estimated at hundreds
  of ms; not measured here).
- Expose it as a `quality` setting (auto rule later: e.g. medium when the measured frame exceeds a budget).

### 4.2 What each tier does

| Feature | High (today) | Medium | Low |
|---|---|---|---|
| Splat layers per pixel (NLAY) | 3 | 3 | 2 |
| Projections | 3 | 2 (biplanar, T2) | 2 |
| Hex cells per lookup | 2 | 2 (with T1 packing); or 2 albedo + normal, 1 ORM (T3) if T1 is not done | 1 (plain tiling, random per-cell offset only) |
| Maps | 3 (albedo/h, normal, ORM) | 2 (T1 packed) | 2 |
| Big-array fetches per pixel | 54 | 3 layers x 2 planes x 2 maps x 2 cells = **24** with T1; 3 x 2 x (2 + 2 + 1) = 30 with T3 instead | 2 x 2 x 2 x 1 = **8** |
| Anisotropy (normal/ORM) | 16 | 4 | 2 |
| Prologue noise | 9 `snoise` | baked (F1) | baked |
| Fine octaves | 5 (k=3..7) | 4 (drop k=7, 28 m) | 3 (drop k=6,7) |
| Cell (Worley) octaves | 6 | 5 (R2: k=0..4) | 3 (landforms only), or 0 on worlds without cracked/pitted landforms (R3) |
| Cast shadow | 24-step march | baked (S3) or 16 steps x1.45 | baked or off |
| Sun transmittance | per pixel | per vertex (L1) | `uSunColor` x a per-frame scalar from the camera point |
| Ice glints | always compiled | per world (L2) | off |
| Lava cracks | uniform branch | per world (L3) | per world, no `fbm3` warp |
| Weathering | full | full | settle + regional brightness only (drop frost/hue) |
| Specular AA | on | on | off (fixed roughness floor instead) |

### 4.3 Estimated saving per tier (counted work; measure)

- **Medium:** fetches 54 -> 24-30 (-45 to -55 %); ALU: -800 (prologue) -120 (one octave) -320 (one cell octave)
  -1750 (shadow) -450 (sun) of ~7200 = **about -45 %**. If the shader is latency/occupancy-bound the real figure is
  anywhere from 25 % to 60 %. Estimated frame at the 0.4 km view: 5.7 ms -> ~3 ms.
- **Low:** fetches 54 -> 8 (-85 %); ALU roughly -65 %. Estimated 5.7 ms -> ~1.5-2 ms.

### 4.4 What the user would notice

- **Medium:** slightly sharper texture transitions in the eight cube-corner regions of the planet (biplanar), no
  per-texel roughness variation inside a hex cell edge (ORM at one cell), the 28 m relief grain missing below ~2 km
  (the 61 m octave and the textures remain), shadows with the same shape but softened at ~1 texel (baked), normals
  a little blurrier along the view at grazing angles (aniso 4). Lighting, colours, materials otherwise identical.
- **Low:** visible texture repetition at mid distance (no hex blend; the random per-cell offset hides it at a
  distance but cell edges show up close), two-layer material blends (harder edges at three-way junctions),
  noticeably flatter close-up relief (3 fine octaves, 61 m finest), no ice sparkle, sea-ice frost tint gone.

---

## 5. Measurement plan

Method: the breakdown.js harness (`.playwright-mcp/breakdown.js`): pause the app's render loop and rock placement,
render 12 back-to-back frames, `readPixels` to sync, best of 6 runs, 3 interleaved rounds per config, report
`full - config`. The best-of already absorbs the two GPU clock states the WORKLOG mentions. Add to the existing
`cfgs` table as needed; every number is a delta against `full` measured in the same run.

Views: the rust 26508 rugged spot at 0.4 km horizon (the reference), plus 2 km horizon and 0.4 km looking down,
HQ **off** for the shader work (one material, no ring overshade in the number); repeat the final candidates with HQ
on. Add an ice-shell world for the glossy/glint path.

### 5.1 Zero-edit diagnostics (no shader changes; one session, ~30 min)

| # | Knob (set in the harness, restore in `finally`) | What the delta tells you |
|---|---|---|
| 0 | `terrainMat.defines = { TERRAIN_TIER: 0 }` + `needsUpdate` (the HQ rings' materials too) vs none. It must be a real define (an empty `defines` object adds no line and tests nothing); the shader does not read it yet, so the only difference is the extra `#define` line in the compiled source | the tier mechanism's baseline cost must be 0 before any tier is trusted |
| 1 | `uDebug = 4` | the shader returns at 317: `full - debug4` = texture stack + lighting + shadow + sun; `debug4 - sky` = setup + noise + detailGrad. The single most useful split; it is a uniform-int branch and should be honoured |
| 2 | `uShadows = 0` | if the delta is ~0 either the branch at TL:39 is flattened or the march is cheap: compare with 5.2 (a) |
| 3 | `uAtmoDensity = 0` | `sunLightAt` cost (uniform branch A:78) |
| 4 | `uAntiTile = 0` | `gTileMix` is a global float, not a uniform: a ~0 delta means the `gTileMix <= 0.0` early-outs (131, 142, 150) are flattened and the second hex cell is always paid; a large delta means fxc did keep them |
| 5 | `uDetailAmp = 0` | `detailGrad` early return at 178 (uniform) |
| 6 | `uLavaGlow = 0/14` on a non-lava world | whether 493 is honoured |
| 7 | `tNormal/tOrm.anisotropy = 4`, then 1 (needsUpdate) | filter-boundness of the stack; proposal 3.1 |
| 8 | `minFilter = LinearMipmapNearest` on the three arrays | same, trilinear cost |
| 9 | `uFineDetail = 0` | should be ~0 (no work is skipped by it): a sanity check on the harness noise floor |

### 5.2 Source ablations (shader edits in the measuring session only)

Swap the source from the harness: `const src = terrainMat.fragmentShader; terrainMat.fragmentShader =
src.replace(...); terrainMat.needsUpdate = true;` then `frame(); frame();` before timing, and restore. With HQ off
only `terrainMat` matters. Each ablation is a ceiling for the proposal next to it. Order by expected information:

| # | Ablation | Proposal it bounds |
|---|---|---|
| a | `terrainShadow` body -> `return 1.0;` | S3 ceiling |
| b | shadow loop without `break`, 22 iterations | S1 (this *is* the proposal) |
| c | `detailGrad` -> `return vec3(0.0);` | ceiling for all of 3.5 |
| d | detailGrad loop `k < 5` | tells whether the per-pixel fades (193) are honoured: if 8 -> 5 octaves saves ~3/8 of (c) the fades were doing nothing in the far band; if less, they were |
| e | `styleOct` -> `styleOctSmooth` for all k (no `cellular2`) | R2/R3 ceiling |
| f | 295-297 -> constants (`macro = 0.0`, `gRegion = 0.0`, `region2 = 0.0`) | F1 |
| g | `sunLightAt(vWorldPos)` -> `uSunColor` | L1 ceiling (compare with 5.1 #3) |
| h | add a dummy `varying vec3 vSunCol` written by both vertex shaders, read once | the varying cost that L1 would pay |
| i | third plane removed (`bw.z` terms and `hZ` deleted) | T2 ceiling |
| j | second hex cell removed in `tri*` (return `c1`) | T3 / low-tier hex |
| k | `triOrm` calls removed, `orm = vec3(1.0, 0.7, 0.0)` | T1 (-18 fetches) and T3 |
| l | normal+ORM loop (393-416) removed | the whole K stage |
| m | `NLAY 2` | T4 |
| n | `iceGlints` -> 0; `lava` block removed | L2, L3 |
| o | select-form sort at 332; single `tAO` | L4 |

Keep a table of `full`, delta, and the sum of deltas: if (a)+(c)+(f)+(g)+(l) sum to much more than `full - sky`,
the shader is latency-bound and the removals overlap (removing any one frees occupancy for the rest) — then T6 and
S1 deserve more attention than the op counts suggest.

### 5.3 Implementation order

1. **5.1 #0 and #1** (tier baseline, debug-4 split). Nothing else until these two numbers exist.
2. **3.1 anisotropy** (zero edit, keep if it helps).
3. **S1** fixed-trip shadow loop (trivial, no visual change), then **S2** fast atan if S3 is not done soon.
4. **L4 + L6** cleanups (single tAO, select sort, hash33, ungated normal/ORM fetches) in the same edit as S1 so the regression gate covers them.
5. **F1** baked fields (new pass, no visual change, also helps the HQ vertex shader).
6. **T1** packed normal + roughness + AO (-18 fetches, no visual change).
7. **S3** baked shadow (replaces S1/S2; also simplifies rock placement).
8. **T2** biplanar (first visually non-identical change; screenshot the 8 corner regions before/after).
9. **Tiers** (section 4) with the remaining knobs (NLAY, octaves, cells, L1/L2/L3), each tier measured on all views
   and both worlds, high tier re-verified equal to the pre-tier program.
10. **T6** plane-major restructure last, only if 5.2 shows the shader is latency-bound and the above left it so.

After every step re-run the reference view with HQ on and off, and keep the pre-change screenshot for a byte/visual
diff; on D3D a program that lost work can still cost more, and the only way to know is the number.
