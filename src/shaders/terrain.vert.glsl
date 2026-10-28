uniform sampler2DArray tHeight;
uniform float uN;
uniform float uRadius;       // km
uniform float uHeightScale;  // km per metre of elevation, includes exaggeration
uniform float uSeaFloorScale; // extra multiplier for below-sea elevations

varying vec3 vDir;
varying vec3 vWorldPos;

float elevationKm(float hM) {
  return (hM < 0.0 ? hM * uSeaFloorScale : hM) * uHeightScale;
}

void main() {
  vec3 d = normalize(position);
  float h = textureLod(tHeight, cubeTexCoord(d, uN), 0.0).r;
  vec3 p = d * (uRadius + elevationKm(h));
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vDir = d;
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
