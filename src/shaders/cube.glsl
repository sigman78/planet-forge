// Cube-sphere mapping, GLSL copy of src/core/cube.ts. Keep in sync.
// Face order: 0 +X, 1 -X, 2 +Y, 3 -Y, 4 +Z, 5 -Z. Tan-warped grid, 1-texel gutter per face.

#ifndef CUBE_GLSL
#define CUBE_GLSL

// Returns vec3(s, t, face) with s,t in [-1,1].
vec3 dirToFace(vec3 d) {
  vec3 a = abs(d);
  float face;
  vec2 c;
  if (a.x >= a.y && a.x >= a.z) {
    if (d.x > 0.0) { face = 0.0; c = vec2(-d.z, d.y) / a.x; }
    else           { face = 1.0; c = vec2( d.z, d.y) / a.x; }
  } else if (a.y >= a.z) {
    if (d.y > 0.0) { face = 2.0; c = vec2(d.x, -d.z) / a.y; }
    else           { face = 3.0; c = vec2(d.x,  d.z) / a.y; }
  } else {
    if (d.z > 0.0) { face = 4.0; c = vec2( d.x, d.y) / a.z; }
    else           { face = 5.0; c = vec2(-d.x, d.y) / a.z; }
  }
  return vec3(atan(c) * (4.0 / 3.14159265358979), face);
}

// Direction -> (u, v, layer) texture coordinate into a sampler2DArray with interior res N (+2 gutter).
vec3 cubeTexCoord(vec3 d, float N) {
  vec3 stf = dirToFace(d);
  vec2 uv = ((stf.xy + 1.0) * 0.5 * N + 1.0) / (N + 2.0);
  return vec3(uv, stf.z);
}

#endif
