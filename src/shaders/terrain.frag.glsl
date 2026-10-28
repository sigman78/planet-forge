// Terrain: splat-blended triplanar PBR on a displaced cube-sphere.
#define PI 3.14159265359
#define LAYERS 8

uniform sampler2DArray tSplat0;
uniform sampler2DArray tSplat1;
uniform sampler2DArray tClimate;
uniform sampler2DArray tAlbedo;   // sRGB albedo, a = height
uniform sampler2DArray tNormal;   // GL normal
uniform sampler2DArray tOrm;      // ao, roughness, metal
uniform float uLayerScale[LAYERS];   // tiles per km
uniform vec3  uLayerTint[LAYERS];
uniform float uNormalStrength;
uniform float uMacroNormal;          // strength of the heightmap-derived normal
uniform float uHeightBlend;          // contrast of height-based blending
uniform float uTriSharp;
uniform float uMacroVar;             // macro albedo variation
uniform float uWetness;
uniform float uChannels;
uniform float uAmbient;
uniform vec3  uSkyAmbient;
uniform float uTime;
uniform int   uDebug;
uniform vec3  uLayerDebugColor[LAYERS];
uniform vec3  uUnitColors[32];

varying vec3 vDir;
varying vec3 vWorldPos;


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

// GGX / Smith / Schlick.
vec3 brdf(vec3 albedo, float rough, float metal, vec3 N, vec3 V, vec3 L) {
  vec3 H = normalize(V + L);
  float NdL = max(dot(N, L), 0.0);
  float NdV = max(dot(N, V), 1e-4);
  float NdH = max(dot(N, H), 0.0);
  float VdH = max(dot(V, H), 0.0);
  float a = rough * rough;
  float a2 = a * a;
  float dd = NdH * NdH * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * dd * dd);
  float k = (rough + 1.0) * (rough + 1.0) / 8.0;
  float G = (NdL / (NdL * (1.0 - k) + k)) * (NdV / (NdV * (1.0 - k) + k));
  vec3 F0 = mix(vec3(0.04), albedo, metal);
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - VdH, 5.0);
  vec3 spec = D * G * F / (4.0 * NdL * NdV + 1e-4);
  vec3 kd = (1.0 - F) * (1.0 - metal);
  return (kd * albedo / PI + spec) * NdL;
}

uniform float uAntiTile;   // 0 = plain tiling, >0 = hex-tiling (random offset+rotation per hex cell)

// ---- Hex-tiling (Mikkelsen 2022, "Practical Real-Time Hex-Tiling") ---------------------------------
// The texture plane is covered by a hexagonal grid; each cell samples the texture with a random offset and
// rotation, and the 3 nearest cells blend with luminance-aware weights. Removes visible tile repetition.
const float HEX_FREQ = 0.55;      // hex cells per texture tile
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
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
void hexGrid(vec2 st, out vec3 w, out vec2 v1, out vec2 v2, out vec2 v3) {
  st *= 3.4641016 * HEX_FREQ;
  vec2 sk = vec2(st.x, -0.57735027 * st.x + 1.15470054 * st.y);
  vec2 base = floor(sk);
  vec3 t = vec3(fract(sk), 0.0);
  t.z = 1.0 - t.x - t.y;
  float s = step(0.0, -t.z);
  float s2 = 2.0 * s - 1.0;
  w = vec3(-t.z * s2, s - t.y * s2, s - t.x * s2);
  v1 = base + vec2(s, s);
  v2 = base + vec2(s, 1.0 - s);
  v3 = base + vec2(1.0 - s, s);
}
mat2 hexRot(vec2 v) {
  float a = hash12(v) * 6.2831853;
  float c = cos(a), sn = sin(a);
  return mat2(c, sn, -sn, c);
}

// Albedo(+height) lookup. Returns the blend weights so normal/ORM lookups reuse them (consistent cells).
vec4 triAlbedo(vec2 uv, vec2 gx, vec2 gy, float sc, float L, out vec3 W) {
  uv *= sc; gx *= sc; gy *= sc;
  if (gTileMix <= 0.0) { W = vec3(1.0, 0.0, 0.0); return textureGrad(tAlbedo, vec3(uv, L), gx, gy); }
  vec3 w; vec2 v1, v2, v3;
  hexGrid(uv, w, v1, v2, v3);
  mat2 r1 = hexRot(v1), r2 = hexRot(v2), r3 = hexRot(v3);
  vec4 c1 = textureGrad(tAlbedo, vec3(r1 * uv + hash22(v1), L), r1 * gx, r1 * gy);
  vec4 c2 = textureGrad(tAlbedo, vec3(r2 * uv + hash22(v2), L), r2 * gx, r2 * gy);
  vec4 c3 = textureGrad(tAlbedo, vec3(r3 * uv + hash22(v3), L), r3 * gx, r3 * gy);
  vec3 lw = mix(vec3(1.0), vec3(dot(c1.rgb, LUMA), dot(c2.rgb, LUMA), dot(c3.rgb, LUMA)), 0.6);
  W = lw * pow(w, vec3(7.0));
  W /= max(W.x + W.y + W.z, 1e-6);
  return c1 * W.x + c2 * W.y + c3 * W.z;
}

vec3 triOrm(vec2 uv, vec2 gx, vec2 gy, float sc, float L, vec3 W) {
  uv *= sc; gx *= sc; gy *= sc;
  if (gTileMix <= 0.0) return textureGrad(tOrm, vec3(uv, L), gx, gy).rgb;
  vec3 w; vec2 v1, v2, v3;
  hexGrid(uv, w, v1, v2, v3);
  mat2 r1 = hexRot(v1), r2 = hexRot(v2), r3 = hexRot(v3);
  return textureGrad(tOrm, vec3(r1 * uv + hash22(v1), L), r1 * gx, r1 * gy).rgb * W.x
       + textureGrad(tOrm, vec3(r2 * uv + hash22(v2), L), r2 * gx, r2 * gy).rgb * W.y
       + textureGrad(tOrm, vec3(r3 * uv + hash22(v3), L), r3 * gx, r3 * gy).rgb * W.z;
}

// Tangent-space normal; each rotated sample's xy is rotated back into the projection frame.
vec3 triNormal(vec2 uv, vec2 gx, vec2 gy, float sc, float L, vec3 W) {
  uv *= sc; gx *= sc; gy *= sc;
  if (gTileMix <= 0.0) return textureGrad(tNormal, vec3(uv, L), gx, gy).xyz * 2.0 - 1.0;
  vec3 w; vec2 v1, v2, v3;
  hexGrid(uv, w, v1, v2, v3);
  mat2 r1 = hexRot(v1), r2 = hexRot(v2), r3 = hexRot(v3);
  vec3 n1 = textureGrad(tNormal, vec3(r1 * uv + hash22(v1), L), r1 * gx, r1 * gy).xyz * 2.0 - 1.0;
  vec3 n2 = textureGrad(tNormal, vec3(r2 * uv + hash22(v2), L), r2 * gx, r2 * gy).xyz * 2.0 - 1.0;
  vec3 n3 = textureGrad(tNormal, vec3(r3 * uv + hash22(v3), L), r3 * gx, r3 * gy).xyz * 2.0 - 1.0;
  n1.xy = transpose(r1) * n1.xy;
  n2.xy = transpose(r2) * n2.xy;
  n3.xy = transpose(r3) * n3.xy;
  return n1 * W.x + n2 * W.y + n3 * W.z;
}

void main() {
  vec3 n = normalize(vDir);                     // sphere normal (object == world, planet is static)
  // Screen-space derivatives, taken here in uniform control flow.
  vec3 dpdx = dFdx(vWorldPos);
  vec3 dpdy = dFdy(vWorldPos);
  gFootprint = max(max(length(dpdx), length(dpdy)), length(cameraPosition - vWorldPos) * uPixelAngle);
  gTileMix = uAntiTile;

  // --- Macro normal from the height texture -----------------------------------------------------
  vec3 up = abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t1 = normalize(cross(up, n));
  vec3 t2 = cross(n, t1);
  // Finite-difference step: one heightmap texel, or the pixel footprint when that is larger (avoids aliasing).
  float e = max(1.5707963 / uN * 0.75, gFootprint / uRadius);
  vec3 dx = surfPos(normalize(n + t1 * e)) - surfPos(normalize(n - t1 * e));
  vec3 dy = surfPos(normalize(n + t2 * e)) - surfPos(normalize(n - t2 * e));
  vec3 Nm = normalize(cross(dx, dy));
  Nm = normalize(mix(n, Nm, uMacroNormal));

  vec3 tc = cubeTexCoord(n, uN);
  float hM = texture(tHeight, tc).r;
  vec4 climate = texture(tClimate, tc);

  // --- Splat: pick the 4 strongest layers ---------------------------------------------------------
  vec4 s0 = texture(tSplat0, tc);
  vec4 s1 = texture(tSplat1, tc);
  float w[LAYERS];
  w[0] = s0.r; w[1] = s0.g; w[2] = s0.b; w[3] = s0.a;
  w[4] = s1.r; w[5] = s1.g; w[6] = s1.b; w[7] = s1.a;

  if (uDebug == 4) {
    vec3 c = vec3(0.0);
    for (int i = 0; i < LAYERS; i++) c += w[i] * uLayerDebugColor[i];
    gl_FragColor = vec4(c * dot(Nm, uSunDir) * 0.5 + c * 0.5, 1.0);
    return;
  }

  int idx[4];
  float wt[4];
  float wsum = 0.0;
  for (int k = 0; k < 4; k++) {
    int best = 0;
    float bw = -1.0;
    for (int i = 0; i < LAYERS; i++) if (w[i] > bw) { bw = w[i]; best = i; }
    idx[k] = best;
    wt[k] = max(bw, 0.0);
    wsum += wt[k];
    w[best] = -1.0;
  }
  for (int k = 0; k < 4; k++) wt[k] /= max(wsum, 1e-4);

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

  // Per layer albedo+height (needed first for height blending).
  vec4 ah[4];
  vec3 hwX[4], hwY[4], hwZ[4];   // hex blend weights per layer & projection, reused by normal/ORM
  for (int k = 0; k < 4; k++) {
    ah[k] = vec4(0.0);
    hwX[k] = hwY[k] = hwZ[k] = vec3(1.0, 0.0, 0.0);
    if (wt[k] < 0.004) continue;
    float L = float(idx[k]);
    float sc = uLayerScale[idx[k]];
    if (bw.x > 0.02) ah[k] += bw.x * triAlbedo(uvX, gXx, gXy, sc, L, hwX[k]);
    if (bw.y > 0.02) ah[k] += bw.y * triAlbedo(uvY, gYx, gYy, sc, L, hwY[k]);
    if (bw.z > 0.02) ah[k] += bw.z * triAlbedo(uvZ, gZx, gZy, sc, L, hwZ[k]);
  }

  // Height-based blend.
  float hb[4];
  float mx = -1e3;
  for (int k = 0; k < 4; k++) {
    hb[k] = wt[k] < 0.004 ? -1e3 : wt[k] + ah[k].a * uHeightBlend;
    mx = max(mx, hb[k]);
  }
  float bsum = 0.0;
  for (int k = 0; k < 4; k++) { hb[k] = max(hb[k] - mx + 0.25, 0.0) * step(0.004, wt[k]); bsum += hb[k]; }
  for (int k = 0; k < 4; k++) hb[k] /= max(bsum, 1e-4);

  vec3 albedo = vec3(0.0);
  vec3 orm = vec3(0.0);
  vec3 tnX = vec3(0.0), tnY = vec3(0.0), tnZ = vec3(0.0);
  for (int k = 0; k < 4; k++) {
    if (hb[k] < 0.004) continue;
    float L = float(idx[k]);
    float sc = uLayerScale[idx[k]];
    albedo += hb[k] * ah[k].rgb * uLayerTint[idx[k]];
    if (bw.x > 0.02) {
      tnX += hb[k] * triNormal(uvX, gXx, gXy, sc, L, hwX[k]);
      orm += hb[k] * bw.x * triOrm(uvX, gXx, gXy, sc, L, hwX[k]);
    }
    if (bw.y > 0.02) {
      tnY += hb[k] * triNormal(uvY, gYx, gYy, sc, L, hwY[k]);
      orm += hb[k] * bw.y * triOrm(uvY, gYx, gYy, sc, L, hwY[k]);
    }
    if (bw.z > 0.02) {
      tnZ += hb[k] * triNormal(uvZ, gZx, gZy, sc, L, hwZ[k]);
      orm += hb[k] * bw.z * triOrm(uvZ, gZx, gZy, sc, L, hwZ[k]);
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

  float ao = mix(1.0, orm.r, 0.8);
  float rough = clamp(orm.g, 0.05, 1.0);
  float metal = orm.b;

  // --- Macro variation ------------------------------------------------------------------------------
  float macro = fbm3(n * 9.0) + 0.5 * fbm3(n * 37.0) * octaveFade(uRadius / 37.0 * 0.25);
  albedo *= 1.0 + uMacroVar * macro;
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
  vec3 col = brdf(albedo, rough, metal, N, V, Lsun) * sunCol * horizon;
  float dayAmb = smoothstep(-0.25, 0.3, dot(n, Lsun));
  col += albedo * ao * (uSkyAmbient * dayAmb + vec3(uAmbient)) * (0.6 + 0.4 * dot(N, n));

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
  else if (uDebug == 10) col = vec3(ao * rough, ao, rough);
  gl_FragColor = vec4(col, 1.0);
}
