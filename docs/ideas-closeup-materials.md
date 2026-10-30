# Close-up materials: why the detail textures fight the relief, and a cheap layered material model

Design review (2026-10-30) of the low-altitude look after `exp/closeup` (plan in `docs/plan-closeup.md`). Scope: shader-level
changes with a few ALU each, no new passes, no new texture packs. Line numbers refer to the tree at `c205465`.

Design range. The camera floor is `minAltitude = 0.4 km` over the baked ground plus a `1.6 * detailAmp` margin
(`src/render/controls.ts:34`, `src/render/planetView.ts:450`), so the close views are 0.4-6 km up, about 0.4-5 m/px,
mostly oblique. Everything below assumes that band. If the floor drops to metres later, the tile sizes in section 3.3 scale
with it and 3.9 becomes relevant; nothing else changes.

## 1. Diagnosis: why the textures override the relief

The problem is not the whiteout blend (`terrain.frag.glsl:383-386`); that operator is fine. It is scale, correlation and
painted light.

1. **Slope is scale-invariant, height is not.** `planetView.ts:386` tiles the 1.5-4 m ambientCG scans at `textureScale = 250`
   (dust 500 m, basalt/sand 625 m, rock 1000 m, gravel 375 m; ice/salt 187/151 m after `LAYER_SCALE_MUL`). A tangent normal
   stores slope, so a 2 cm pebble with 45 deg flanks becomes a 5 m bump with 45 deg flanks. The texture normal therefore
   arrives with slope magnitudes comparable to the procedural fine relief (whose total slope is ~0.3-0.5 at `uDetailAmp = 350`,
   see `detailGrad`, `terrain.frag.glsl:173-210`) and comparable to the macro gradient. Two relief signals of equal slope in
   one band: the one that is sharper and repeats (the texture) wins the eye.
2. **Frequency collision.** Fine octaves k3..k7 are 604/281/131/61/28 m. Stretched texture features (tile/10 .. tile/100)
   are 5-100 m. Same band, uncorrelated. The crack-net fix for ice/salt (`LAYER_SCALE_MUL`, `LAYER_NORMAL_MUL`,
   `planetView.ts:76-77`) was a special case of this general problem.
3. **Painted light.** `orm.r` is baked pebble AO stretched to 50 m features. `ao = mix(1.0, orm.r, 0.8)` (line 390)
   multiplies the ambient, and `micro = clamp(abs(NoL) + 2.0 * ao * ao - 1.0, ...)` (line 433) gates the *direct* sun.
   That is static shading that never moves with the sun or with the procedural relief. The albedo JPEGs carry the same baked
   crevice darkening. From 1 km this reads as a printed pattern lying on top of the lit relief.
4. **Material and relief are uncorrelated.** `detailGrad` evaluates `styleOct` / `styleOctSmooth` (lines 192, 201, 202),
   keeps the gradient and discards the *value*. The relief exists only as a normal. Albedo, roughness and AO come either from
   the ~1.5 km heightmap-scale data (splat, `tAO`, climate; one texel is R*pi/2/N) or from the stretched textures. The
   `settle` term (line 409) uses `tAO` and `flatK`, both km-scale. In the 10-600 m band, which is the band a 1 km camera
   sees, nothing changes the material. Real ground is the opposite: albedo tracks relief (fines in the lows, clasts and bare
   rock on crests and scarps).
5. **No close-range subordination.** `detailFade` (line 379) fades the texture normal only beyond 60-900 km. There is no
   fines mask, no magnification fade (footprint vs texel), no exposed-bedrock gate. The height blend (lines 338-348) uses the
   stretched texture height only *between layers*; there is no fill level between relief and texture, so dust and rock
   interdigitate in 500 m pebble shapes along every splat edge.
6. **One global dust.** Line 410 settles `uLayerTint[0] * uLayerMean[0]` into every hollow. Ice hollows get grey-beige
   regolith; basalt hollows get dust lighter than the basalt around them in the wrong direction.
7. **Rocks are not part of the ground's material.** `rocks.glsl` tints blocks by their own layer and brightens them
   (`1.0 + 0.4 * vSeed`), with no fines on top and no shared coating. They sit on the surface rather than in it.

## 2. Material model: parent mineral + weathering products

### 2.1 Roles of the eight layers

| layer | role | parent | products it sheds / that cover it |
|---|---|---|---|
| 2 basalt | parent (dark volcanic bedrock) | - | basaltic fines (dark), gravel clasts, oxide/varnish |
| 4 rock | parent (stratified bedrock, scarps) | - | dust, sand, gravel, varnish |
| 6 ice | parent (ice shell) | - | frost (bright, matte), ice blocks |
| 1 highland | gardened regolith (product of impact) | rock | dust, gravel; space-weathered coating |
| 5 gravel | coarse clasts | rock/basalt | dust between clasts |
| 3 sand | fines, wind-sorted | rock | - (it is a product) |
| 0 dust | finest fines | any | - |
| 7 salt | crust / evaporite | - | salt dust (brighter, finer) |

Nothing here needs a new texture. Every product colour is derived from the parent's mean (`uLayerMean`) and the world
tint (`uLayerTint`), and `uLayerTint[0]` already *is* the planet's oxide colour (`presets.ts:109-113` derives the haze tint
from it). Products differ from the parent by three analytic shifts:

- **fines**: brighter (x1.15-1.4 relative to the parent mean, dust on basalt stays dark: x1.3 of 0.065 is still dark),
  desaturated 30-50 %, texture contrast down to 0.3-0.5, roughness 1.0, texture normal x0.2.
- **clasts**: parent colour, full texture contrast, full normal, roughness as the texture.
- **coating**: oxide (toward `uLayerTint[0]` hue, slight darkening), space weathering on airless worlds (darker and redder
  with exposure age; `uFinePits` is already the airless proxy), desert varnish (darker, slightly glossy, on old flats),
  frost (toward white, roughness ~0.45, normal x0.5) on cold pole-facing or shadowed slopes.

### 2.2 Masks, all from data the shader already has

| mask | source | drives |
|---|---|---|
| `hFine` fine-relief height (-1..1 normalised) | the discarded `styleOct` value in `detailGrad` | fines fill (lows), exposed crests |
| `slopeF` fine slope | `length(G)` from `detailGrad` before projection | clasts and bare rock on steep micro-flanks |
| `flatK`, `steep` | baked gradient (line 252-254) | km-scale dust retention / scree |
| `terrAO` cavity | `tAO` (line 391) | dust in hollows, less varnish in cavities |
| `texH` clast height | `ah[k].a` | height blend of fines vs clasts |
| `gRegion`, `region2`, `macro` | noise already evaluated (255-257) | exposure age patches, dust fields |
| `temp`, `moist` | `climate.rg` (line 414) | frost, damp darkening |
| pole-facing | `dot(Nm, vec3(0, sign(n.y), 0))` | frost retention |
| lee side | `dot(Gh, wind)` with `wind = normalize(cross(vec3(0,1,0), n))` | sand/dust drifts, ripple orientation |
| `uFinePits` | uniform | airless: space weathering instead of oxidation |

### 2.3 Compositing order

The order matters more than any single term. Each stage consumes the masks of the previous one:

```
macro normal Nm (baked gradient)                                  [exists, line 235-237]
  -> fine relief: G (normal) AND hFine (height)                   [hFine is new: 1 out param]
  -> fill level: fill = smoothstep(lvl-w, lvl+w, -(hFine + texH*kClast))
  -> exposed = (1 - fill) * (0.5 + 0.5*slopeF-ish)                [bare rock on crests & flanks]
  -> texture detail, subordinated:
       albedo_tex = mean + (tex - mean) * contrast(layer) * mix(0.35, 1.0, exposed)
       tn.xy     *= mix(0.2, 1.0, exposed) * magnificationFade
       ormAO      = mix(1.0, orm.r, 0.8 * exposed)
  -> product colour: albedo = mix(albedo_tex, finesColour(parent), fill)
  -> coating: oxide / space weathering / varnish by exposure age; frost by temp & aspect
  -> roughness: rough = mix(rough_tex, 1.0, fill); frost/varnish adjust after
  -> rocks (rocks.glsl): same fines colour on their upward faces
```

"Detail as deviation from mean" is the key move for the albedo: the texture then adds *structure* at an amplitude the
relief controls, instead of adding a second lighting pattern. For the normal, the fines mask and the magnification fade do
the same. Reoriented normal mapping (RNM) in the fine-relief frame would be a marginal improvement over the whiteout blend
and is not worth the ALU here; the frequency and amplitude fixes are.

## 3. Ranked changes (payoff / cost)

Constraints from `docs/plan-closeup.md:63-68` apply to every sketch: `dFdx(N)` stays in uniform control flow at the top of
`main`; D3D flattens data-dependent branches, so any extra texture sample must be always-on with a weight fade (or a
`#define` variant), never behind a uniform `if`.

### 3.1 Fine-relief height out of `detailGrad`, and fines fill from it  (payoff: very high, cost: ~15 ALU)

Where: `terrain.frag.glsl` `detailGrad` (173-210), the call at 271, the weathering block at 405-413, texture terms at 357-375.

`styleOct` already returns the value; accumulate it in the same units `detailM` uses (metres), plus the amplitude envelope
so the fill threshold is scale-free. With `a = 0.4` and `uDetailAmp = 350`, k3 alone is ~100 m of relief at 604 m
wavelength, k5+ are a few metres, so without the envelope a fixed threshold would only ever see k3.

```glsl
// detailGrad(vec3 d, float h, vec4 fineStyle, out float hFine)
float hv = 0.0, env = 1e-4;
...
      float v = (k < 6) ? styleOct(...)  : styleOctSmooth(...);   // keep the return value
      float wk = a * fineM * f;
      hv  += wk * v;
      env += wk * 0.5;          // ~ half peak-to-peak of one octave
      G   += (wk / s) * g;
...
hFine = hv / env;               // ~ -1..1, independent of altitude and fade state
```

In `main`, after line 274:

```glsl
float hFine; vec3 G = detailGrad(n, hM, fineStyle, hFine);
float slopeF = length(G) / (uDetailAmp * uHeightScale + 1e-4);          // fine slope, ~0..1
// Fines fill the lows like a liquid: level rises on flats and in cavities, drops on slopes and in rough regions.
float lvl  = -0.15 + 0.35 * flatK + 0.25 * (1.0 - terrAO) - 0.3 * steep + 0.1 * gRegion;
float fill = smoothstep(lvl - 0.25, lvl + 0.25, -hFine) * uWeathering;
float exposed = (1.0 - fill) * (0.6 + 0.4 * smoothstep(0.2, 0.7, slopeF));
```

Then use `fill`/`exposed` in the texture loop (357-375): `tx.xy *= uLayerNormal[idx] * mix(0.2, 1.0, exposed)`, and in the
weathering block replace the km-scale `settle` with `max(settle, fill)` feeding the same `mix` to the fines colour and
`rough = mix(rough, 1.0, fill * (1 - glossy))`. Also apply to the layer height blend before line 338:
`hb[k] = wt[k] + ah[k].a * uHeightBlend * (1.0 - 0.8 * fill)` so filled zones blend softly and exposed zones blend by clast height.

Risk: `terrAO` is sampled at line 391, after this point; hoist the `textureLod(tAO)` (it is sampled twice already, 391 and
409; one sample is enough). The fill edge is a smoothstep on a C1 field, so no new aliasing; tie `0.25` width to
`gDetailFootprint / s_k3` if the edge ever sparkles far away.

### 3.2 Albedo and AO as deviation from the mean, gated by `exposed`  (payoff: high, cost: ~6 ALU)

Where: line 357 (`albedo += hb[k] * ah[k].rgb * uLayerTint[idx]`), 390, 433.

```glsl
vec3 m = uLayerMean[idx[k]];
float ck = uLayerContrast[idx[k]] * mix(0.35, 1.0, exposed);     // new uniform: dust .5, sand .6, highland .8, rest 1
albedo += hb[k] * (m + (ah[k].rgb - m) * ck) * uLayerTint[idx[k]];
...
float ao = mix(1.0, orm.r, 0.8 * exposed);        // baked pebble AO only where clasts are exposed
float micro = clamp(abs(NoL) + 2.0 * ao * ao - 1.0, 0.0, 1.0);
```

This removes most of the "printed pattern" at 250x without touching the texture pack; the contrast returns where it belongs
(clast fields, scarps). The `albedoHarmony` logic in `planetView.ts` is unaffected because it works on `uLayerTint` means.
Risk: basalt gets flatter; keep its contrast at 1.0 and let the fill do the work there.

### 3.3 Second texture octave for the dominant layer at 40-100 m tiles  (payoff: high at the floor, cost: 2 samples)

Where: a new sample next to the texture loop, dominant layer `idx[0]` and dominant projection only, plain tiling (no hex: at
0.4 m/px a 50 m tile shows ~10 repeats across a 1400 px frame and the hex offset is not needed), luminance + normal only.

Tile = `tileMeters * textureScale / 10` (dust 50 m, basalt/sand 62 m, rock 100 m, gravel 37 m; features 0.5-10 m, i.e.
1-25 px at the floor). Fade by footprint, not altitude: with `gs` in tiles per km, `gFootprint * gs` is tiles per pixel,
0.008 at the 0.4 m/px floor and 0.054 at ~3 km (2.7 m/px), so
`wGrain = 1.0 - smoothstep(0.04, 0.10, gFootprint * gs)` is full from the floor to ~2 m/px and gone by ~5 m/px.
Always sampled; the weight does the gating.

```glsl
float gs = uLayerScale[idx[0]] * 10.0;
vec2 guv = (bw.x > max(bw.y, bw.z)) ? uvX : (bw.y > bw.z ? uvY : uvZ);   // dominant projection
vec4 ga = texture(tAlbedo, vec3(guv * gs, float(idx[0])));
vec3 gn = texture(tNormal, vec3(guv * gs, float(idx[0]))).xyz * 2.0 - 1.0;
float gl = dot(ga.rgb, LUMA) / max(dot(uLayerMean[idx[0]], LUMA), 1e-3);  // luminance ratio around 1
albedo *= mix(1.0, gl, 0.5 * wGrain * exposed);
tn_dominant.xy += gn.xy * 0.6 * wGrain * mix(0.3, 1.0, exposed);       // add into whichever tnX/Y/Z is dominant
```

Both multiplies reuse the `exposed` gate, so the grain lives on clasts and bedrock and fades under fines. Risk: branch on
the dominant projection is a select, fine on D3D; the grain picks one projection so its seam at projection boundaries is
hidden only by the `bw` weights of the macro layers. If the seam shows, weight it by `max(bw)` squared.

### 3.4 Fines caps on the rocks  (payoff: medium, cost: 3 ALU)

Where: `rocks.glsl` fragment, after `albedo`. The rocks get the same fines colour as the ground around them on their
upward faces, and lose the +40 % brightening on worlds where fines cover everything.

```glsl
vec3 fines = uLayerTint[0] * uLayerMean[0] * 1.15;            // same expression as the ground's fill colour
float cap = smoothstep(0.3, 0.9, dot(N, n)) * uFines;         // uFines = weathering * world dustiness
albedo = mix(albedo, fines, 0.35 * cap);
```

With 3.5 pass the per-parent fines colour instead. Risk: none; tie `uFines` to the same slider as `uWeathering`.

### 3.5 Per-parent fines colour instead of one global dust  (payoff: medium, cost: ~8 ALU, 1 uniform array)

Where: line 410 and the fill mix from 3.1. Add `uLayerParent[8]` (int or float) and derive the fines colour per top layer:

```glsl
vec3 finesOf(int L) {
  vec3 m = uLayerMean[L] * uLayerTint[L];
  float lum = dot(m, LUMA);
  vec3 desat = mix(m, vec3(lum), 0.4);
  return desat * mix(1.4, 1.1, smoothstep(0.1, 0.5, lum));   // dark parents brighten more, bright ones less
}
vec3 finesCol = vec3(0.0);
for (int k = 0; k < NLAY; k++) finesCol += hb[k] * finesOf(uLayerParent[idx[k]]);
finesCol = mix(finesCol, uLayerTint[0] * uLayerMean[0], uDustMantle);   // global mantling (0 on ice shells, 1 on Mars-likes)
```

Parent table: dust->0, highland->4, basalt->2, sand->4, rock->4, gravel->4 (or 2 on volcanic worlds), ice->6, salt->7.
Ice fines are frost: `finesOf(6)` brightens and desaturates the ice mean, which is right. Risk: a loop over NLAY with
uniform-array indexing is cheap but keep the index a compile-time-friendly int.

### 3.6 Exposure age: oxide, space weathering, varnish  (payoff: medium, cost: ~8 ALU)

Where: after the fill and fines mix. Old, stable surfaces are flat, not in channels, not fresh ejecta; fresh = craterlet
rims (pitted octaves), scree on steep flanks, gravel (`wGravel` = sum of `hb[k]` where `idx[k] == 5`, like `glossy` at 394).

```glsl
float fresh = clamp(steep + 0.6 * smoothstep(0.3, 0.8, slopeF) + 0.5 * wGravel, 0.0, 1.0);
float age = flatK * terrAO * (1.0 - fresh) * (0.6 + 0.4 * region2) * uWeathering;
// Airless (uFinePits ~1): nanophase-iron darkening and reddening. With air: oxide hue from the world's dust tint.
vec3 spaceW = vec3(0.72, 0.66, 0.62);
vec3 oxide  = normalize(uLayerTint[0] + 1e-3) * 1.5;           // hue only, unit-ish brightness
vec3 coat   = mix(oxide, spaceW, uFinePits);
albedo *= mix(vec3(1.0), coat, 0.35 * age * (1.0 - fill));      // coatings sit on exposed surfaces, not on loose fines
rough  -= 0.1 * age * (1.0 - fill) * (1.0 - uFinePits);         // desert varnish is a little glossy
```

Risk: double-counting with `uMacroVar * macro` (line 406) and the regional brightness drift (412); drop the `0.06 * gRegion`
term there once `age` carries the regional variation.

### 3.7 Frost on cold, pole-facing and shadowed ground  (payoff: medium on cold worlds, cost: ~8 ALU)

Where: the mask needs only `temp`, `Nm`, `terrAO`, `flatK`, `steep`, all available before the texture loop (line 323), so
compute it there; the `tn.xy` attenuation must land before the whiteout blend (383), the albedo/roughness part goes after
the weathering block. `temp = climate.r` is Kelvin/510.

```glsl
float cold   = smoothstep(190.0 / 510.0, 150.0 / 510.0, temp);                 // tune per volatile
float polar  = 0.5 + 0.5 * dot(Nm, vec3(0.0, sign(n.y), 0.0));                 // pole-facing slopes keep frost
float shaded = 1.0 - terrAO;                                                   // cavities too
float frost  = cold * clamp(0.5 * polar + 0.5 * shaded + 0.3 * flatK - 0.3, 0.0, 1.0) * (1.0 - steep);
albedo = mix(albedo, vec3(0.75, 0.78, 0.82), 0.7 * frost);
rough  = mix(rough, 0.45, frost);  tn.xy *= (1.0 - 0.5 * frost);   // apply before the whiteout blend
```

Do not use `dot(Nm, uSunDir)`: the sun moves with the day cycle and frost would flicker on/off per frame. Risk: competes
with the ice layer's own look; scale `frost` by `(1 - glossy)` so ice keeps its texture.

### 3.8 Wind: lee drifts and oriented ripples  (payoff: medium on sandy worlds, cost: ~10 ALU, 1 uniform)

Where: fill level (3.1) and `detailGrad`'s sand octaves. A zonal wind `wind = normalize(cross(vec3(0,1,0), n))` is free;
it vanishes at the poles, so weight by `length(cross(...))` before normalising.

```glsl
vec3 wind = cross(vec3(0.0, 1.0, 0.0), n); float wl = length(wind); wind /= max(wl, 1e-4);
float lee = smoothstep(0.0, 0.12, -dot(Gh, wind)) * wl;        // ground facing away from the wind
lvl += 0.25 * lee * wSand;                                     // drifts bank up on lee slopes
// Oriented ripples: compress the sand octaves along the wind so crests run across it.
vec3 q = d * (uRadius / s); q += wind * dot(q, wind) * 1.5 * fineStyle.x * wSand;
```

Risk: `fineStyle.x` (ridged) is shared by rock scarps and dunes; only stretch when the sand weight dominates, or the scarps
get a wind grain too.

### 3.9 Only if the camera floor drops: magnification fade of the texture normal  (cost: ~4 ALU)

Not needed in the current range: at the 0.4 m/px floor the dust tile is 0.49 m/texel, i.e. ~0.8 texels/px, barely
magnified. The soft-decal look at the floor is the 250x stretch (section 1, points 1 and 3), not magnification. If
`minAltitude` ever drops to tens of metres, replace the 60-900 km fade at line 379 with a texel-per-pixel one:

```glsl
float texPx = gFootprint * uLayerScale[idx[0]] * 1024.0;      // texels per pixel for the dominant layer
float magFade = smoothstep(0.15, 0.6, texPx);                 // 0 below ~0.07 m/px (6 px per texel)
tnX.xy *= uNormalStrength * (1.0 - smoothstep(60.0, 900.0, camDist)) * magFade; ...
```

and shrink the 3.3 grain tile with the floor so its features stay 1-25 px.

### 3.10 Smaller things worth doing while in there

- `textureLod(tAO)` is sampled at 391 and 409; sample once.
- `slopeF` (3.1) is normalised by `uDetailAmp * uHeightScale`, so it is invariant to those sliders but not scale-free the
  way `hFine` is; fine at the defaults.
- Line 433 `abs(NoL)`: the `abs` lets back-facing texture normals pass the micro-shadow gate; if it is intentional for the
  terminator, leave a comment, otherwise `max(NoL, 0.0)`.
- The dust `tileMeters: 2.0` with contrast 0.8 is still the highest-contrast thing at 500 m. If 3.2 ships, `uLayerContrast`
  replaces the offline contrast squeeze in `tools/fetch_textures.py` (`notes-textures.md`), and the pack can keep full contrast
  for the grain octave (3.3).

Suggested order: 3.1 -> 3.2 -> 3.4 (one evening, no new samples), then 3.3, then 3.5-3.8 by world type.

## 4. Planet-specific mood grade when the camera is deep in the atmosphere

Brief, since a version is being built in parallel.

**Analytic beats a 3D LUT here.** The parameters are continuous per world (atmosphere colour, haze tint, sun colour) and
per altitude (fade weight); a LUT would have to be rebuilt per world and blended per frame, and it cannot be split across
the tonemap boundary. ~20 ALU of analytic grade does the job. A LUT only earns its place if someone wants to hand-author
looks in a grading tool.

**Where.** Two halves, split by the tonemap:

1. Scene-referred (linear HDR), inside `atmosphere_pass.frag.glsl` at the final composite
   `col * viewTr * exp(-uHaze * hazeOD) + inscatter`: apply white balance and the shadow/highlight tint to the **surface term
   only**, before adding `inscatter`. The haze stays physically right, and the grade models what single scattering cannot:
   multiple-scatter ambient on the near ground, and the eye's adaptation to the air colour. No new pass, no new target.
2. Display-referred, after `OutputPass` (ACES + sRGB) and before SMAA in `pipeline.ts:104-107`: lift/gamma/gain and
   saturation, if wanted at all. A tiny `ShaderPass`. If this half is skipped nothing breaks.

**Weight.** One scalar per frame, computed on the CPU from the same formulas `atmosphere_common.glsl` uses
(`atmoDensityAt`, haze `exp(-h/uHazeH)`), at the camera altitude above the figure:

```
rho   = atmoDensity * (rayleighMean * exp(-h/rayleighH) * rayleighH + mie * exp(-h/mieH) * mieH)   // local column, km^-1 * km
      + haze * exp(-h/hazeH) * hazeH
w     = 1 - exp(-rho * K)                      // K ~ 1.5..3, so Earth-like at sea level gives ~0.7, thin CO2 ~0.2
w    *= smoothstep(-0.1, 0.25, dot(camUp, sunDir))    // no mood on the night side
w     = lerp(wPrev, w, 0.1)                    // frames; the figure bumps otherwise jitter h
```

**Parameters per world, derived, no new authoring:**

- `tintAir` = `normalize(uSkyAmbient)` as `main.ts:147-159` already computes it (Rayleigh + Mie colour, plus the haze's dusty
  skylight). Shadow end of the split tone.
- `tintSun` = `sunLightAt(cam)` direction (sun colour through the local airmass). Highlight end.
- White balance = pull toward the complement of `tintAir` by `0.15 * w` (von Kries multiply in linear; the eye adapts to the
  ambient, so a blue sky makes the ground look warmer, a dusty sky makes it cooler than it is).
- Split tone: `col *= mix(1, tintAir, 0.2 * w * (1 - lum))` and `col *= mix(1, tintSun, 0.1 * w * lum)` with `lum` a soft
  luminance mask in HDR (e.g. `smoothstep(0.05, 0.5, lum)`).
- Saturation (display-referred): `-0.1 * w * hazeFraction` where `hazeFraction = hazeTerm / rho`; dusty air flattens colour,
  Rayleigh air does not. Never above 1.
- Lift: `+0.004 * tintAir * w` at most (display-referred). More than that and the blacks go milky on top of the haze pass,
  which already lifts far pixels.

**Pitfalls.**

- No gain before bloom: the bloom threshold is 1.6 in HDR (`DEFAULT_ENV.bloomThreshold`, applied at `main.ts:132`); any
  pre-bloom multiply changes what blooms.
- No saturation or hue work after ACES at strengths above a few percent: the output is already 0..1 and clips to hue shifts.
- No white balance after the tonemap: ACES desaturates highlights, a post-WB re-tints them unevenly.
- Do not tint the `inscatter` term; it already carries `uHazeColor` and `uSunColor`. Grade only the surface term.
- Do not use `camDist`-based or altitude-based weights directly; use the density so airless worlds (`MIN_ATMO_DENSITY`)
  get nothing and thick-haze worlds get it even at 10 km.
- Keep the night side out (`dot(camUp, sunDir)` factor), and keep `exposure` (`env.exposure`) untouched; the grade must be
  invisible at `w = 0` and the HUD screenshots at orbit must not change.

**Notes on the `moodGrade()` now in the working tree** (`atmosphere_pass.frag.glsl`, uncommitted at the time of writing).
The derivation of `air` / `sun` from the scattering coefficients, the `dusty` fraction driving desaturation, the `uExposure`
pivot for the shadow/highlight mask and the `1 - exp(-ext * 25)` weight all match the above and look right. Three things
to reconsider:

1. It is applied to `col * viewTr * exp(-uHaze * hazeOD) + inscatter`, i.e. the haze gets graded too. On a dusty world the
   inscatter already is `uHazeColor * uSunColor`; the split tone then pushes it toward `air` a second time and the
   desaturation flattens a colour that was physically right. Grade `col * viewTr * exp(-uHaze * hazeOD)` and add
   `inscatter` afterwards. If the near-ground result then feels too thin, raise the surface strength rather than tinting the haze.
2. `atmoDensityAt(uCamPos)` and the rest of `w` depend only on uniforms. Drivers often hoist that, but WebGL gives no
   guarantee, and it is ~30 ALU plus an `exp` per pixel on a 16-64 step pass. A CPU-side `uMoodW` also allows the
   frame-to-frame smoothing, which the per-pixel version cannot do (the figure bumps make `h` jitter on low flybys).
3. `mix(0.35, 1.0, day)` keeps 35 % of the grade on the night side. The night side is lit by planetshine
   (`uFillColor`), not by the sky, so the `air`/`sun` endpoints are the wrong colours there; fade to 0, or swap the shadow
   endpoint to `uFillColor` when `day < 0.5`.
