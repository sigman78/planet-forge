// Terrain: splat-blended triplanar PBR on a displaced cube-sphere.
#define LAYERS 8
// brdf() and terrainShadow() come from terrain_light.glsl (shared with the surface rocks).

uniform sampler2DArray tSplat0;
uniform sampler2DArray tSplat1;
uniform sampler2DArray tClimate;
uniform sampler2DArray tAlbedo;   // sRGB albedo, a = height
uniform sampler2DArray tNormal;   // GL normal
uniform sampler2DArray tOrm;      // ao, roughness, metal
uniform float uLayerScale[LAYERS];   // tiles per km
uniform float uFineDetail;           // strength of the sub-mesh detail octaves (0 = off)
uniform vec4  uLayerStyle[LAYERS];
uniform float uFinePits;             // scale of the pitted fine style (low on worlds with an atmosphere)   // fine detail style per layer (ridged, billowy, cracked, pitted)
uniform sampler2DArray tAO;          // heightmap ambient occlusion (R)
uniform sampler2DArray tGrad;        // baked height gradient (m per km, world space)
uniform float uTerrainAO;            // heightmap AO strength
uniform vec3  uLayerTint[LAYERS];
uniform vec3  uLayerMean[LAYERS];    // mean linear albedo of each texture (settled dust colour)
uniform float uLayerNormal[LAYERS];  // per-layer texture normal strength (crack textures are toned down)
uniform float uWeathering;           // dust settling, scree, regional jitter (0 = off)
uniform float uNormalStrength;
uniform float uMacroNormal;          // strength of the heightmap-derived normal
uniform float uHeightBlend;          // contrast of height-based blending
uniform float uTriSharp;
uniform float uMacroVar;             // macro albedo variation
uniform float uWetness;
uniform float uChannels;
uniform float uAmbient;
uniform vec3  uSkyAmbient;
uniform vec3  uFillDir;              // planetshine from the parent giant (broad, dim fill light)
uniform vec3  uFillColor;
uniform vec3  uLavaColor;            // shared with the ocean shell (lava seas)
uniform float uLavaGlow;
uniform float uTime;
uniform int   uDebug;
uniform vec3  uLayerDebugColor[LAYERS];
uniform vec3  uUnitColors[32];

varying vec3 vDir;
varying float vElevM;
varying vec3 vWorldPos;
// HQ terrain ring level (0 on the coarse mesh), for the debug tint. The rings share this exact shader source:
// a variant (define, extra varying) compiled measurably slower on D3D.
uniform float uHQLevel;


vec3 heightRamp(float h) {
  if (h < 0.0) {
    float t = clamp(-h / 6000.0, 0.0, 1.0);
    return mix(vec3(0.35, 0.6, 0.85), vec3(0.02, 0.05, 0.25), sqrt(t));
  }
  float t = clamp(h / 9000.0, 0.0, 1.0);
  vec3 c = mix(vec3(0.15, 0.45, 0.15), vec3(0.75, 0.65, 0.35), smoothstep(0.0, 0.4, t));
  c = mix(c, vec3(0.5, 0.35, 0.25), smoothstep(0.35, 0.7, t));
  return mix(c, vec3(1.0), smoothstep(0.7, 1.0, t));
}

// t = Kelvin / 510.
vec3 tempRamp(float t) {
  t = clamp((t * 510.0 - 40.0) / 420.0, 0.0, 1.0);
  return mix(mix(vec3(0.1, 0.2, 0.9), vec3(0.2, 0.9, 0.3), smoothstep(0.0, 0.5, t)), vec3(0.95, 0.2, 0.05), smoothstep(0.5, 1.0, t));
}

uniform float uRoughMin;   // roughness floor for rock/dust layers (ice & salt keep their own)
uniform float uAntiTile;   // 0 = plain tiling, >0 = hex-tiling (random offset+rotation per hex cell)

// ---- Hex-tiling (Mikkelsen 2022, "Practical Real-Time Hex-Tiling") ---------------------------------
// The texture plane is covered by a hexagonal grid; each cell samples the texture with a random offset and
// rotation, and the 3 nearest cells blend with luminance-aware weights. Removes visible tile repetition.
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
uniform float uHexFreq;           // hex cells per km (set from the mean layer tile size)
float gTileMix = 0.0;             // 0 = plain tiling, 1 = hex-tiling (uniform uAntiTile)

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
mat2 hexRot(vec2 v) {
  float a = hash12(v) * 6.2831853;
  float c = cos(a), sn = sin(a);
  return mat2(c, sn, -sn, c);
}

// The hex grid lives in world km on each projection plane and is shared by all layers and maps, so the
// expensive part (cell lookup, hashes, sin/cos) runs once per projection instead of once per lookup.
// Only the 2 strongest of the 3 cells are sampled: with the sharp blend the third is almost always ~0,
// and the sample count must be fixed because the D3D compiler flattens data-dependent branches.
const int NLAY = 3;   // splat layers blended per pixel (texture cost scales with this)

// j: per-cell brightness jitter (x for cell 1, y for cell 2), so no two cells read as the same tile.
struct Hex { vec2 w; mat2 r1; mat2 r2; vec2 o1; vec2 o2; vec2 j; };

Hex makeHex(vec2 uvKm) {
  Hex h;
  if (gTileMix <= 0.0) {
    h.w = vec2(1.0, 0.0); h.r1 = h.r2 = mat2(1.0); h.o1 = h.o2 = vec2(0.0); h.j = vec2(1.0);
    return h;
  }
  vec2 st = uvKm * (3.4641016 * uHexFreq);
  vec2 sk = vec2(st.x, -0.57735027 * st.x + 1.15470054 * st.y);
  vec2 base = floor(sk);
  vec3 t = vec3(fract(sk), 0.0);
  t.z = 1.0 - t.x - t.y;
  float s = step(0.0, -t.z);
  float s2 = 2.0 * s - 1.0;
  vec3 w = vec3(-t.z * s2, s - t.y * s2, s - t.x * s2);
  vec2 v1 = base + vec2(s, s), v2 = base + vec2(s, 1.0 - s), v3 = base + vec2(1.0 - s, s);
  // Order the cells by weight and keep the top two.
  if (w.y > w.x) { w.xy = w.yx; vec2 tv = v1; v1 = v2; v2 = tv; }
  if (w.z > w.y) { w.yz = w.zy; vec2 tv = v2; v2 = v3; v3 = tv; }
  if (w.y > w.x) { w.xy = w.yx; vec2 tv = v1; v1 = v2; v2 = tv; }
  vec2 w7 = pow(w.xy, vec2(7.0));
  h.w = w7 / (w7.x + w7.y);
  h.r1 = hexRot(v1); h.r2 = hexRot(v2);
  h.o1 = hash22(v1); h.o2 = hash22(v2);
  h.j = 1.0 + 0.2 * gTileMix * (vec2(hash12(v1 + 17.1), hash12(v2 + 17.1)) - 0.5);
  return h;
}

// Albedo(+height). Returns per-layer blend weights (luminance-aware) that normal/ORM reuse.
vec4 triAlbedo(Hex h, vec2 uv, vec2 gx, vec2 gy, float sc, float L, out vec2 W) {
  uv *= sc; gx *= sc; gy *= sc;
  vec4 c1 = textureGrad(tAlbedo, vec3(h.r1 * uv + h.o1, L), h.r1 * gx, h.r1 * gy);
  if (gTileMix <= 0.0) { W = vec2(1.0, 0.0); return c1; }
  vec4 c2 = textureGrad(tAlbedo, vec3(h.r2 * uv + h.o2, L), h.r2 * gx, h.r2 * gy);
  W = mix(vec2(1.0), vec2(dot(c1.rgb, LUMA), dot(c2.rgb, LUMA)), 0.6) * h.w;
  W /= max(W.x + W.y, 1e-6);
  c1.rgb *= h.j.x; c2.rgb *= h.j.y;
  return c1 * W.x + c2 * W.y;
}

vec3 triOrm(Hex h, vec2 uv, vec2 gx, vec2 gy, float sc, float L, vec2 W) {
  uv *= sc; gx *= sc; gy *= sc;
  vec3 o = textureGrad(tOrm, vec3(h.r1 * uv + h.o1, L), h.r1 * gx, h.r1 * gy).rgb;
  if (gTileMix <= 0.0) return o;
  return o * W.x + textureGrad(tOrm, vec3(h.r2 * uv + h.o2, L), h.r2 * gx, h.r2 * gy).rgb * W.y;
}

// Tangent-space normal; each rotated sample's xy is rotated back into the projection frame.
vec3 triNormal(Hex h, vec2 uv, vec2 gx, vec2 gy, float sc, float L, vec2 W) {
  uv *= sc; gx *= sc; gy *= sc;
  vec3 a = textureGrad(tNormal, vec3(h.r1 * uv + h.o1, L), h.r1 * gx, h.r1 * gy).xyz * 2.0 - 1.0;
  if (gTileMix <= 0.0) return a;
  vec3 b = textureGrad(tNormal, vec3(h.r2 * uv + h.o2, L), h.r2 * gx, h.r2 * gy).xyz * 2.0 - 1.0;
  a.xy = transpose(h.r1) * a.xy;
  b.xy = transpose(h.r2) * b.xy;
  return a * W.x + b * W.y;
}

// Gradient (km per km, world space) of all procedural relief: the landform octaves that the geometry
// also carries, then fine octaves below the mesh in the style of the local materials. Analytic gradients
// stay smooth down to ~3 px per wavelength (screen-derivative bumps go blocky below ~12 px), so the
// detail reaches much farther out before it fades.
uniform float uFarWindow;       // height-blend window far away (wider = softer unit edges)
float gDetailFootprint = 0.0;   // geometric mean of the screen footprint axes (see main)

// Low-frequency context for the fine relief, set in main before detailGrad.
float gRegion = 0.0;    // ~30 km region noise (-1..1): crack fields, plate size, roughness jitter
float gFineAmp = 1.0;   // regional and slope amplitude of the fine octaves

// Fine-octave style per octave (k = 3..7). Cracked plates live only at the two coarsest fine scales and craterlets
// thin out toward the finest: one style repeated at every scale is what made the ground look like reptile skin.
// Half the weight they give up turns into billowy relief (the surface keeps some roughness), the rest is dropped:
// fine relief everywhere at full strength reads as crumpled paper.
vec4 octaveStyle(vec4 st, float crackM, float pitM) {
  float dz = st.z * (1.0 - crackM), dw = st.w * (1.0 - pitM);
  return vec4(st.x + 0.25 * dw, st.y + 0.5 * dz + 0.25 * dw, st.z - dz, st.w - dw);
}

vec3 detailGrad(vec3 d, float h, vec4 fineStyle) {
  if (uDetailAmp <= 0.0) return vec3(0.0);
  vec3 G = vec3(0.0);
  float s = uDetailScale;
  float landM = landMask(h);
  float fineM = (h < 0.0 ? 0.3 : mix(0.5, 1.4, smoothstep(300.0, 5000.0, h))) * uFineDetail * gFineAmp;
  float a = 0.4;
  // Plate size drifts between regions: some fields break into big plates, others into smaller ones.
  float rr = 0.5 + 0.5 * gRegion;
  float crackM[5] = float[5](mix(1.0, 0.4, rr), mix(0.6, 1.0, rr), 0.15, 0.0, 0.0);
  const float PIT_M[5] = float[5](1.0, 1.0, 0.7, 0.3, 0.0);
  // Three loops with constant bounds: landforms (world style), fine octaves with cells, fine octaves without.
  for (int k = 0; k < 8; k++) {
    // Mean-footprint fade (reach), plus a Nyquist fade on the long axis: at grazing angles one pixel spans
    // several wavelengths along the view, and point-sampled gradients would shimmer.
    float f = (1.0 - smoothstep(0.1, 0.28, gDetailFootprint / s)) * (1.0 - smoothstep(0.35, 0.8, gFootprint / s));
    if (f <= 0.0) break;
    vec3 g;
    if (k < 3) {
      styleOct(d * (uRadius / s) + float(k) * 7.31, uLandStyle, g);
      G += (LAND_AMP[k] * landM * f / s) * g;
    } else {
      int j = k - 3;
      vec4 st = octaveStyle(fineStyle, crackM[j], PIT_M[j]);
      // Crack troughs are ~0.16 s wide: fade them well before they shrink to a couple of pixels.
      float cf = 1.0 - smoothstep(0.035, 0.09, gDetailFootprint / s);
      st.y += st.z * (1.0 - cf);
      st.z *= cf;
      if (k < 6) styleOct(d * (uRadius / s) + float(k) * 17.3, st, g);
      else styleOctSmooth(d * (uRadius / s) + float(k) * 17.3, st, 0.05, g);
      G += (a * fineM * f / s) * g;
      a *= 0.38;
    }
    s /= DETAIL_STEP;
  }
  G -= dot(G, d) * d;   // noise is sampled on the sphere: only the tangential part is a slope
  return G * (uDetailAmp * uHeightScale);
}

// Ice glints. Sub-pixel facets used to flash as aliasing; instead each world cell of ~1.5 px holds (or not) one
// random facet that glints when it mirrors the sun. The cells are anchored to the ground and sized from the
// footprint (two power-of-two levels cross-fade), so glints twinkle with the view but never crawl.
uvec3 glintPcg(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
float glintLevel(vec3 p, float size, vec3 n, vec3 t, vec3 b, vec3 Hh) {
  vec3 h = vec3(glintPcg(uvec3(ivec3(floor(p / size))))) * (1.0 / 4294967296.0);
  if (h.z > 0.3) return 0.0;    // under a third of the cells hold a facet
  float th = 0.35 * sqrt(-2.0 * log(max(h.x, 1e-6)));   // tilt from the ground normal, ~0.35 rad spread
  float ph = 6.2831853 * h.y;
  vec3 m = n * cos(th) + (t * cos(ph) + b * sin(ph)) * sin(th);
  return smoothstep(0.9965, 0.9993, dot(m, Hh));
}
float iceGlints(vec3 p, vec3 n, vec3 Hh, float fp) {
  float fade = 1.0 - smoothstep(0.03, 0.15, fp);   // beyond ~50 m/px the glints would only be noise
  if (fade <= 0.0) return 0.0;
  vec3 t = normalize(cross(n, abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 b = cross(n, t);
  float lv = log2(fp * 1.5 * 1024.0);   // cell size in units of 2^-10 km (~1 m)
  float l0 = floor(lv), k = lv - l0;
  float s0 = exp2(l0) / 1024.0;
  float g = mix(glintLevel(p, s0, n, t, b, Hh), glintLevel(p + vec3(0.37, 0.61, 0.19) * s0, 2.0 * s0, n, t, b, Hh), k);
  return g * fade;
}

void main() {
  vec3 n = normalize(vDir);                     // sphere normal (object == world, planet is static)
  // Screen-space derivatives, taken here in uniform control flow.
  vec3 dpdx = dFdx(vWorldPos);
  vec3 dpdy = dFdy(vWorldPos);
  float fpIso = length(cameraPosition - vWorldPos) * uPixelAngle;
  float fpA = max(length(dpdx), fpIso), fpB = max(length(dpdy), fpIso);
  gFootprint = max(fpA, fpB);
  // Detail fades with the geometric mean of the footprint axes (like anisotropic filtering): at grazing
  // angles the long axis alone would erase it far too close to the camera.
  gDetailFootprint = sqrt(fpA * fpB);
  gTileMix = uAntiTile;

  vec3 tc = cubeTexCoord(n, uN);
  // Mip level from the continuous direction, not from tc: tc jumps at cube-face edges, and implicit
  // derivatives there would select the coarsest mip and draw a one-pixel seam along every edge.
  float texPerPx = max(length(dFdx(vDir)), length(dFdy(vDir))) * uN * 0.63662;  // N texels per pi/2
  float dataLod = log2(max(texPerPx, 1e-6));
  float hM = textureLod(tHeight, tc, 0.0).r;

  // --- Macro normal from the baked height gradient ---------------------------------------------------
  // Per-texel gradients filter smoothly (bilinear finite differences of heights are faceted per texel) and
  // their mips average slopes instead of aliasing from orbit. Below the datum the sea-floor scale applies.
  vec3 Gh = textureLod(tGrad, tc, dataLod).xyz * uHeightScale * mix(uSeaFloorScale, 1.0, smoothstep(-40.0, 40.0, hM));
  // Frozen sea: the mesh is flat at the datum there (elevationKm). The shoreline follows the per-pixel height (a
  // smooth curve; the mesh would give a stair of triangle edges), and the drawn height keeps the ice off ground that
  // visibly climbs. Flat macro normal, ice material, no seabed AO.
  float iceK = uSeaIce * (1.0 - smoothstep(-1.0, 3.0, hM)) * (1.0 - smoothstep(5.0, 30.0, vElevM));
  Gh *= 1.0 - iceK;
  Gh -= dot(Gh, n) * n;
  vec3 Nm = normalize(n - Gh);
  vec4 climate = textureLod(tClimate, tc, dataLod);

  // --- Splat: pick the NLAY strongest layers ---------------------------------------------------------
  vec4 s0 = textureLod(tSplat0, tc, dataLod);
  vec4 s1 = textureLod(tSplat1, tc, dataLod);
  float w[LAYERS];
  w[0] = s0.r; w[1] = s0.g; w[2] = s0.b; w[3] = s0.a;
  w[4] = s1.r; w[5] = s1.g; w[6] = s1.b; w[7] = s1.a;
  if (iceK > 0.0) for (int i = 0; i < LAYERS; i++) w[i] = mix(w[i], i == 6 ? 1.0 : 0.0, iceK);

  // Procedural relief: fine style follows the local materials (dunes on sand, cracks on ice, ...).
  vec4 fineStyle = vec4(0.0);
  for (int i = 0; i < LAYERS; i++) fineStyle += w[i] * uLayerStyle[i];
  fineStyle.w *= uFinePits;   // air and wind fill in small craters
  // Slope (km/km) of the baked relief, and low-frequency region noise for variety.
  float slope = length(Gh);
  float flatK = 1.0 - smoothstep(0.08, 0.3, slope);
  float steep = smoothstep(0.3, 0.6, slope);
  float macro = fbm3(n * 9.0) + 0.5 * fbm3(n * 37.0) * octaveFade(uRadius / 37.0 * 0.25);
  gRegion = snoise(n * (uRadius / 30.0) + 11.3);
  float region2 = 0.7 * snoise(n * (uRadius / 12.0) + 5.1) + 0.3 * snoise(n * (uRadius / 4.0) + 2.7);
  {
    // Crack plates only on flats and only in some regions; on slopes their weight turns into ridged relief
    // (fractured scarps), elsewhere into billowy.
    float cz = fineStyle.z;
    float field = 0.35 + 0.95 * smoothstep(-0.5, 0.6, gRegion + 0.3 * macro);
    fineStyle.z = cz * field * flatK;
    fineStyle.x += cz * (1.0 - flatK);
    fineStyle.y += max(cz * flatK - fineStyle.z, 0.0);
    fineStyle.x += 0.4 * steep;   // scree and gullies on steep flanks
  }
  fineStyle /= max(fineStyle.x + fineStyle.y + fineStyle.z + fineStyle.w, 1e-4);
  gFineAmp = (0.15 + 1.1 * smoothstep(-0.35, 0.45, region2)) * (1.0 + 0.4 * steep);   // smooth and rough patches
  {
    vec3 G = detailGrad(n, hM, fineStyle);
    G -= dot(G, Nm) * Nm;
    Nm = normalize(Nm - G);
  }
  Nm = normalize(mix(n, Nm, uMacroNormal));

  if (uDebug == 4) {
    vec3 c = vec3(0.0);
    for (int i = 0; i < LAYERS; i++) c += w[i] * uLayerDebugColor[i];
    gl_FragColor = vec4(c * dot(Nm, uSunDir) * 0.5 + c * 0.5, 1.0);
    return;
  }

  int idx[NLAY];
  float wt[NLAY];
  for (int k = 0; k < NLAY; k++) {
    int best = 0;
    float bw = -1.0;
    for (int i = 0; i < LAYERS; i++) if (w[i] > bw) { bw = w[i]; best = i; }
    idx[k] = best;
    wt[k] = max(bw, 0.0);
    w[best] = -1.0;
  }
  // Continuity: subtract the strongest dropped layer, so a layer enters the top 3 at zero weight instead of
  // popping in where the 3rd and 4th weights cross.
  float w4 = 0.0;
  for (int i = 0; i < LAYERS; i++) w4 = max(w4, w[i]);
  float wsum = 0.0;
  for (int k = 0; k < NLAY; k++) { wt[k] = max(wt[k] - w4, 0.0); wsum += wt[k]; }
  if (wsum < 1e-4) { wt[0] = 1.0; wsum = 1.0; }
  for (int k = 0; k < NLAY; k++) wt[k] /= wsum;

  // --- Triplanar setup (projection weights from macro normal) ------------------------------------
  vec3 bw = pow(abs(Nm), vec3(uTriSharp));
  bw /= (bw.x + bw.y + bw.z);
  vec3 axisSign = sign(Nm);
  vec3 p = vWorldPos;   // km
  vec2 uvX = vec2(p.z * axisSign.x, p.y);
  vec2 uvY = vec2(p.x * axisSign.y, p.z);
  vec2 uvZ = vec2(-p.x * axisSign.z, p.y);
  vec2 gXx = vec2(dpdx.z * axisSign.x, dpdx.y), gXy = vec2(dpdy.z * axisSign.x, dpdy.y);
  vec2 gYx = vec2(dpdx.x * axisSign.y, dpdx.z), gYy = vec2(dpdy.x * axisSign.y, dpdy.z);
  vec2 gZx = vec2(-dpdx.x * axisSign.z, dpdx.y), gZy = vec2(-dpdy.x * axisSign.z, dpdy.y);

  Hex hX, hY, hZ;
  if (bw.x > 0.02) hX = makeHex(uvX);
  if (bw.y > 0.02) hY = makeHex(uvY);
  if (bw.z > 0.02) hZ = makeHex(uvZ);

  // Per layer albedo+height (needed first for height blending).
  vec4 ah[NLAY];
  vec2 hwX[NLAY], hwY[NLAY], hwZ[NLAY];   // hex blend weights per layer & projection, reused by normal/ORM
  for (int k = 0; k < NLAY; k++) {
    ah[k] = vec4(0.0);
    hwX[k] = hwY[k] = hwZ[k] = vec2(1.0, 0.0);
    if (wt[k] < 0.004) continue;
    float L = float(idx[k]);
    float sc = uLayerScale[idx[k]];
    if (bw.x > 0.02) ah[k] += bw.x * triAlbedo(hX, uvX, gXx, gXy, sc, L, hwX[k]);
    if (bw.y > 0.02) ah[k] += bw.y * triAlbedo(hY, uvY, gYx, gYy, sc, L, hwY[k]);
    if (bw.z > 0.02) ah[k] += bw.z * triAlbedo(hZ, uvZ, gZx, gZy, sc, L, hwZ[k]);
  }

  // Height-based blend.
  float hb[NLAY];
  float mx = -1e3;
  for (int k = 0; k < NLAY; k++) {
    hb[k] = wt[k] < 0.004 ? -1e3 : wt[k] + ah[k].a * uHeightBlend;
    mx = max(mx, hb[k]);
  }
  // Once a pixel covers a good part of a tile the mips flatten the texture heights, and a narrow window would just
  // sharpen splat edges into hard spots. Widen it with distance: edges soften, but the dominant unit still wins,
  // so dark lava flows stay dark instead of averaging to grey with the plains around them.
  float farBlend = smoothstep(0.08, 0.5, gFootprint * uHexFreq / 0.55);
  float win = mix(0.25, uFarWindow, farBlend);
  float bsum = 0.0;
  for (int k = 0; k < NLAY; k++) { hb[k] = max(hb[k] - mx + win, 0.0) * step(0.004, wt[k]); bsum += hb[k]; }
  for (int k = 0; k < NLAY; k++) hb[k] /= max(bsum, 1e-4);

  vec3 albedo = vec3(0.0);
  vec3 orm = vec3(0.0);
  vec3 tnX = vec3(0.0), tnY = vec3(0.0), tnZ = vec3(0.0);
  for (int k = 0; k < NLAY; k++) {
    if (hb[k] < 0.004) continue;
    float L = float(idx[k]);
    float sc = uLayerScale[idx[k]];
    albedo += hb[k] * ah[k].rgb * uLayerTint[idx[k]];
    if (bw.x > 0.02) {
      vec3 tx = triNormal(hX, uvX, gXx, gXy, sc, L, hwX[k]);
      tx.xy *= uLayerNormal[idx[k]];
      tnX += hb[k] * tx;
      orm += hb[k] * bw.x * triOrm(hX, uvX, gXx, gXy, sc, L, hwX[k]);
    }
    if (bw.y > 0.02) {
      vec3 ty = triNormal(hY, uvY, gYx, gYy, sc, L, hwY[k]);
      ty.xy *= uLayerNormal[idx[k]];
      tnY += hb[k] * ty;
      orm += hb[k] * bw.y * triOrm(hY, uvY, gYx, gYy, sc, L, hwY[k]);
    }
    if (bw.z > 0.02) {
      vec3 tz = triNormal(hZ, uvZ, gZx, gZy, sc, L, hwZ[k]);
      tz.xy *= uLayerNormal[idx[k]];
      tnZ += hb[k] * tz;
      orm += hb[k] * bw.z * triOrm(hZ, uvZ, gZx, gZy, sc, L, hwZ[k]);
    }
  }
  // Fade detail normals with distance (they alias into sparkle from orbit).
  float camDist = length(cameraPosition - vWorldPos);
  float detailFade = uNormalStrength * (1.0 - smoothstep(60.0, 900.0, camDist));
  tnX.xy *= detailFade; tnY.xy *= detailFade; tnZ.xy *= detailFade;
  tnX.x *= axisSign.x; tnY.x *= axisSign.y; tnZ.x *= -axisSign.z;
  // Whiteout blend (Ben Golus).
  tnX = vec3(tnX.xy + Nm.zy, abs(tnX.z) * Nm.x);
  tnY = vec3(tnY.xy + Nm.xz, abs(tnY.z) * Nm.y);
  tnZ = vec3(tnZ.xy + Nm.xy, abs(tnZ.z) * Nm.z);
  vec3 N = normalize(tnX.zyx * bw.x + tnY.xzy * bw.y + tnZ.xyz * bw.z);
  vec3 dNx = dFdx(N), dNy = dFdy(N);
  float kernelA2 = min(0.3 * (dot(dNx, dNx) + dot(dNy, dNy)), 0.1);

  float ao = mix(1.0, orm.r, 0.8);
  float terrAO = mix(1.0, textureLod(tAO, tc, dataLod).r, uTerrainAO * (1.0 - iceK));
  // Dry rock and dust are very rough; ice (6) and salt (7) keep their texture roughness.
  float glossy = 0.0;
  for (int k = 0; k < NLAY; k++) if (idx[k] >= 6) glossy += hb[k];
  // Ice and salt keep their gloss, but never a mirror under a 6x sun; far away the unresolved relief roughens them a
  // little. Sparkle is the specular AA's job below: a high floor here only dulled the sheen.
  float rough = clamp(mix(mix(uRoughMin, 1.0, orm.g), max(orm.g, 0.22), glossy), 0.05, 1.0);
  rough = min(rough + 0.15 * glossy * smoothstep(0.1, 0.6, gFootprint * uHexFreq), 1.0);
  rough = clamp(rough + 0.08 * gRegion * uWeathering, 0.05, 1.0);
  // Specular anti-aliasing (Tokuyoshi & Kaplanyan): normal variance across the pixel widens the lobe, so
  // sub-pixel bumps stop flashing as sparkles. alpha^2 = rough^4 in brdf().
  float a2 = rough * rough * rough * rough;
  rough = pow(min(a2 + kernelA2, 1.0), 0.25);
  float metal = orm.b;

  // --- Macro variation ------------------------------------------------------------------------------
  albedo *= 1.0 + uMacroVar * macro;
  albedo *= mix(vec3(1.0), vec3(0.92, 0.98, 1.06), iceK);   // sea ice: a touch bluer than land ice
  // Weathering: fine dust settles in hollows and on flats, slopes shed it (fresher, brighter scree);
  // a slow regional drift in brightness, and in hue on ice. Ice and salt hollows collect frost, not grey regolith.
  float settle = smoothstep(0.85, 0.6, textureLod(tAO, tc, dataLod).r) * flatK * uWeathering * (1.0 - iceK);
  vec3 frost = mix(vec3(dot(albedo, vec3(0.2126, 0.7152, 0.0722))), albedo, 0.6) * 1.12;
  albedo = mix(albedo, mix(uLayerTint[0] * uLayerMean[0], frost, glossy), 0.5 * settle);
  rough = mix(rough, mix(1.0, 0.45, glossy), settle * mix(1.0, 0.4, glossy));
  albedo *= 1.0 + uWeathering * (0.12 * steep + 0.06 * gRegion);
  albedo *= mix(vec3(1.0), vec3(1.0 - 0.03 * gRegion, 1.0, 1.0 + 0.04 * gRegion), glossy * uWeathering);
  float temp = climate.r, moist = climate.g, flow = climate.b;

  // --- Volatile wetness & erosion channels ------------------------------------------------------------
  float land = smoothstep(-5.0, 20.0, hM);
  float wet = moist * uWetness * land;
  albedo *= mix(1.0, 0.65, wet);
  rough = mix(rough, 0.4, wet * 0.5);
  float chan = smoothstep(0.45, 0.85, flow) * uChannels * land;
  albedo *= mix(1.0, 0.6, chan);   // darker sediment on channel floors

  // --- Lighting ----------------------------------------------------------------------------------------
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 Lsun = uSunDir;
  vec3 sunCol = sunLightAt(vWorldPos);
  // Keep normal-mapped light from leaking past the terminator.
  float horizon = smoothstep(-0.02, 0.06, dot(n, Lsun));
  float shadow = dot(n, Lsun) > -0.05 ? terrainShadow(n, Lsun) : 0.0;
  // Micro-shadowing from the texture AO (cheap stand-in for self-shadowing of the small relief).
  float NoL = dot(N, Lsun);
  float micro = clamp(abs(NoL) + 2.0 * ao * ao - 1.0, 0.0, 1.0);
  // Cavity: occluded spots also catch less direct light (sun from a narrower aperture).
  float cavity = mix(1.0, terrAO, 0.45);
  // Ice and salt: half the smooth lobe. Under a 6x sun at grazing angles it blew out to plain white; the glints
  // below carry the sparkle.
  vec3 col = brdfS(albedo, rough, metal, N, V, Lsun, uSpecular * mix(1.0, 0.5, glossy)) * sunCol * horizon * shadow * micro * cavity;
  if (glossy > 0.02) {
    float gl = iceGlints(vWorldPos, n, normalize(V + Lsun), fpIso) * glossy * (1.0 - 0.6 * settle);
    col += sunCol * horizon * shadow * cavity * gl * uSpecular * 5.0;
  }
  float dayAmb = smoothstep(-0.25, 0.3, dot(n, Lsun));
  col += albedo * ao * terrAO * (uSkyAmbient * dayAmb + vec3(uAmbient)) * (0.6 + 0.4 * dot(N, n));
  // Planetshine: the giant's disc lights the night side softly (wrapped Lambert, no shadows).
  float fillW = clamp(dot(N, uFillDir) * 0.6 + 0.4, 0.0, 1.0) * clamp(dot(n, uFillDir) * 0.5 + 0.6, 0.0, 1.0);
  col += albedo * ao * terrAO * uFillColor * fillW / PI;

  // --- Molten ground: lava lakes above the lava-sea level (the generator saturates their temperature) ---
  if (uLavaGlow > 0.0) {
    float molten = smoothstep(0.93, 0.99, temp);
    vec3 q = n * 220.0;
    float cracks = pow(1.0 - abs(snoise(q + 3.0 * fbm3(q * 0.15 + vec3(uTime * 0.004)))), 8.0);
    // Crack cells are ~R/220 km: fade to their average glow once they get near pixel size (no sparkle).
    cracks = mix(0.12, cracks, 1.0 - smoothstep(0.08, 0.3, gFootprint / (uRadius / 220.0)));
    float heat = clamp(cracks * 1.3 + 0.3, 0.0, 1.5);
    col = mix(col, vec3(0.035, 0.03, 0.03) * col / max(albedo, vec3(0.02)), molten * 0.7);
    col += uLavaColor * uLavaGlow * heat * heat * molten;
  }

  // --- Debug views ---------------------------------------------------------------------------------
  if (uDebug == 1) col = albedo;
  else if (uDebug == 2) col = N * 0.5 + 0.5;
  else if (uDebug == 3) col = heightRamp(hM) * (0.35 + 0.65 * max(dot(Nm, Lsun), 0.0));
  else if (uDebug == 5) col = uUnitColors[int(climate.a * 255.0 + 0.5) % 32] * (0.4 + 0.6 * max(dot(Nm, Lsun), 0.0));
  else if (uDebug == 6) col = tempRamp(temp);
  else if (uDebug == 7) col = mix(vec3(0.8, 0.6, 0.3), vec3(0.1, 0.3, 0.9), moist);
  else if (uDebug == 8) col = vec3(flow * flow, flow, sqrt(flow));
  else if (uDebug == 9) {
    vec3 stf = dirToFace(n);
    vec3 faceCol[6] = vec3[6](vec3(1, .3, .3), vec3(.5, 0, 0), vec3(.3, 1, .3), vec3(0, .5, 0), vec3(.3, .3, 1), vec3(0, 0, .5));
    vec2 g = abs(fract(stf.xy * 8.0) - 0.5);
    col = faceCol[int(stf.z)] * (0.6 + 0.4 * step(0.45, max(g.x, g.y)));
  }
  else if (uDebug == 10) col = vec3(ao * terrAO * shadow);
  else if (uDebug == 11) {
    // HQ levels: grey = coarse mesh, then a hue per ring level.
    float lv = uHQLevel;
    vec3 tint = lv < 0.5 ? vec3(0.5) : 0.55 + 0.45 * cos(6.2831853 * (lv * 0.17 + vec3(0.0, 0.33, 0.67)));
    col = tint * (0.25 + 0.75 * max(dot(N, Lsun), 0.0));
  }
  gl_FragColor = vec4(col, 1.0);
}
