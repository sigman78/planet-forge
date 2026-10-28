// Terrain height function shared by the terrain vertex and fragment shaders.
// Baked heightmap + procedural detail relief (what a CDLOD engine adds below the baked resolution).
uniform sampler2DArray tHeight;
uniform float uN;
uniform float uRadius;        // km
uniform float uHeightScale;   // km per metre of elevation, includes exaggeration
uniform float uSeaFloorScale; // extra multiplier for below-sea elevations
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

float detailM(vec3 d, float h) {
  if (uDetailAmp <= 0.0) return 0.0;
  float s0 = uDetailScale, s1 = uDetailScale / 2.13, s2 = uDetailScale / 4.37;
  float f0 = octaveFade(s0), f1 = octaveFade(s1), f2 = octaveFade(s2);
  if (f0 <= 0.0) return 0.0;
  vec3 p = d * (uRadius / uDetailScale);
  // Ridged-ish detail: sharper in mountains, gentle on plains, faint on the seabed.
  float r = 1.0 - abs(snoise(p));
  float n = 0.55 * (r * r - 0.45) * f0;
  if (f1 > 0.0) n += 0.3 * snoise(p * 2.13 + 7.1) * f1;
  if (f2 > 0.0) n += 0.15 * snoise(p * 4.37 + 1.3) * f2;
  float mask = h < 0.0 ? 0.25 : mix(0.35, 1.6, smoothstep(300.0, 5000.0, h));
  // Fade near the coast so detail does not create spurious islands or lakes.
  mask *= smoothstep(0.0, 120.0, abs(h));
  return n * uDetailAmp * mask;
}

float terrainHeightM(vec3 d) {
  float h = bakedHeightM(d);
  return h + detailM(d, h);
}

float elevationKm(float hM) {
  return (hM < 0.0 ? hM * uSeaFloorScale : hM) * uHeightScale;
}

vec3 surfPos(vec3 d) {
  return d * (uRadius + elevationKm(terrainHeightM(d)));
}
