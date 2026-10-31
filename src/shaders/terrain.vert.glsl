uniform float uVertexSpacing;  // km between mesh vertices

varying vec3 vDir;
varying vec3 vWorldPos;
varying float vElevM;   // metres above the datum as drawn (0 on a frozen sea)
// HQ terrain: coarse vertices more than a coarse cell inside the rings sink out of sight, so the depth test rejects
// their triangles before shading. In the margin the coarse triangles coincide with the outer ring (fully morphed onto
// them), so no discard is needed (a discard would also cost early depth rejection).
uniform float uHQOn;
uniform float uHQFace;
uniform vec4 uHQSink;   // anchor-face grid rect (min.xy, max.xy)

void main() {
  vec3 d = normalize(position);
  // Geometry can't carry detail finer than ~2 vertex spacings or one pixel; the fragment normals take over.
  float dist = length(cameraPosition - d * uRadius);
  gFootprint = max(dist * uPixelAngle, uVertexSpacing * 2.0);
  float hM = terrainHeightM(d);
  vec3 p = d * (uRadius + elevationKm(hM));   // = surfPos(d)
  vElevM = uSeaIce > 0.5 ? max(hM, 0.0) : hM;
  if (uHQOn > 0.5) {
    vec2 hst = faceST(uHQFace, d);
    if (all(greaterThan(hst, uHQSink.xy)) && all(lessThan(hst, uHQSink.zw))) p -= d * 3.0;
  }
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vDir = d;
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
