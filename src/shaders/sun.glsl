// Sun disc + glare billboard at infinity. VERTEX / FRAGMENT split on '//#FRAGMENT'.
uniform vec3 uSunDirView;   // unused placeholder for clarity
uniform vec3 uSunDir;
uniform float uSize;        // NDC half-size of the glare quad
uniform float uAspect;
varying vec2 vUv;
void main() {
  vec4 clip = projectionMatrix * vec4(mat3(viewMatrix) * uSunDir, 1.0);
  if (clip.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vUv = position.xy;
  vec2 ndc = clip.xy / clip.w + position.xy * vec2(uSize / uAspect, uSize);
  gl_Position = vec4(ndc, 0.99999, 1.0);
}
//#FRAGMENT
uniform vec3 uSunColor;
uniform float uDiscIntensity;
uniform float uDiscRadius;  // in quad units (0..1)
varying vec2 vUv;
void main() {
  float r = length(vUv);
  float disc = 1.0 - smoothstep(uDiscRadius * 0.85, uDiscRadius, r);
  float glow = exp(-r * 9.0) * 0.6 + exp(-r * 3.0) * 0.08;
  float ang = atan(vUv.y, vUv.x);
  float rays = pow(abs(cos(ang * 3.0)), 60.0) + pow(abs(cos(ang * 2.0 + 0.7)), 90.0) * 0.6;
  glow += rays * exp(-r * 5.0) * 0.12;
  vec3 c = uSunColor * (disc * uDiscIntensity + glow * uDiscIntensity * 0.02);
  gl_FragColor = vec4(c, 1.0);
}
