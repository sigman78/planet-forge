varying vec3 vDir;
varying vec3 vWorldPos;

void main() {
  vec3 d = normalize(position);
  vec3 p = surfPos(d);
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vDir = d;
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
