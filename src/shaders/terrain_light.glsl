// Ground lighting shared by the terrain and the surface rocks, so both shade alike.
// Needs terrain_common.glsl (heightmap).
#ifndef PI
#define PI 3.14159265359
#endif
uniform float uShadows;   // cast-shadow strength (0 = off)
// Near shadow map: the sun's orthographic view of the fine rings and rocks around the camera (nearShadow.ts).
uniform sampler2D tNearShadow;
uniform mat4  uNearShadowVP;
uniform float uNearShadow;      // weight (0 = off)
uniform float uNearShadowKm;    // km per texel
uniform float uNearShadowRange; // km from the map's near to its far plane
uniform vec3  uNearShadowU;     // world km per map texel along u
uniform vec3  uNearShadowV;     // world km per map texel along v
uniform float uRevZ;

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

// Shadow from the near map at world point P with surface normal N: 1 outside the map or lit, 0 in shadow,
// 3x3 filtered, fading at the map's edge. Each tap compares against the receiver's own plane carried to that
// texel (receiver-plane depth bias), so a grazing sun on flat ground needs no bias of its own and a boulder
// a few texels wide still shadows the ground behind it.
float nearShadow(vec3 P, vec3 N) {
  if (uNearShadow <= 0.0) return 1.0;
  vec4 c = uNearShadowVP * vec4(P, 1.0);
  vec3 ndc = c.xyz / c.w;
  vec2 uv = ndc.xy * 0.5 + 0.5;
  vec2 m = min(uv, 1.0 - uv);
  float edge = smoothstep(0.0, 0.04, min(m.x, m.y));
  if (edge <= 0.0) return 1.0;
  bool rev = uRevZ > 0.5;
  float z = rev ? ndc.z : ndc.z * 0.5 + 0.5;
  // Beyond the map's depth range nothing was drawn to compare with: lit.
  if (z < 0.0 || z > 1.0) return 1.0;
  // Depth of the receiver's plane one texel over in u and v: a step of (du, dv) texels stays on the plane by
  // sliding along the sun ray, which is the depth axis (the map's u, v axes are perpendicular to it).
  // A facet turned from the sun has no plane to carry (its slope flips sign and every tap lands inside the
  // ground): leave it to its own N.L, like terrainShadow does.
  float ndlRaw = dot(N, uSunDir);
  if (ndlRaw <= 0.0) return 1.0;
  float ndl = max(ndlRaw, 0.08);
  float sgn = (rev ? 1.0 : -1.0) / (uNearShadowRange * ndl);
  vec2 dz = -vec2(dot(uNearShadowU, N), dot(uNearShadowV, N)) * sgn;
  const float SZ = 2048.0;
  vec2 texel = vec2(1.0 / SZ);
  // Taps land on texel centres: carry the plane to the centre, not to the receiver's own sub-texel spot.
  vec2 tc = uv * SZ;
  vec2 centre = (floor(tc) + 0.5) / SZ;
  vec2 f = (centre - uv) * SZ;
  // Facets a texel apart meet at a crease, so beyond the plane carry a bias that grows with the sun's grazing
  // angle (the along-ray depth a texel of ground spans) keeps the taps on neighbouring triangles from biting.
  float tanT = sqrt(max(1.0 - ndl * ndl, 0.0)) / ndl;
  float bias = uNearShadowKm * (0.5 + 0.6 * min(tanT, 8.0)) / uNearShadowRange;
  float lit = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 o = vec2(float(i), float(j));
      float d = textureLod(tNearShadow, centre + o * texel, 0.0).r;
      float zt = z + dot(dz, o + f);
      lit += rev ? step(d - bias, zt) : step(zt, d + bias);
    }
  }
  return mix(1.0, lit / 9.0, uNearShadow * edge * smoothstep(0.0, 0.08, ndlRaw));
}

// Debug: (sampled map depth, receiver depth, uv-in-map) at P.
vec3 nearShadowDbg(vec3 P) {
  vec4 c = uNearShadowVP * vec4(P, 1.0);
  vec3 ndc = c.xyz / c.w;
  vec2 uv = ndc.xy * 0.5 + 0.5;
  float inMap = (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) ? 1.0 : 0.0;
  float d = textureLod(tNearShadow, uv, 0.0).r;
  return clamp(vec3(d, ndc.z, inMap), 0.0, 1.0);
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
