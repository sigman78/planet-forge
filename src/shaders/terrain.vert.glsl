uniform float uVertexSpacing;  // km between mesh vertices

varying vec3 vDir;
varying vec3 vWorldPos;

void main() {
  vec3 d = normalize(position);
  // Geometry can't carry detail finer than ~2 vertex spacings or one pixel; the fragment normals take over.
  float dist = length(cameraPosition - d * uRadius);
  gFootprint = max(dist * uPixelAngle, uVertexSpacing * 2.0);
  vec3 p = surfPos(d);
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vDir = d;
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
