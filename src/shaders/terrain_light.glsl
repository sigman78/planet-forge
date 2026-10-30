// Ground lighting shared by the terrain and the surface rocks, so both shade alike.
// Needs terrain_common.glsl (heightmap).
#ifndef PI
#define PI 3.14159265359
#endif
uniform float uShadows;   // cast-shadow strength (0 = off)

// GGX / Smith / Schlick.
uniform float uSpecular;   // specular scale (dusty regolith has almost no sheen)

// specScale: specular multiplier (callers usually pass uSpecular).
vec3 brdfS(vec3 albedo, float rough, float metal, vec3 N, vec3 V, vec3 L, float specScale) {
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
  // Opposition surge: regolith brightens when lit from behind the viewer (shadow hiding).
  float surge = 1.0 + 0.35 * pow(max(dot(V, L), 0.0), 6.0) * rough;
  return (kd * albedo / PI * surge + spec * specScale) * NdL;
}
vec3 brdf(vec3 albedo, float rough, float metal, vec3 N, vec3 V, vec3 L) {
  return brdfS(albedo, rough, metal, N, V, L, uSpecular);
}

// Soft cast shadow from the baked heightmap: march toward the sun with growing steps and keep the
// smallest clearance angle (penumbra ~ the sun's disc plus some softening).
float terrainShadow(vec3 n, vec3 L) {
  if (uShadows <= 0.0) return 1.0;
  float texKm = uRadius * 1.5707963 / uN;
  vec3 p = n * (uRadius + elevationKm(bakedHeightM(n))) + n * texKm * 0.15;
  float t = texKm * 0.8;
  float tMax = min(uRadius * 0.35, 160.0);
  float s = 1.0;
  for (int i = 0; i < 24; i++) {
    vec3 q = p + L * t;
    float rq = length(q);
    vec3 d = q / rq;
    float clear = rq - (uRadius + elevationKm(bakedHeightM(d)));
    s = min(s, clamp(clear / (t * 0.035) + 0.5, 0.0, 1.0));
    if (s <= 0.0 || t > tMax) break;
    t *= 1.28;
  }
  return mix(1.0, smoothstep(0.0, 1.0, s), uShadows);
}
