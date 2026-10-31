// HQ terrain rings: the vertex rule shared by the ring meshes (terrain_hq.vert.glsl), the rock placement and anything
// else that must sit exactly on the drawn surface. Needs terrain_common.glsl and terrain_fine.glsl.
//
// Each ring level is a grid of integer points in the anchor face's extended grid, `cellS` grid units apart, anchored
// to the ground (snapped origins, never crawling). Toward its outer edge a ring morphs onto its parent: odd vertices
// blend their height onto the parent's edges and every vertex takes the parent's footprint, so at the edge a ring is
// exactly the parent mesh; the outermost ring's parent is the coarse mesh.
uniform float uVertexSpacing;  // km between coarse mesh vertices
uniform float uHQFace;         // anchor face
uniform vec2  uHQMorph;        // morph band: box distance from the nadir (cells) where it starts and ends

// Full height of the HQ surface: baked + landform octaves + fine octaves, all faded by gFootprint.
float hqHeightM(vec3 d) {
  float h = bakedHeightM(d);
  return h + detailM(d, h) + fineReliefM(d, h);
}

// Ring vertex at local grid point `local` (integer valued) of a level whose local (0, 0) is grid index `origin`.
// `nadir` is the camera nadir in the level's cells relative to the origin; `blend` fades the level in (0 = parent).
// Across the morph band an odd vertex keeps its place and blends its height onto the parent's edge (the chord
// between its two even neighbours, at the parent's footprint), so nothing crawls sideways as the band moves with
// the camera. Once fully the parent it snaps onto the lower even neighbour instead: the cells between collapse to
// zero-area triangles that cost no shading, and the rest tile the parent's triangles, the same surface either way.
vec3 hqRingVertex(float level, ivec2 origin, vec2 local, vec2 nadir, float cellS, float cellKm, float blend, out float hM) {
  ivec2 gi = origin + ivec2(local + 0.5);
  float dist = max(abs(local.x - nadir.x), abs(local.y - nadir.y));
  float a = clamp((dist - uHQMorph.x) / (uHQMorph.y - uHQMorph.x), 0.0, 1.0);
  a = max(a, 1.0 - blend);
  ivec2 odd = gi & 1;
  vec3 p;
  if (a >= 1.0) {
    vec3 d = faceDir(uHQFace, vec2(-1.0) + vec2(gi - odd) * cellS);
    gFootprint = 4.0 * cellKm;   // the parent's (on the outer ring: the coarse vertex footprint)
    hM = hqHeightM(d);
    p = d * (uRadius + elevationKm(hM));
  } else {
    vec3 d = faceDir(uHQFace, vec2(-1.0) + vec2(gi) * cellS);
    gFootprint = 2.0 * cellKm * (1.0 + a);
    hM = hqHeightM(d);
    p = d * (uRadius + elevationKm(hM));
  }
  if (a > 0.0 && a < 1.0 && odd.x + odd.y > 0) {
    // The parent edge this vertex lies on: a cell side, or the cell's diagonal (a-c in the rings, the coarse
    // cell's own on the outer ring).
    ivec2 n = odd;
    if (odd.x + odd.y == 2) n = level < 1.5 && (((gi.x >> 1) + (gi.y >> 1)) & 1) == 1 ? ivec2(1, -1) : ivec2(1, 1);
    gFootprint = 4.0 * cellKm;
    vec3 d1 = faceDir(uHQFace, vec2(-1.0) + vec2(gi - n) * cellS);
    vec3 d2 = faceDir(uHQFace, vec2(-1.0) + vec2(gi + n) * cellS);
    float h1 = hqHeightM(d1), h2 = hqHeightM(d2);
    vec3 pm = 0.5 * (d1 * (uRadius + elevationKm(h1)) + d2 * (uRadius + elevationKm(h2)));
    p = mix(p, pm, a);
    hM = mix(hM, 0.5 * (h1 + h2), a);
  }
  return p;
}
