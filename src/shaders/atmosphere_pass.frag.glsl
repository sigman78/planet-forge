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
varying vec2 vUv;

float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

void main() {
  vec4 src = texture(tColor, vUv);
  vec3 col = src.rgb;
  if (uAtmoDensity <= 0.0) { gl_FragColor = vec4(col, 1.0); return; }
  float d = texture(tDepth, vUv).x;
  vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vp /= vp.w;
  vec3 wp = (uCamWorld * vec4(vp.xyz, 1.0)).xyz;
  vec3 ro = uCamPos;
  vec3 rd = normalize(wp - ro);
  float sceneT = d >= 0.999999 ? 1e9 : length(wp - ro);

  vec2 hit = raySphere(ro, rd, uAtmoRadius + uFigureMax);
  if (hit.x > hit.y || hit.y < 0.0) { gl_FragColor = vec4(col, 1.0); return; }
  // Rays without scene depth stop at the lowest-terrain sphere (never above real ground, so low
  // cameras in basins do not see a fake dark horizon).
  vec2 ground = raySphere(ro, rd, uGroundRadius);
  if (sceneT > 1e8 && ground.x > 0.0 && ground.x < ground.y) sceneT = ground.x;
  float t0 = max(hit.x, 0.0);
  float t1 = min(hit.y, sceneT);
  if (t1 <= t0) { gl_FragColor = vec4(col, 1.0); return; }

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
    sumR += dens.x * tr;
    sumM += dens.y * tr;
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
      float hdt = (a1 - a0) / 16.0;
      float dither = ign(gl_FragCoord.xy);   // static per-pixel offset: fine noise instead of bands
      for (int i = 0; i < 16; i++) {
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
        sumH += dz * exp(-uHaze * hazeOD - odSunH) * (lit * smoothstep(-0.12, 0.05, cz));
      }
    }
  }
  float gh = uHazeG;
  float phaseH = (1.0 - gh * gh) / (4.0 * PI * pow(1.0 + gh * gh - 2.0 * gh * mu, 1.5));
  inscatter += sumH * uHaze * uHazeColor * (phaseH + 0.02) * uSunColor * uSunIntensity;
  gl_FragColor = vec4(col * viewTr * exp(-uHaze * hazeOD) + inscatter, 1.0);
}
