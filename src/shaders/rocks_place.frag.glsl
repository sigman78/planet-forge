// Rock placement: one 3-texel strip per instance in GRID x GRID windows of world cells, one window per cube face
// the rock area touches (stacked vertically). A cell belongs to the face it lies on; cells past a window's face
// edge are left empty (the neighbour face's window has them).
// Texel 0: position (km) and radius (km, 0 = no rock). Texel 1: mesh-triangle normal and a seed.
// Texel 2: x = splat layer the rock is made of + sun shadow * 0.99.
// Cells are hashed by their world index, so rocks stay put while the window follows the camera.
#define GRID 96
uniform vec3  uAnchor[3];   // per window: face, cell i, cell j of the window centre
uniform vec2  uCenter[3];   // per window: unsnapped centre in that face's (extended) grid coordinates
uniform int   uWindows;
uniform float uCellS;       // cell size in face coordinates
uniform float uRMin, uRMax; // km
uniform float uDensity;
uniform float uLevel;
uniform float uSegments;    // terrain mesh segments per face side (rocks sit on its triangles)
uniform float uOcean;       // 1 when the world has a sea or sea ice (no rocks at or below the datum)
uniform float uClusterKm;   // size of rock fields
uniform vec3  uCamPos;
uniform float uVertexSpacing;   // km between terrain mesh vertices
uniform float uRockDensity[8];
uniform sampler2DArray tSplat0;
uniform sampler2DArray tSplat1;
uniform sampler2DArray tGrad;
uniform sampler2DArray tAO;

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

// PCG3D (Jarzynski & Olano): cell indices reach ~2e5, where float hashes correlate.
uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
vec3 hash3(ivec3 c) { return vec3(pcg3d(uvec3(c))) * (1.0 / 4294967296.0); }

// Terrain mesh vertex (i, j) on a face, displaced exactly as terrain.vert.glsl does.
vec3 meshVertex(float face, float i, float j) {
  vec3 d = faceDir(face, vec2(-1.0 + 2.0 * i / uSegments, -1.0 + 2.0 * j / uSegments));
  float dist = length(uCamPos - d * uRadius);
  gFootprint = max(dist * uPixelAngle, uVertexSpacing * 2.0);
  return surfPos(d);
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int comp = px.x % 3;
  int win = px.y / GRID;
  if (win >= uWindows) { gl_FragColor = vec4(0.0); return; }
  ivec2 id = ivec2(px.x / 3, px.y - win * GRID);
  vec3 anchor = uAnchor[win];
  ivec2 cell = ivec2(anchor.yz) + id - GRID / 2;
  int face = int(anchor.x + 0.5);
  vec3 h = hash3(ivec3(cell, face * 8 + int(uLevel)));
  vec3 h2 = hash3(ivec3(cell.x + 7919, cell.y - 104729, face * 8 + int(uLevel) + 64));
  vec2 st = -1.0 + (vec2(cell) + 0.1 + 0.8 * h.xy) * uCellS;
  if (max(abs(st.x), abs(st.y)) > 1.0) { gl_FragColor = vec4(0.0); return; }

  // The mesh quad that owns this point.
  vec2 g = (st + 1.0) * 0.5 * uSegments;
  vec2 ij = clamp(floor(g), 0.0, uSegments - 1.0);
  vec2 fr = clamp(g - ij, 0.0, 1.0);
  float F = float(face);
  vec3 A = meshVertex(F, ij.x, ij.y);
  vec3 B = meshVertex(F, ij.x + 1.0, ij.y);
  vec3 C = meshVertex(F, ij.x + 1.0, ij.y + 1.0);
  vec3 D = meshVertex(F, ij.x, ij.y + 1.0);
  // Same diagonal choice as geometry.ts, so the point lies on the rendered triangle.
  vec3 P, e1, e2;
  if (mod(ij.x + ij.y, 2.0) > 0.5) {
    if (fr.x + fr.y <= 1.0) { P = A + fr.x * (B - A) + fr.y * (D - A); e1 = B - A; e2 = D - A; }
    else { P = C + (1.0 - fr.x) * (D - C) + (1.0 - fr.y) * (B - C); e1 = C - B; e2 = D - B; }
  } else {
    if (fr.x >= fr.y) { P = A + fr.x * (B - A) + fr.y * (C - B); e1 = B - A; e2 = C - A; }
    else { P = A + fr.y * (D - A) + fr.x * (C - D); e1 = C - A; e2 = D - A; }
  }
  vec3 dir = normalize(P);
  vec3 Nt = normalize(cross(e1, e2));
  if (dot(Nt, dir) < 0.0) Nt = -Nt;

  // Density: rocky layers shed blocks, steep ground and hollows (crater floors, rims) collect them,
  // and rocks gather in fields instead of a uniform sprinkle.
  vec3 tc = cubeTexCoord(dir, uN);
  vec4 s0 = textureLod(tSplat0, tc, 0.0), s1 = textureLod(tSplat1, tc, 0.0);
  float w[8] = float[8](s0.r, s0.g, s0.b, s0.a, s1.r, s1.g, s1.b, s1.a);
  float dens = 0.0, best = -1.0;
  int layer = 4;
  for (int i = 0; i < 8; i++) {
    float c = w[i] * uRockDensity[i];
    dens += c;
    if (c > best) { best = c; layer = i; }
  }
  vec3 G = textureLod(tGrad, tc, 0.0).xyz * uHeightScale;
  G -= dot(G, dir) * dir;
  float slope = length(G);
  float ao = textureLod(tAO, tc, 0.0).r;
  dens *= (1.0 + 2.0 * smoothstep(0.12, 0.45, slope)) * (1.0 + 1.5 * (1.0 - ao));
  float field = smoothstep(-0.25, 0.55, snoise(dir * (uRadius / uClusterKm) + uLevel * 13.1));
  dens *= field * 1.6 * uDensity;
  float hM = textureLod(tHeight, tc, 0.0).r;
  // Judged on the placed point, not the baked height: the mesh and the bilinear heightmap disagree on steep shores.
  if (uOcean > 0.5 && (hM < 3.0 || length(P) < uRadius + 0.0005)) dens = 0.0;

  // Power-law sizes (many small, few large).
  const float ALPHA = 2.5;
  float r = uRMin * pow(1.0 - h2.x * (1.0 - pow(uRMin / uRMax, ALPHA)), -1.0 / ALPHA);
  // Shrink toward the window edge so blocks entering or leaving the window grow in instead of popping. Measured from
  // the unsnapped centre in the rock's own face grid, so it changes smoothly and the same way in every window.
  vec2 e = abs(st - uCenter[win]) / (float(GRID / 2 - 1) * uCellS);
  r *= (1.0 - smoothstep(0.7, 1.0, max(e.x, e.y))) * step(h.z, dens);

  if (comp == 0) gl_FragColor = vec4(P, r);
  else if (comp == 1) gl_FragColor = vec4(Nt, h2.y);
  else {
    float sh = dot(dir, uSunDir) > -0.05 ? terrainShadow(dir, uSunDir) : 0.0;
    gl_FragColor = vec4(float(layer) + 0.99 * sh, h2.z, 0.0, 0.0);
  }
}
