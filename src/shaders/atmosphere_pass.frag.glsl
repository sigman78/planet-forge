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

  vec2 hit = raySphere(ro, rd, uAtmoRadius);
  if (hit.x > hit.y || hit.y < 0.0) { gl_FragColor = vec4(col, 1.0); return; }
  // Rays into empty sky stop at the solid planet sphere (handles pixels without depth, e.g. clouds).
  vec2 ground = raySphere(ro, rd, uPlanetRadius * 0.998);
  if (sceneT > 1e8 && ground.x > 0.0 && ground.x < ground.y) sceneT = ground.x;
  float t0 = max(hit.x, 0.0);
  float t1 = min(hit.y, sceneT);
  if (t1 <= t0) { gl_FragColor = vec4(col, 1.0); return; }

  int steps = uSteps;
  float dt = (t1 - t0) / float(steps);
  float jitter = 0.5 + (ign(gl_FragCoord.xy + uFrame * 5.588238) - 0.5) * uJitter;
  vec2 odView = vec2(0.0);
  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);
  for (int i = 0; i < 64; i++) {
    if (i >= steps) break;
    vec3 p = ro + rd * (t0 + (float(i) + jitter) * dt);
    vec2 dens = atmoDensityAt(p) * dt;
    odView += dens;
    vec2 odSun = opticalDepthToSun(p, 6);
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
  gl_FragColor = vec4(col * viewTr + inscatter, 1.0);
}
