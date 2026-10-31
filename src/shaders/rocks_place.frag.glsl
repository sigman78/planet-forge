// Rock placement: one 3-texel strip per instance in GRID x GRID windows of world cells, one window per cube face
// the rock area touches (stacked vertically). A cell belongs to the face it lies on; cells past a window's face
// edge are left empty (the neighbour face's window has them).
// Texel 0: position (km) and radius (km, 0 = no rock). Texel 1: ground normal and a seed.
// Texel 2: x = splat layer the rock is made of + sun shadow * 0.99.
// Cells are hashed by their world index, so rocks stay put while the window follows the camera. A rock's place on
// the ground, its size, layer and the slope it sits on come from the height field at its own direction, never from
// the drawn triangles: the mesh refines and morphs with the camera, and rocks placed on it slid and tilted with it.
// Only the height follows the mesh, through the footprint the terrain is drawn at there (so a rock on a far, coarse
// ring sits on that ring, not metres above or below it on relief the ring does not carry).
#define GRID 96
uniform vec3  uAnchor[3];   // per window: face, cell i, cell j of the window centre
uniform int   uWindows;
uniform float uCellS;       // cell size in face coordinates
uniform float uRMin, uRMax; // km
uniform float uDensity;
uniform float uLevel;
uniform float uOcean;       // 1 when the world has a sea or sea ice (no rocks at or below the datum)
uniform float uClusterKm;   // size of rock fields
uniform vec3  uCamPos;
uniform float uRockDensity[8];
uniform sampler2DArray tAO;    // (tSplat0/1 and tGrad come with terrain_fine.glsl)
// HQ terrain rings (terrain_hq.glsl): the footprint the terrain is drawn at inside them.
#define HQ_LEVELS 9
uniform int   uHQK;                  // ring levels drawn (0 = none)
uniform float uHQN;                  // cells per ring side
uniform vec2  uHQOriginA[HQ_LEVELS];
uniform vec2  uHQNadirA[HQ_LEVELS];
uniform float uHQCellSA[HQ_LEVELS];
uniform float uHQCellKmA[HQ_LEVELS];
uniform float uHQBlendA[HQ_LEVELS];

// PCG3D (Jarzynski & Olano): cell indices reach ~2e5, where float hashes correlate.
uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
vec3 hash3(ivec3 c) { return vec3(pcg3d(uvec3(c))) * (1.0 / 4294967296.0); }

// Footprint (km) the terrain is drawn at under direction d: the finest HQ ring holding the point, morphed toward
// its parent as hqRingVertex does (terrain_hq.glsl), or the coarse mesh (terrain.vert.glsl) outside the rings.
float drawnFootprint(vec3 d) {
  float fp = max(length(uCamPos - d * uRadius) * uPixelAngle, uVertexSpacing * 2.0);
  if (uHQK > 0) {
    vec2 sa = faceST(uHQFace, d);
    for (int k = HQ_LEVELS - 1; k >= 0; k--) {
      if (k >= uHQK) continue;
      vec2 loc = (sa + 1.0) / uHQCellSA[k] - uHQOriginA[k];
      if (all(greaterThanEqual(loc, vec2(0.0))) && all(lessThanEqual(loc, vec2(uHQN)))) {
        float dist = max(abs(loc.x - uHQNadirA[k].x), abs(loc.y - uHQNadirA[k].y));
        float a = clamp((dist - uHQMorph.x) / (uHQMorph.y - uHQMorph.x), 0.0, 1.0);
        a = max(a, 1.0 - uHQBlendA[k]);
        fp = 2.0 * uHQCellKmA[k] * (1.0 + a);
        break;
      }
    }
  }
  return fp;
}

vec3 groundAt(vec3 d) { return d * (uRadius + elevationKm(hqHeightM(d))); }

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
  vec3 dir = faceDir(float(face), st);

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
  // Power-law sizes (many small, few large).
  const float ALPHA = 2.5;
  float r = uRMin * pow(1.0 - h2.x * (1.0 - pow(uRMin / uRMax, ALPHA)), -1.0 / ALPHA);
  r *= step(h.z, dens);
  if (r <= 0.0) { gl_FragColor = vec4(0.0); return; }

  // Where the rock sits: the height field at the footprint the terrain is drawn at here.
  gFootprint = drawnFootprint(dir);
  vec3 P = groundAt(dir);
  float hM = textureLod(tHeight, tc, 0.0).r;
  // Judged on the placed point too: the drawn surface and the bilinear heightmap disagree on steep shores.
  if (uOcean > 0.5 && (hM < 3.0 || length(P) < uRadius + 0.0005)) { gl_FragColor = vec4(0.0); return; }

  // The slope it sits on: the ground a rock diameter either side.
  vec3 t1 = normalize(cross(dir, abs(dir.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 t2 = cross(dir, t1);
  float e = max(2.0 * r, 0.002) / uRadius;
  vec3 P1 = groundAt(normalize(dir + t1 * e));
  vec3 P2 = groundAt(normalize(dir + t2 * e));
  vec3 Nt = normalize(cross(P1 - P, P2 - P));
  if (dot(Nt, dir) < 0.0) Nt = -Nt;

  if (comp == 0) gl_FragColor = vec4(P, r);
  else if (comp == 1) gl_FragColor = vec4(Nt, h2.y);
  else {
    float sh = dot(dir, uSunDir) > -0.05 ? terrainShadow(dir, uSunDir) : 0.0;
    gl_FragColor = vec4(float(layer) + 0.99 * sh, h2.z, 0.0, 0.0);
  }
}
