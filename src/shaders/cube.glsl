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

// Grid point (s, t in [-1, 1], may run past the edge) on a face -> unit direction.
vec3 faceDir(float face, vec2 st) {
  vec2 c = tan(st * 0.78539816);
  vec3 d;
  if (face < 0.5) d = vec3(1.0, c.y, -c.x);
  else if (face < 1.5) d = vec3(-1.0, c.y, c.x);
  else if (face < 2.5) d = vec3(c.x, 1.0, -c.y);
  else if (face < 3.5) d = vec3(c.x, -1.0, c.y);
  else if (face < 4.5) d = vec3(c.x, c.y, 1.0);
  else d = vec3(-c.x, c.y, -1.0);
  return normalize(d);
}

// Direction -> grid point on a chosen face, extended past its edges (inverse of faceDir). Directions facing away
// from the face land far outside [-1, 1].
vec2 faceST(float face, vec3 d) {
  vec3 q;   // (u, v, n) components on the face
  if (face < 0.5) q = vec3(-d.z, d.y, d.x);
  else if (face < 1.5) q = vec3(d.z, d.y, -d.x);
  else if (face < 2.5) q = vec3(d.x, -d.z, d.y);
  else if (face < 3.5) q = vec3(d.x, d.z, -d.y);
  else if (face < 4.5) q = vec3(d.x, d.y, d.z);
  else q = vec3(-d.x, d.y, -d.z);
  return atan(q.xy / max(q.z, 1e-6)) * (4.0 / 3.14159265358979);
}

#endif
