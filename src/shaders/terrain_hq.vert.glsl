// HQ terrain ring: one level of the camera-centred nested grids that refine the coarse cube-sphere near the
// camera (vertex rule in terrain_hq.glsl). position.xy holds the local integer grid point.
uniform ivec2 uHQOrigin;       // grid index of local vertex (0, 0), in this level's cells
uniform vec2  uHQNadir;        // camera nadir in this level's cells, relative to the origin
uniform float uHQCellS;        // grid units per cell
uniform float uHQCellKm;       // km per cell (nominal)
uniform float uHQBlend;        // 1 = the level shows its own detail, 0 = it is its parent (fades levels in)
uniform float uHQLevel;        // 1 = outermost ring (its parent is the coarse mesh)

varying vec3 vDir;
varying vec3 vWorldPos;
varying float vElevM;

void main() {
  float hM;
  vec3 p = hqRingVertex(uHQLevel, uHQOrigin, position.xy, uHQNadir, uHQCellS, uHQCellKm, uHQBlend, hM);
  vElevM = uSeaIce > 0.5 ? max(hM, 0.0) : hM;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vDir = normalize(p);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
