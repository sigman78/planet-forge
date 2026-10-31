// Terrain height function shared by the terrain vertex and fragment shaders.
// Baked heightmap + procedural detail relief (what a CDLOD engine adds below the baked resolution).
uniform sampler2DArray tHeight;
uniform float uN;
uniform float uRadius;        // km
uniform float uHeightScale;   // km per metre of elevation, includes exaggeration
uniform float uSeaFloorScale; // extra multiplier for below-sea elevations
uniform float uSeaIce;        // 1 = frozen sea: the ground is clamped flat at the datum (no separate shell)
uniform float uDetailAmp;     // metres
uniform float uDetailScale;   // km of the largest detail feature
uniform float uPixelAngle;    // radians covered by one screen pixel (vertical fov / viewport height)

// Ground size (km) that the current sample must resolve. Set by the caller before using
// terrainHeightM / surfPos; detail octaves smaller than ~2 of these are faded out (no aliasing).
float gFootprint = 0.0;

float bakedHeightM(vec3 d) {
  return textureLod(tHeight, cubeTexCoord(d, uN), 0.0).r;
}

// Fade for a noise octave with feature size `s` km given the current footprint.
float octaveFade(float s) {
  return 1.0 - smoothstep(0.25, 0.6, gFootprint / s);
}

// ---- Procedural relief below the heightmap ---------------------------------------------------------------
// One spectrum of octaves, scale s_k = uDetailScale / 2.15^k. Octaves 0-2 ("landforms") displace the
// geometry and use the world's style; octaves 3+ only bend the normal and follow the surface material.
// Every octave is one of four styles, blended by weight (x ridged, y billowy, z cracked, w pitted):
//   ridged  - sharp crests and gullies (wind-carved rock, dune trains)
//   billowy - rounded lumps (lava lobes, hummocky ejecta)
//   cracked - narrow troughs along a cell network (ice plates, cooling cracks, salt polygons)
//   pitted  - bowl craters with raised rims (regolith on airless bodies)
uniform vec4 uLandStyle;
uniform float uUseCells;   // 1 when any style weight uses the cellular terms (cracked/pitted)

const float DETAIL_STEP = 2.15;

// One detail octave without the cellular styles (ridged + billowy only). The finest octaves use this directly, so
// the compiler drops their Worley evaluations (a uniform branch alone would not: D3D flattens it).
// `soft` rounds the |n| crease: billowy relief with sharp creases at every scale reads as crumpled paper.
float styleOctSmooth(vec3 q, vec4 st, float soft, out vec3 g) {
  vec3 gn;
  float n = snoiseGrad(q, gn);
  float sa = sqrt(n * n + soft);                  // smooth |n|
  vec3 gsa = (n / sa) * gn;
  float r = 1.0 - sa;
  g = (st.x * -2.0 * r + st.y * 0.8) * gsa;
  return st.x * (r * r - 0.45) + st.y * 0.8 * (sa - 0.35);
}

// One detail octave at noise-space point q. Returns the value (about -0.6..0.5) and its gradient in q.
float styleOct(vec3 q, vec4 st, out vec3 g) {
  float v = styleOctSmooth(q, st, 0.004, g);
  if (uUseCells > 0.5) {
    const float CS = 0.8;                         // cells per noise unit
    float F1, F2, rnd;
    vec3 d1, d2;
    cellular2(q * CS + 31.7, F1, F2, d1, d2, rnd);
    vec3 gF1 = -d1 / max(F1, 1e-4), gF2 = -d2 / max(F2, 1e-4);
    // Cracks: troughs where the two nearest cells meet. Smoothstep profile, so the slope is zero at the trough
    // edge (a hard-edged profile draws every plate outline as a crisp polygon), and scaled down to read at the
    // same strength as the other styles for the same weight.
    const float W = 0.13;
    const float CK = 0.6;
    float u = clamp(1.0 - (F2 - F1) / W, 0.0, 1.0);
    float t = u * u * (3.0 - 2.0 * u);
    float vc = CK * (0.12 - 0.5 * t);
    vec3 gc = (CK * 3.0 * u * (1.0 - u) / W) * (gF2 - gF1);
    // Pits: about half the cells hold a crater of random size (power-law-ish); bowl inside, rim outside.
    float r2 = fract(rnd * 7.137 + 0.31);
    float has = smoothstep(0.35, 0.5, r2);
    float rc = 0.12 + 0.36 * rnd * rnd;
    float x = F1 / rc;
    float ex = exp(-4.0 * max(x - 1.0, 0.0));
    float inside = step(x, 1.0);
    float vp = mix(0.3 * ex, 0.3 + 0.9 * (x * x - 1.0), inside) - 0.05;
    float dp = mix(-1.2 * ex, 1.8 * x, inside);
    // A crater reaching its cell's edge stopped dead there (the next cell has its own crater or none), a cliff
    // the mesh vertices popped over as they slid in the morph bands; fade it out toward the edge instead.
    float edge = clamp((F2 - F1) / 0.2, 0.0, 1.0);
    float win = edge * edge * (3.0 - 2.0 * edge);
    vec3 gwin = (6.0 * edge * (1.0 - edge) / 0.2) * (gF2 - gF1);
    vec3 gp = (has * win * dp / rc) * gF1 + (has * vp) * gwin;
    vp *= has * win;
    v += st.z * vc + st.w * vp;
    g += CS * (st.z * gc + st.w * gp);
  }
  return v;
}

const float LAND_AMP[3] = float[3](0.55, 0.3, 0.15);

// Regional fields for the fine relief, sampled on the sphere direction. Each octave lives on its own rotated
// domain: the zero-planes of a simplex lattice are straight, and one octave pushed through a narrow threshold drew
// them as hard-edged rough/smooth squares, lined up with the world axes (so parallel to the cube-face edges).
const mat3 RGN_ROT_A = mat3(0.6359, 0.7230, -0.2700, -0.5784, 0.6781, 0.4535, 0.5109, -0.1322, 0.8494);
const mat3 RGN_ROT_B = mat3(0.5936, 0.1509, 0.7905, -0.8011, 0.0175, 0.5983, 0.0765, -0.9884, 0.1312);
// ~30 km field (-1..1): crack fields, plate size, roughness and tint jitter.
float regionField(vec3 d) {
  return snoise(RGN_ROT_A * d * (uRadius / 30.0) + 11.3);
}
// ~12 km + 4 km field (-1..1): where the fine octaves are rough and where they are smooth.
float roughnessField(vec3 d) {
  return 0.6 * snoise(RGN_ROT_A * d * (uRadius / 12.0) + 5.1) + 0.4 * snoise(RGN_ROT_B * d * (uRadius / 4.0) + 2.7);
}
// Fine-octave amplitude from the roughness field: a wide band (no hard break at the lattice zero-planes), about
// 4:1 between the smoothest and the roughest patches, and more on steep ground.
float fineAmpOf(float rough, float steep) {
  return (0.3 + 0.95 * smoothstep(-0.6, 0.6, rough)) * (1.0 + 0.4 * steep);
}

float landMask(float h) {
  // Sharper in mountains, gentle on plains, faint on the seabed; fade near the coast so the detail
  // does not create spurious islands or lakes.
  float m = h < 0.0 ? 0.25 : mix(0.35, 1.6, smoothstep(300.0, 5000.0, h));
  return m * smoothstep(0.0, 120.0, abs(h));
}

// Landform octaves as geometry (metres), faded by the current footprint.
float detailM(vec3 d, float h) {
  if (uDetailAmp <= 0.0) return 0.0;
  float sum = 0.0;
  float s = uDetailScale;
  for (int k = 0; k < 3; k++) {
    float f = octaveFade(s);
    if (f <= 0.0) break;   // landforms finer than the mesh live in the fragment normal only
    vec3 g;
    sum += LAND_AMP[k] * f * styleOct(d * (uRadius / s) + float(k) * 7.31, uLandStyle, g);
    s /= DETAIL_STEP;
  }
  return sum * uDetailAmp * landMask(h);
}

float terrainHeightM(vec3 d) {
  float h = bakedHeightM(d);
  return h + detailM(d, h);
}

float elevationKm(float hM) {
  // Frozen seas are part of the terrain: one surface for the mesh, rocks, shadows and the camera.
  if (uSeaIce > 0.5) hM = max(hM, 0.0);
  return (hM < 0.0 ? hM * uSeaFloorScale : hM) * uHeightScale;
}

vec3 surfPosBaked(vec3 d) {
  return d * (uRadius + elevationKm(bakedHeightM(d)));
}

vec3 surfPos(vec3 d) {
  return d * (uRadius + elevationKm(terrainHeightM(d)));
}
