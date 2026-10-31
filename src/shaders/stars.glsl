// Point stars at infinity. VERTEX / FRAGMENT split on '//#FRAGMENT'.
attribute vec3 color;
uniform float uIntensity;
uniform float uPixelRatio;
uniform float uRevZ;        // reversed depth buffer: the far plane is at depth 0
varying vec3 vColor;
void main() {
  vec3 dir = position;
  vec4 clip = projectionMatrix * vec4(mat3(viewMatrix) * dir, 1.0);
  clip.z = clip.w * (uRevZ > 0.5 ? 0.00001 : 0.99999);
  gl_Position = clip;
  float lum = dot(color, vec3(0.2126, 0.7152, 0.0722)) * uIntensity;
  // Brighter stars get bigger sprites; intensity is spread over the sprite area.
  float size = clamp(1.6 + 1.4 * log(1.0 + lum * 2.0), 1.6, 9.0) * uPixelRatio;
  gl_PointSize = size;
  vColor = color * uIntensity * (4.0 / (size * size / (uPixelRatio * uPixelRatio)));
}
//#FRAGMENT
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  float a = exp(-r2 * 4.0);
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor * a, 1.0);
}
