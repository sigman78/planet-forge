uniform float uVertexSpacing;  // km between mesh vertices

varying vec3 vDir;
varying vec3 vWorldPos;
varying float vElevM;   // metres above the datum as drawn (0 on a frozen sea)

void main() {
  vec3 d = normalize(position);
  // Geometry can't carry detail finer than ~2 vertex spacings or one pixel; the fragment normals take over.
  float dist = length(cameraPosition - d * uRadius);
  gFootprint = max(dist * uPixelAngle, uVertexSpacing * 2.0);
  float hM = terrainHeightM(d);
  vec3 p = d * (uRadius + elevationKm(hM));   // = surfPos(d)
  vElevM = uSeaIce > 0.5 ? max(hM, 0.0) : hM;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vDir = d;
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
