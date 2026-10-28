// Terrain: splat-blended triplanar PBR on a displaced cube-sphere.
#define PI 3.14159265359
#define LAYERS 8

uniform sampler2DArray tHeight;
uniform sampler2DArray tSplat0;
uniform sampler2DArray tSplat1;
uniform sampler2DArray tClimate;
uniform sampler2DArray tClouds;
uniform sampler2DArray tAlbedo;   // sRGB albedo, a = height
uniform sampler2DArray tNormal;   // GL normal
uniform sampler2DArray tOrm;      // ao, roughness, metal
uniform float uN;
uniform float uCloudN;
uniform float uRadius;
uniform float uHeightScale;
uniform float uSeaFloorScale;
uniform float uLayerScale[LAYERS];   // tiles per km
uniform vec3  uLayerTint[LAYERS];
uniform float uNormalStrength;
uniform float uMacroNormal;          // strength of the heightmap-derived normal
uniform float uHeightBlend;          // contrast of height-based blending
uniform float uTriSharp;
uniform float uMacroVar;             // macro albedo variation
uniform float uClimateTint;
uniform float uWetness;
uniform float uRiverAmount;
uniform vec3  uRiverColor;
uniform float uCityLights;
uniform float uAmbient;
uniform vec3  uSkyAmbient;
uniform float uCloudShadow;
uniform float uCloudAlt;
uniform float uCloudCover;
uniform mat3  uCloudRot;
uniform float uTime;
uniform int   uDebug;
uniform vec3  uLayerDebugColor[LAYERS];
uniform vec3  uBiomeColors[24];

varying vec3 vDir;
varying vec3 vWorldPos;

float elevationKm(float hM) { return (hM < 0.0 ? hM * uSeaFloorScale : hM) * uHeightScale; }
float heightM(vec3 d) { return texture(tHeight, cubeTexCoord(d, uN)).r; }
vec3 surfPos(vec3 d) { return d * (uRadius + elevationKm(heightM(d))); }

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

vec3 tempRamp(float t) {
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

float cloudCoverAt(vec3 dir) {
  vec3 cd = uCloudRot * dir;
  float c = texture(tClouds, cubeTexCoord(cd, uCloudN)).r;
  float detail = fbm3(cd * 40.0 + vec3(0.0, uTime * 0.01, 0.0));
  return smoothstep(0.5 - uCloudCover * 0.5, 0.75 - uCloudCover * 0.4, c + detail * 0.18);
}

void main() {
  vec3 n = normalize(vDir);                     // sphere normal (object == world, planet is static)

  // --- Macro normal from the height texture -----------------------------------------------------
  vec3 up = abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t1 = normalize(cross(up, n));
  vec3 t2 = cross(n, t1);
  float e = 1.5707963 / uN * 0.75;
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

  // Per layer albedo+height (needed first for height blending).
  vec4 ah[4];
  for (int k = 0; k < 4; k++) {
    ah[k] = vec4(0.0);
    if (wt[k] < 0.004) continue;
    float L = float(idx[k]);
    float sc = uLayerScale[idx[k]];
    if (bw.x > 0.02) ah[k] += bw.x * texture(tAlbedo, vec3(uvX * sc, L));
    if (bw.y > 0.02) ah[k] += bw.y * texture(tAlbedo, vec3(uvY * sc, L));
    if (bw.z > 0.02) ah[k] += bw.z * texture(tAlbedo, vec3(uvZ * sc, L));
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
      tnX += hb[k] * (texture(tNormal, vec3(uvX * sc, L)).xyz * 2.0 - 1.0);
      orm += hb[k] * bw.x * texture(tOrm, vec3(uvX * sc, L)).rgb;
    }
    if (bw.y > 0.02) {
      tnY += hb[k] * (texture(tNormal, vec3(uvY * sc, L)).xyz * 2.0 - 1.0);
      orm += hb[k] * bw.y * texture(tOrm, vec3(uvY * sc, L)).rgb;
    }
    if (bw.z > 0.02) {
      tnZ += hb[k] * (texture(tNormal, vec3(uvZ * sc, L)).xyz * 2.0 - 1.0);
      orm += hb[k] * bw.z * texture(tOrm, vec3(uvZ * sc, L)).rgb;
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

  // --- Macro variation & climate tint -------------------------------------------------------------
  float macro = fbm3(n * 9.0) + 0.5 * fbm3(n * 37.0);
  albedo *= 1.0 + uMacroVar * macro;
  float temp = climate.r, moist = climate.g, flow = climate.b;
  float veg = 0.0;
  for (int k = 0; k < 4; k++) if (idx[k] >= 1 && idx[k] <= 3) veg += hb[k];
  vec3 dryTint = vec3(1.25, 1.05, 0.55);
  vec3 lushTint = vec3(0.8, 1.05, 0.75);
  vec3 tint = mix(dryTint, lushTint, smoothstep(0.15, 0.8, moist));
  albedo = mix(albedo, albedo * tint, veg * uClimateTint);

  // --- Wetness & rivers (from erosion flow) -------------------------------------------------------
  float land = smoothstep(-5.0, 20.0, hM);
  float wet = smoothstep(0.25, 0.7, flow) * uWetness * land;
  albedo *= mix(1.0, 0.55, wet);
  rough = mix(rough, 0.25, wet);
  float river = smoothstep(0.62, 0.85, flow) * uRiverAmount * land * (1.0 - smoothstep(0.1, 0.35, 1.0 - temp));
  albedo = mix(albedo, uRiverColor, river);
  rough = mix(rough, 0.06, river);
  N = normalize(mix(N, Nm, river));

  // --- Lighting ------------------------------------------------------------------------------------
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 Lsun = uSunDir;
  vec3 sunCol = sunLightAt(vWorldPos);
  // Cloud shadow: march from the surface toward the sun to the cloud shell.
  float rc = uRadius + uCloudAlt;
  float tCloud = raySphere(vWorldPos, Lsun, rc).y;
  float cs = cloudCoverAt(normalize(vWorldPos + Lsun * max(tCloud, 0.0)));
  float shadow = 1.0 - uCloudShadow * cs;
  // Keep normal-mapped light from leaking past the terminator.
  float horizon = smoothstep(-0.02, 0.06, dot(n, Lsun));

  vec3 col = brdf(albedo, rough, metal, N, V, Lsun) * sunCol * shadow * horizon;
  float dayAmb = smoothstep(-0.25, 0.3, dot(n, Lsun));
  col += albedo * ao * (uSkyAmbient * dayAmb + vec3(uAmbient)) * (0.6 + 0.4 * dot(N, n));

  // --- Night-side city lights ----------------------------------------------------------------------
  if (uCityLights > 0.0) {
    float night = smoothstep(0.02, -0.12, dot(n, Lsun));
    float habitable = land * (1.0 - smoothstep(0.0, 1.0, max(0.0, hM - 1500.0) / 1500.0))
                      * smoothstep(0.35, 0.5, temp) * (1.0 - smoothstep(0.82, 0.95, temp))
                      * smoothstep(0.15, 0.35, moist);
    float cities = smoothstep(0.35, 0.75, fbm3(n * 60.0) + 0.6 * snoise(n * 400.0));
    float coast = 1.0 - smoothstep(0.0, 500.0, hM);
    float lights = cities * habitable * (0.4 + coast);
    col += night * lights * uCityLights * vec3(1.0, 0.62, 0.3);
  }

  // --- Debug views ---------------------------------------------------------------------------------
  if (uDebug == 1) col = albedo;
  else if (uDebug == 2) col = N * 0.5 + 0.5;
  else if (uDebug == 3) col = heightRamp(hM) * (0.35 + 0.65 * max(dot(Nm, Lsun), 0.0));
  else if (uDebug == 5) col = uBiomeColors[int(climate.a * 255.0 + 0.5) % 24] * (0.4 + 0.6 * max(dot(Nm, Lsun), 0.0));
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
