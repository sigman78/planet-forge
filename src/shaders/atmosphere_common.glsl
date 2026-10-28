// Shared physically-inspired atmosphere helpers (units: km). Used by the post pass, terrain, ocean and clouds.
#ifndef ATMO_COMMON_GLSL
#define ATMO_COMMON_GLSL

uniform float uPlanetRadius;   // sea-level radius, km
uniform float uGroundRadius;   // radius of the lowest terrain point, km (solid core for sky rays)
uniform float uAtmoRadius;     // top of atmosphere, km
uniform vec3  uRayleigh;       // scattering coefficient per km at sea level
uniform float uRayleighH;      // scale height km
uniform float uMie;            // scattering coefficient per km at sea level
uniform float uMieH;
uniform float uMieG;
uniform float uAtmoDensity;    // global density multiplier (0 = no atmosphere)
uniform float uHaze;           // low-lying dust/haze extinction per km at the surface (grey)
uniform float uHazeH;          // haze scale height, km (small: hugs the ground)
uniform vec3  uHazeColor;      // haze single-scattering albedo (tint)
uniform float uHazeG;          // haze phase anisotropy
uniform vec3  uSunDir;         // world space, normalized
uniform vec3  uSunColor;       // sun irradiance colour (HDR)

// Ray / sphere centred at origin. Returns (tNear, tFar); tNear > tFar if no hit.
vec2 raySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float h = b * b - c;
  if (h < 0.0) return vec2(1e9, -1e9);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

// Densities (rayleigh, mie, haze). Haze is a separate thin ground layer: barely visible from orbit
// (short vertical path) but it thickens toward the horizon when seen from low altitude.
vec3 atmoDensityAt(vec3 p) {
  // Altitude relative to the datum; basins below it are denser (down to the lowest terrain).
  // Capped so deep basins get at most ~2x the datum density instead of a whiteout.
  float h = length(p) - uPlanetRadius;
  vec3 hh = max(vec3(h), max(vec3(uGroundRadius - uPlanetRadius), -0.7 * vec3(uRayleighH, uMieH, uHazeH)));
  return vec3(exp(-hh.x / uRayleighH) * uAtmoDensity, exp(-hh.y / uMieH) * uAtmoDensity, exp(-hh.z / uHazeH));
}

// Optical depth (rayleigh, mie) from p toward the sun. Returns large values when the planet blocks the sun.
vec3 opticalDepthToSun(vec3 p, int steps) {
  vec2 hitG = raySphere(p, uSunDir, uGroundRadius);
  if (hitG.x > 0.0 && hitG.x < hitG.y) return vec3(1e4);
  float tEnd = raySphere(p, uSunDir, uAtmoRadius).y;
  float dt = tEnd / float(steps);
  vec3 od = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    if (i >= steps) break;
    od += atmoDensityAt(p + uSunDir * (float(i) + 0.5) * dt) * dt;
  }
  return od;
}

vec3 transmittanceFromOD(vec3 od) {
  return exp(-(uRayleigh * od.x + vec3(uMie * 1.11) * od.y + vec3(uHaze) * od.z));
}

// Sunlight reaching point p (with atmospheric reddening and planet shadow).
vec3 sunLightAt(vec3 p) {
  if (uAtmoDensity <= 0.0) return uSunColor;
  return uSunColor * transmittanceFromOD(opticalDepthToSun(p, 6));
}

#endif
