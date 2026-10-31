// HQ terrain rings: the vertex rule shared by the ring meshes (terrain_hq.vert.glsl), the rock placement and anything
// else that must sit exactly on the drawn surface. Needs terrain_common.glsl and terrain_fine.glsl.
//
// Each ring level is a grid of integer points in the anchor face's extended grid, `cellS` grid units apart, anchored
// to the ground (snapped origins, never crawling). Toward its outer edge a ring morphs onto its parent: inner rings
// slide their odd vertices onto the even ones and take the parent's footprint, so at the edge they are exactly the
// parent mesh; the outermost ring collapses onto the coarse mesh vertices.
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
vec3 hqRingVertex(float level, ivec2 origin, vec2 local, vec2 nadir, float cellS, float cellKm, float blend, out float hM) {
  ivec2 gi = origin + ivec2(local + 0.5);
  float dist = max(abs(local.x - nadir.x), abs(local.y - nadir.y));
  float a = clamp((dist - uHQMorph.x) / (uHQMorph.y - uHQMorph.x), 0.0, 1.0);
  a = max(a, 1.0 - blend);
  // Odd grid indices slide toward the lower even neighbour; the footprint grows to the parent's. Collapsed cells
  // are zero-area triangles, so a morphed band costs no shading. The outer ring collapses onto the coarse vertices.
  vec2 odd = vec2(gi & 1);
  vec2 g = vec2(gi) - odd * a;
  vec3 d = faceDir(uHQFace, vec2(-1.0) + g * cellS);
  gFootprint = 2.0 * cellKm * (1.0 + a);   // at a = 1 on the outer ring: the coarse vertex footprint
  hM = hqHeightM(d);
  return d * (uRadius + elevationKm(hM));
}
