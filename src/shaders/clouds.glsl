// Cloud shell. VERTEX / FRAGMENT split on '//#FRAGMENT'.
uniform float uRadius;
uniform float uCloudAlt;
varying vec3 vDir;
varying vec3 vWorldPos;
void main() {
  vDir = normalize(position);
  vec4 wp = modelMatrix * vec4(vDir * (uRadius + uCloudAlt), 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
//#FRAGMENT
#define PI 3.14159265359
uniform sampler2DArray tClouds;
uniform float uCloudN;
uniform float uRadius;
uniform float uCloudAlt;
uniform float uCloudCover;
uniform float uCloudOpacity;
uniform mat3  uCloudRot;
uniform float uTime;
uniform vec3  uSkyAmbient;
uniform float uAmbient;
uniform vec3  uCloudTint;
varying vec3 vDir;
varying vec3 vWorldPos;

float cloudCoverAt(vec3 dir, float detailAmt) {
  vec3 cd = uCloudRot * dir;
  float c = texture(tClouds, cubeTexCoord(cd, uCloudN)).r;
  float detail = fbm3(cd * 40.0 + vec3(0.0, uTime * 0.01, 0.0)) + 0.35 * snoise(cd * 160.0 + uTime * 0.02);
  return smoothstep(0.5 - uCloudCover * 0.5, 0.75 - uCloudCover * 0.4, c + detail * 0.18 * detailAmt);
}

float hg(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * c, 1.5));
}

void main() {
  vec3 n = normalize(vDir);
  float dens = cloudCoverAt(n, 1.0);
  if (dens < 0.01) discard;
  vec3 L = uSunDir;
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 sunCol = sunLightAt(vWorldPos);

  // Self-shadowing: coverage a little toward the sun along the shell.
  vec3 toward = normalize(n + (L - n * dot(L, n)) * 0.012);
  float occl = cloudCoverAt(toward, 1.0);
  float NdL = dot(n, L);
  float wrap = clamp((NdL + 0.15) / 1.15, 0.0, 1.0);
  float shade = mix(1.0, 0.45, occl * dens);
  float phase = 0.6 / (4.0 * PI) + 0.8 * hg(dot(-V, L), 0.6);   // forward-scatter silver lining
  vec3 col = uCloudTint * sunCol * wrap * shade * (0.32 + phase * 1.5);
  col += uCloudTint * (uSkyAmbient * smoothstep(-0.25, 0.3, NdL) * 0.8 + uAmbient);

  // Thicker look near the limb (longer path through the layer).
  float mu = abs(dot(n, V));
  float alpha = clamp(dens * uCloudOpacity * (1.0 + 0.6 * (1.0 - mu)), 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
}
