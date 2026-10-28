// Ocean shell at sea level. Modes: 0 water, 1 lava, 2 ice.
// VERTEX and FRAGMENT sections are split by the loader on '//#FRAGMENT'.
uniform float uRadius;
varying vec3 vDir;
varying vec3 vWorldPos;
void main() {
  vDir = normalize(position);
  vec4 wp = modelMatrix * vec4(vDir * uRadius, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
//#FRAGMENT
#define PI 3.14159265359
uniform sampler2DArray tHeight;
uniform sampler2D tWaterNormal;
uniform float uN;
uniform float uRadius;
uniform int   uMode;
uniform float uTime;
uniform vec3  uDeepColor;
uniform vec3  uShallowColor;
uniform float uClarity;       // metres of visibility
uniform float uWaveScale;     // tiles per km
uniform float uWaveStrength;
uniform float uFoam;
uniform vec3  uSkyAmbient;
uniform float uAmbient;
uniform vec3  uLavaColor;
uniform float uLavaGlow;
varying vec3 vDir;
varying vec3 vWorldPos;

// Screen-space derivatives of the world position (set at the top of main, in uniform control flow).
vec3 gDpdx;
vec3 gDpdy;
vec3 sampleWaterNormal(vec2 uv, vec2 gx, vec2 gy) { return textureGrad(tWaterNormal, uv, gx, gy).xyz * 2.0 - 1.0; }

// Triplanar-free trick: build the wave normal in the local tangent frame of the sphere.
vec3 waveNormal(vec3 n, vec3 p, float strength) {
  vec3 up = abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t1 = normalize(cross(up, n));
  vec3 t2 = cross(n, t1);
  // Local planar coordinates (km). Seam-free enough for a tangent-frame projection over a sphere
  // because we use world xyz, blended across the three dominant axes.
  vec3 bw = pow(abs(n), vec3(4.0));
  bw /= dot(bw, vec3(1.0));
  float t = uTime;
  vec2 d1 = vec2(0.02, 0.013) * t;
  vec2 d2 = vec2(-0.011, 0.017) * t;
  vec3 acc = vec3(0.0);
  vec2 uvs[3] = vec2[3](p.zy, p.xz, p.xy);
  vec2 gxs[3] = vec2[3](gDpdx.zy, gDpdx.xz, gDpdx.xy);
  vec2 gys[3] = vec2[3](gDpdy.zy, gDpdy.xz, gDpdy.xy);
  for (int i = 0; i < 3; i++) {
    float wgt = i == 0 ? bw.x : (i == 1 ? bw.y : bw.z);
    if (wgt < 0.02) continue;
    vec3 a = sampleWaterNormal(uvs[i] * uWaveScale + d1, gxs[i] * uWaveScale, gys[i] * uWaveScale);
    vec3 b = sampleWaterNormal(uvs[i] * uWaveScale * 0.37 + d2, gxs[i] * uWaveScale * 0.37, gys[i] * uWaveScale * 0.37);
    acc += wgt * vec3(a.xy + b.xy, 1.0);
  }
  return normalize(n + (t1 * acc.x + t2 * acc.y) * strength);
}

void main() {
  gDpdx = dFdx(vWorldPos);
  gDpdy = dFdy(vWorldPos);
  vec3 n = normalize(vDir);
  float h = textureLod(tHeight, cubeTexCoord(n, uN), 0.0).r;   // seabed elevation, metres (negative under water)
  float depth = -h;
  if (depth < -2.0) discard;

  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 L = uSunDir;
  vec3 sunCol = sunLightAt(vWorldPos);
  float camDist = length(cameraPosition - vWorldPos);
  float shadow = 1.0;
  float horizon = smoothstep(-0.02, 0.06, dot(n, L));
  float dayAmb = smoothstep(-0.25, 0.3, dot(n, L));

  if (uMode == 1) {
    // Lava: cooling crust with glowing cracks, slowly churning.
    vec3 q = n * 220.0;
    float flowN = fbm3(q * 0.15 + vec3(uTime * 0.004));
    float cracks = 1.0 - abs(snoise(q + flowN * 3.0 + vec3(0.0, uTime * 0.01, 0.0)));
    cracks = pow(cracks, 10.0);
    float hot = smoothstep(0.0, 400.0, depth) * 0.6 + 0.4;
    float heat = clamp(cracks * 1.4 + 0.25 * (fbm3(q * 0.05 - uTime * 0.002) + 0.5) * hot, 0.0, 1.5);
    vec3 crust = vec3(0.035, 0.03, 0.03);
    vec3 N = waveNormal(n, vWorldPos, 0.15);
    vec3 col = crust * (max(dot(N, L), 0.0) * sunCol * horizon / PI + uSkyAmbient * dayAmb);
    vec3 glow = uLavaColor * uLavaGlow * heat * heat;
    gl_FragColor = vec4(col + glow, 1.0);
    return;
  }

  if (uMode == 2) {
    // Frozen sea: rough white-blue ice with pressure ridges.
    vec3 q = n * 300.0;
    float ridges = pow(1.0 - abs(snoise(q)), 6.0);
    vec3 albedo = mix(vec3(0.55, 0.7, 0.8), vec3(0.92, 0.95, 1.0), clamp(0.6 + 0.4 * fbm3(q * 0.2) + ridges * 0.3, 0.0, 1.0));
    vec3 N = waveNormal(n, vWorldPos, 0.25);
    float NdL = max(dot(N, L), 0.0);
    vec3 H = normalize(V + L);
    float spec = pow(max(dot(N, H), 0.0), 60.0) * 0.4;
    vec3 col = (albedo / PI * NdL + spec) * sunCol * shadow * horizon + albedo * (uSkyAmbient * dayAmb + uAmbient);
    gl_FragColor = vec4(col, 1.0);
    return;
  }

  // ---- Water ----
  float strength = uWaveStrength * (1.0 - smoothstep(50.0, 1500.0, camDist) * 0.85);
  vec3 N = waveNormal(n, vWorldPos, strength);
  float NdV = max(dot(N, V), 1e-3);
  float NdL = max(dot(N, L), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);

  // GGX sun glint. Roughness grows with distance so the glint stays a smooth lobe from orbit.
  float rough = mix(0.04, 0.22, smoothstep(30.0, 2500.0, camDist));
  vec3 H = normalize(V + L);
  float NdH = max(dot(N, H), 0.0);
  float a2 = pow(rough, 4.0);
  float dd = NdH * NdH * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * dd * dd);
  float k = (rough + 1.0) * (rough + 1.0) / 8.0;
  float G = NdL / (NdL * (1.0 - k) + k) * NdV / (NdV * (1.0 - k) + k);
  float Fh = 0.02 + 0.98 * pow(1.0 - max(dot(V, H), 0.0), 5.0);
  vec3 spec = sunCol * (D * G * Fh / (4.0 * NdV + 1e-4)) * shadow * horizon;

  // Body colour: absorption with depth.
  float trans = exp(-max(depth, 0.0) / max(uClarity, 1.0));
  vec3 body = mix(uDeepColor, uShallowColor, trans);
  float lightAmt = max(dot(n, L), 0.0) * shadow * horizon;
  vec3 scatter = body * (sunCol * lightAmt * 0.12 + uSkyAmbient * dayAmb * 0.6 + uAmbient);
  vec3 sky = uSkyAmbient * dayAmb * 1.2 + vec3(uAmbient);
  vec3 col = mix(scatter, sky, fres) + spec;

  // Shore foam.
  float foamBand = 1.0 - smoothstep(0.0, 25.0 + 15.0 * snoise(n * 900.0 + uTime * 0.05), depth);
  float foamNoise = smoothstep(0.1, 0.7, fbm3(n * 2500.0 + vec3(uTime * 0.03)) + 0.5 * sin(depth * 0.3 - uTime * 1.5));
  float foam = clamp(foamBand * foamNoise, 0.0, 1.0) * uFoam * (1.0 - smoothstep(100.0, 900.0, camDist));
  col = mix(col, vec3(0.9) * (sunCol * lightAmt / PI + sky), foam);

  // Alpha: shallow water reveals the seabed; the coastline fades over a few metres.
  float alpha = clamp(1.0 - trans * 0.85, 0.0, 1.0);
  alpha = max(alpha, fres * 0.8);
  alpha = max(alpha, foam);
  alpha *= smoothstep(-2.0, 1.0, depth);
  gl_FragColor = vec4(col, alpha);
}
