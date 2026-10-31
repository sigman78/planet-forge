// Post-process single-scattering atmosphere (Rayleigh + Mie) using the scene depth buffer.
#define PI 3.14159265359
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform float uSunIntensity;
uniform int uSteps;
uniform float uFrame;
uniform float uJitter;
uniform float uRevZ;            // 1 with a reversed depth buffer (tDepth: 1 at the near plane, 0 at the far plane)
uniform float uHQ;             // 1 = volumetric terrain shadows in the dust and haze, more haze steps; debug: 2 = shadow map on the ground, 3 = haze glow only
uniform sampler2D tSunShadow;   // sun shadow map, 6 faces tiled 3x2: R = km above the datum where light starts, G = its lift above the ground
uniform float uSunShadowS;      // face tile size in texels
uniform float uShafts;          // stretches the terrain's shadow volumes upward (1 = physical)
uniform float uMood;            // mood grade strength low in the air (0 = off)
uniform float uExposure;        // tone-mapping exposure (the grade's shadow/highlight pivot sits in display terms)
varying vec2 vUv;

// 1 where the air at p sees the sun past the terrain, 0 inside a mountain's shadow (HQ only).
float terrainLit(vec3 p, float soft) {
  float r = length(p);
  vec3 stf = dirToFace(p / r);
  vec2 f = clamp(stf.xy * 0.5 + 0.5, vec2(0.5 / uSunShadowS), vec2(1.0 - 0.5 / uSunShadowS));
  vec2 uv = (f + vec2(mod(stf.z, 3.0), floor(stf.z / 3.0))) / vec2(3.0, 2.0);
  vec2 sh = textureLod(tSunShadow, uv, 0.0).rg;
  // Lit ground has no lift, so stretched shafts still start exactly where the ground shadows do.
  float litElev = sh.r + (uShafts - 1.0) * sh.g;
  return smoothstep(-soft, soft, r - uPlanetRadius - litElev);
}

// Mood grade, per world and only deep in the air: the eye adapted to this sky sees shadows in the air's colour
// and highlights in the sun's, and dust flattens saturation. Strength follows the air's extinction at the camera,
// so orbit and airless worlds are untouched. Applied to the attenuated scene only, before the inscatter is added.
vec3 moodGrade(vec3 c) {
  if (uMood <= 0.0) return c;
  vec3 dn = atmoDensityAt(uCamPos);
  float ray = dot(uRayleigh, vec3(1.0 / 3.0)) * dn.x;
  float mie = uMie * dn.y, haze = uHaze * dn.z;
  float ext = ray + mie + haze;                       // per km
  float day = smoothstep(-0.12, 0.12, dot(normalize(uCamPos), uSunDir));
  float w = (1.0 - exp(-ext * 80.0)) * uMood * day;   // night: planetshine, not this sky, lights the ground
  if (w < 1e-3) return c;
  const vec3 LW = vec3(0.2126, 0.7152, 0.0722);
  // The colour of this sky's scattered sunlight, chroma pushed a little (it is a mood, not a measurement).
  vec3 air = (uRayleigh * dn.x + vec3(mie) + haze * uHazeColor) * uSunColor;
  air /= max(dot(air, LW), 1e-9);
  air = max(mix(vec3(1.0), air, 1.4), vec3(0.05));
  air /= dot(air, LW);
  vec3 sun = uSunColor / max(dot(uSunColor, LW), 1e-9);
  float L = dot(c, LW) * uExposure;
  float hi = smoothstep(0.01, 0.3, L);                // 0 in shadow, 1 in highlights
  vec3 tint = mix(air, mix(air, sun, 0.8), hi);       // shadows in the air's colour, sunlit ground in the sun's
  vec3 g = c * mix(vec3(1.0), tint, clamp(0.4 * w, 0.0, 0.5));
  // Dust and haze veil: flatter contrast and colour; clean Rayleigh air barely does this.
  float dusty = (mie + haze) / max(ext, 1e-9);
  float pivot = 0.18 / max(uExposure, 1e-6);
  g = pivot * pow(max(g / pivot, vec3(0.0)), vec3(1.0 - clamp(0.2 * w * dusty, 0.0, 0.3)));
  float Lg = dot(g, LW);
  g = mix(vec3(Lg), g, 1.0 - clamp(0.35 * w * dusty, 0.0, 0.45));
  return g;
}

float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

void main() {
  vec4 src = texture(tColor, vUv);
  vec3 col = src.rgb;
  if (uAtmoDensity <= 0.0) { gl_FragColor = vec4(col, 1.0); return; }
  float d = texture(tDepth, vUv).x;
  // Reversed depth buffer: the depth is the clip z/w itself (near 1, far 0), with nothing drawn at 0.
  bool rev = uRevZ > 0.5;
  bool sky = rev ? d <= 1e-7 : d >= 0.999999;
  vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, rev ? d : d * 2.0 - 1.0, 1.0);
  vp /= vp.w;
  vec3 wp = (uCamWorld * vec4(vp.xyz, 1.0)).xyz;
  vec3 ro = uCamPos;
  vec3 rd = normalize(wp - ro);
  float sceneT = sky ? 1e9 : length(wp - ro);
  if (uHQ > 1.5 && uHQ < 2.5) {
    // Debug: the shadow-height map's verdict for the visible ground (lifted a little off the surface).
    float v = sceneT < 1e8 ? terrainLit(wp + normalize(wp) * 0.3, 0.2) : 0.0;
    gl_FragColor = vec4(vec3(v), 1.0);
    return;
  }

  vec2 hit = raySphere(ro, rd, uAtmoRadius + uFigureMax);
  if (hit.x > hit.y || hit.y < 0.0) { gl_FragColor = vec4(col, 1.0); return; }
  // Rays without scene depth stop at the lowest-terrain sphere (never above real ground, so low
  // cameras in basins do not see a fake dark horizon).
  vec2 ground = raySphere(ro, rd, uGroundRadius);
  if (sceneT > 1e8 && ground.x > 0.0 && ground.x < ground.y) sceneT = ground.x;
  float t0 = max(hit.x, 0.0);
  float t1 = min(hit.y, sceneT);
  if (t1 <= t0) { gl_FragColor = vec4(moodGrade(col), 1.0); return; }

  int steps = uSteps;
  float dt = (t1 - t0) / float(steps);
  float jitter = 0.5 + (ign(gl_FragCoord.xy + uFrame * 5.588238) - 0.5) * uJitter;
  vec3 odView = vec3(0.0);
  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);
  vec3 sumH = vec3(0.0);
  for (int i = 0; i < 64; i++) {
    if (i >= steps) break;
    vec3 p = ro + rd * (t0 + (float(i) + jitter) * dt);
    vec3 dens = atmoDensityAt(p) * dt;
    dens.z = 0.0;   // haze is integrated separately below (thin layer, needs its own steps)
    odView += dens;
    vec3 odSun = opticalDepthToSun(p, 6);
    vec3 tr = transmittanceFromOD(odView + odSun);
    // Shafts: the low dust (Mie) also falls into the terrain's shadow.
    float litM = uHQ > 0.0 ? terrainLit(p, 0.4 + 0.15 * uMieH) : 1.0;
    sumR += dens.x * tr;
    sumM += dens.y * tr * litM;
  }
  float mu = dot(rd, uSunDir);
  float phaseR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  float g = uMieG;
  float phaseM = 3.0 / (8.0 * PI) * ((1.0 - g * g) * (1.0 + mu * mu)) / ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
  vec3 inscatter = (sumR * uRayleigh * phaseR + sumM * uMie * phaseM) * uSunColor * uSunIntensity;
  vec3 viewTr = transmittanceFromOD(odView);

  // Ground haze: march only the part of the ray inside the haze layer.
  float hazeOD = 0.0;
  if (uHaze > 0.0) {
    vec2 hh = raySphere(ro, rd, min(uPlanetRadius + uFigureMax + uHazeH * 6.0, uAtmoRadius + uFigureMax));
    float a0 = max(hh.x, 0.0), a1 = min(hh.y, min(sceneT, ground.x > 0.0 && ground.x < ground.y ? ground.x : 1e9));
    if (a1 > a0) {
      int hsteps = uHQ > 0.0 ? 48 : 16;
      float hdt = (a1 - a0) / float(hsteps);
      float dither = ign(gl_FragCoord.xy);   // static per-pixel offset: fine noise instead of bands
      float soft = 0.15 + 0.25 * uHazeH;
      for (int i = 0; i < 48; i++) {
        if (i >= hsteps) break;
        vec3 p = ro + rd * (a0 + (float(i) + dither) * hdt);
        float r = length(p);
        float hz = max(r - uPlanetRadius - figureKm(p / r), -0.7 * uHazeH);
        float dz = exp(-hz / uHazeH) * hdt;
        hazeOD += dz;
        // Sun through the haze: planet shadow + airmass approximation instead of a nested march.
        vec3 up = p / r;
        float cz = dot(up, uSunDir);
        vec2 occ = raySphere(p, uSunDir, uGroundRadius);
        float lit = (occ.x > 0.0 && occ.x < occ.y) ? 0.0 : 1.0;
        float odSunH = uHaze * uHazeH * exp(-hz / uHazeH) / max(cz + 0.15, 0.08);
        if (uHQ > 0.0 && lit > 0.0) lit *= terrainLit(p, soft);
        sumH += dz * exp(-uHaze * hazeOD - odSunH) * (lit * smoothstep(-0.12, 0.05, cz));
      }
    }
  }
  float gh = uHazeG;
  float phaseH = (1.0 - gh * gh) / (4.0 * PI * pow(1.0 + gh * gh - 2.0 * gh * mu, 1.5));
  inscatter += sumH * uHaze * uHazeColor * (phaseH + 0.02) * uSunColor * uSunIntensity;
  if (uHQ > 2.5) { gl_FragColor = vec4(sumH * uHaze * uHazeColor * (phaseH + 0.02) * uSunColor * uSunIntensity * 3.0, 1.0); return; }
  // Grade what the eye sees through the air, not the air itself: the inscatter already has the sky's colour.
  gl_FragColor = vec4(moodGrade(col * viewTr * exp(-uHaze * hazeOD)) + inscatter, 1.0);
}
