// Rock placement: one 3-texel strip per instance in GRID x GRID windows of world cells, one window per cube face
// the rock area touches (stacked vertically). A cell belongs to the face it lies on; cells past a window's face
// edge are left empty (the neighbour face's window has them).
// Texel 0: position (km) and radius (km, 0 = no rock). Texel 1: ground normal and a seed.
// Texel 2: x = splat layer the rock is made of + sun shadow * 0.99.
// Cells are hashed by their world index, so rocks stay put while the window follows the camera. A rock's place on
// the ground, its size, layer and the slope it sits on come from the height field at its own direction, never from
// the drawn triangles: the mesh refines and morphs with the camera, and rocks placed on it slid and tilted with it.
// Only its height follows the mesh: the rock sits where its direction pierces the drawn triangle, so it never hangs
// over or sinks into the ground however coarse the ring there is.
#define GRID 96
uniform vec3  uAnchor[3];   // per window: face, cell i, cell j of the window centre
uniform int   uWindows;
uniform float uCellS;       // cell size in face coordinates
uniform float uRMin, uRMax; // km
uniform float uDensity;
uniform float uLevel;
uniform float uOcean;       // 1 when the world has a sea or sea ice (no rocks at or below the datum)
uniform float uClusterKm;   // size of rock fields
uniform float uSegments;    // coarse terrain mesh segments per face side
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

// Coarse terrain mesh vertex (i, j) on a face, displaced exactly as terrain.vert.glsl does.
vec3 meshVertex(float face, float i, float j) {
  vec3 d = faceDir(face, vec2(-1.0 + 2.0 * i / uSegments, -1.0 + 2.0 * j / uSegments));
  gFootprint = max(length(uCamPos - d * uRadius) * uPixelAngle, uVertexSpacing * 2.0);
  return surfPos(d);
}

// Where `dir` pierces the plane of triangle (V0, V1, V2). False for a collapsed triangle or a near-vertical
// plane: a morphing ring triangle thins to nothing while its corners keep slightly different heights (their
// footprints differ), and the plane of such a sliver can point anywhere.
bool pierce(vec3 dir, vec3 V0, vec3 V1, vec3 V2, float cellKm, out vec3 P) {
  vec3 N = cross(V1 - V0, V2 - V0);
  float n = length(N);
  float dn = dot(dir, N);
  if (n < 1e-3 * cellKm * cellKm || abs(dn) < 0.2 * n) return false;
  P = dir * (dot(V0, N) / dn);
  return true;
}

// The drawn surface under `dir`: the point where it pierces the rendered triangle. The mesh is a chord of the
// height field, and on a crest (crater rims, ridges) the chord lies metres below the field at the far rings' cell
// sizes, so a rock set on the field itself hung in the air there. The finest HQ ring holding the point wins;
// a collapsed (zero-area) ring triangle hands over to the next coarser level, the coarse mesh last.
// Collapse (0..1) of ring level k's vertex at `local` onto its parent, as hqRingVertex applies it.
float ringCollapse(int k, vec2 local) {
  float dist = max(abs(local.x - uHQNadirA[k].x), abs(local.y - uHQNadirA[k].y));
  float a = clamp((dist - uHQMorph.x) / (uHQMorph.y - uHQMorph.x), 0.0, 1.0);
  return max(a, 1.0 - uHQBlendA[k]);
}

// Where ring level k's vertex at `local` is drawn, in cell units: an odd vertex fully collapsed onto its parent
// sits on the lower even neighbour (hqRingVertex); until then every vertex keeps its place.
vec2 ringSlid(int k, vec2 local) {
  ivec2 gi = ivec2(uHQOriginA[k]) + ivec2(local + 0.5);
  return local - vec2(gi & 1) * step(1.0, ringCollapse(k, local));
}

// Corner offsets of triangle t (0, 1) of a ring cell. Inner rings split every cell along a-c; the outer ring
// splits like the coarse cell it lies in (hqTerrain.ts), and the four ring cells of one coarse cell share that.
void ringTriangle(int k, vec2 q, int t, out vec2 o0, out vec2 o1, out vec2 o2) {
  ivec2 gi = ivec2(uHQOriginA[k]) + ivec2(q);
  bool bd = k == 0 && (((gi.x >> 1) + (gi.y >> 1)) & 1) == 1;
  if (bd) {
    if (t == 0) { o0 = vec2(0.0); o1 = vec2(1.0, 0.0); o2 = vec2(0.0, 1.0); }
    else { o0 = vec2(1.0, 1.0); o1 = vec2(0.0, 1.0); o2 = vec2(1.0, 0.0); }
  } else if (t == 0) { o0 = vec2(0.0); o1 = vec2(1.0, 0.0); o2 = vec2(1.0, 1.0); }
  else { o0 = vec2(0.0); o1 = vec2(1.0, 1.0); o2 = vec2(0.0, 1.0); }
}

// Signed double area of (a, b, c) in cell units.
float area2(vec2 a, vec2 b, vec2 c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }

vec3 drawnPoint(vec3 dir, float F, vec2 st) {
  vec3 P;
  if (uHQK > 0) {
    // Find the finest ring holding the point first (cheap), then build its triangle: the heavy vertex rule appears
    // once, in a 3-corner loop. Inlined per level it made a shader D3D could not run in time.
    vec2 sa = faceST(uHQFace, dir);
    int kk = -1;
    for (int k = HQ_LEVELS - 1; k >= 0; k--) {
      if (k >= uHQK) continue;
      vec2 loc = (sa + 1.0) / uHQCellSA[k] - uHQOriginA[k];
      if (all(greaterThanEqual(loc, vec2(0.0))) && all(lessThanEqual(loc, vec2(uHQN)))) { kk = k; break; }
    }
    if (kk >= 0) {
      // Where a ring has collapsed onto its parent the drawn triangles are not the grid's: odd corners sit on the
      // even ones, so the point is covered by whichever of the parent cell's 8 triangles holds it after the snap
      // (the upper-right ring cell grows into the whole parent cell, the other three shrink to nothing). The parent
      // cell starts on even ring indices (ring origins are even) and holds all its 9 vertices inside the ring.
      vec2 loc = (sa + 1.0) / uHQCellSA[kk] - uHQOriginA[kk];
      vec2 pc = clamp(floor(loc * 0.5) * 2.0, 0.0, uHQN - 2.0);
      // Where only some corners have snapped, triangles thin to slivers (under 1/20 of a cell): a sliver's corners
      // sit a hand's width apart with slightly different heights, so its plane can lean anywhere, and the rock is
      // better off on the neighbouring triangle's plane a few centimetres away. Slivers only count when nothing
      // else holds the point.
      vec2 q = pc, o0, o1, o2;
      bool found = false;
      for (int pass = 0; pass < 2 && !found; pass++) {
        float minA = pass == 0 ? 0.05 : 1e-3, slack = pass == 0 ? 0.02 : 1e-4;
        for (int i = 0; i < 8 && !found; i++) {
          vec2 sub = pc + vec2(float(i & 1), float((i >> 1) & 1));
          ringTriangle(kk, sub, i >> 2, o0, o1, o2);
          vec2 p0 = ringSlid(kk, sub + o0), p1 = ringSlid(kk, sub + o1), p2 = ringSlid(kk, sub + o2);
          float A = area2(p0, p1, p2);
          if (abs(A) < minA) continue;
          float s = sign(A), e = -slack * abs(A);
          if (s * area2(p0, p1, loc) >= e && s * area2(p1, p2, loc) >= e && s * area2(p2, p0, loc) >= e) { q = sub; found = true; }
        }
      }
      if (!found) {
        // Rounding on a shared edge: the grid triangle holding the point.
        q = clamp(floor(loc), 0.0, uHQN - 1.0);
        vec2 qf = loc - q;
        ivec2 gi = ivec2(uHQOriginA[kk]) + ivec2(q);
        bool bd = kk == 0 && (((gi.x >> 1) + (gi.y >> 1)) & 1) == 1;
        ringTriangle(kk, q, (bd ? qf.x + qf.y <= 1.0 : qf.x >= qf.y) ? 0 : 1, o0, o1, o2);
      }
      vec3 V[3];
      for (int c = 0; c < 3; c++) {
        vec2 off = c == 0 ? o0 : (c == 1 ? o1 : o2);
        float hh;
        V[c] = hqRingVertex(float(kk + 1), ivec2(uHQOriginA[kk]), q + off, uHQNadirA[kk], uHQCellSA[kk], uHQCellKmA[kk], uHQBlendA[kk], hh);
      }
      if (pierce(dir, V[0], V[1], V[2], uHQCellKmA[kk], P)) return P;
    }
  }
  // The coarse mesh quad that owns this point, split as geometry.ts does.
  vec2 g = (st + 1.0) * 0.5 * uSegments;
  vec2 ij = clamp(floor(g), 0.0, uSegments - 1.0);
  vec2 fr = clamp(g - ij, 0.0, 1.0);
  vec3 A = meshVertex(F, ij.x, ij.y);
  vec3 C = meshVertex(F, ij.x + 1.0, ij.y + 1.0);
  vec3 V0, V1, V2;
  if (mod(ij.x + ij.y, 2.0) > 0.5) {
    vec3 B = meshVertex(F, ij.x + 1.0, ij.y), D = meshVertex(F, ij.x, ij.y + 1.0);
    if (fr.x + fr.y <= 1.0) { V0 = A; V1 = B; V2 = D; } else { V0 = B; V1 = C; V2 = D; }
  } else if (fr.x >= fr.y) { V0 = A; V1 = meshVertex(F, ij.x + 1.0, ij.y); V2 = C; }
  else { V0 = A; V1 = C; V2 = meshVertex(F, ij.x, ij.y + 1.0); }
  if (pierce(dir, V0, V1, V2, uVertexSpacing, P)) return P;
  gFootprint = drawnFootprint(dir);
  return groundAt(dir);
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

  float hM = textureLod(tHeight, tc, 0.0).r;
  if (uOcean > 0.5 && hM < 3.0) { gl_FragColor = vec4(0.0); return; }

  // The draw shaders take the rock's existence from texel 0 alone, so each texel does only its own work.
  if (comp == 0) {
    // Where the rock sits: on the drawn triangle under its direction. Judged on the placed point too: the drawn
    // surface and the bilinear heightmap disagree on steep shores.
    vec3 P = drawnPoint(dir, float(face), st);
    if (uOcean > 0.5 && length(P) < uRadius + 0.0005) { gl_FragColor = vec4(0.0); return; }
    gl_FragColor = vec4(P, r);
  } else if (comp == 1) {
    // The slope it sits on: the height field (at the footprint drawn here) a rock diameter either side. Not the
    // triangle's normal: that turns as the ring morphs, and a collapsed triangle has none.
    gFootprint = drawnFootprint(dir);
    vec3 t1 = normalize(cross(dir, abs(dir.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 t2 = cross(dir, t1);
    float e = max(2.0 * r, 0.002) / uRadius;
    vec3 P0 = groundAt(dir);
    vec3 P1 = groundAt(normalize(dir + t1 * e));
    vec3 P2 = groundAt(normalize(dir + t2 * e));
    vec3 Nt = normalize(cross(P1 - P0, P2 - P0));
    if (dot(Nt, dir) < 0.0) Nt = -Nt;
    gl_FragColor = vec4(Nt, h2.y);
  } else {
    float sh = dot(dir, uSunDir) > -0.05 ? terrainShadow(dir, uSunDir) : 0.0;
    gl_FragColor = vec4(float(layer) + 0.99 * sh, h2.z, 0.0, 0.0);
  }
}
