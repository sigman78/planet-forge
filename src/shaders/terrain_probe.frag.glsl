// HQ terrain height probe: the surface radius (km) the rings draw under a set of directions (one per pixel), for
// the camera's ground clamp and its look-ahead. Read back asynchronously.
uniform vec3 uProbeDir[PROBE_N];
uniform float uProbeFp;   // footprint of the finest ring at the probe points (km)

void main() {
  int i = clamp(int(gl_FragCoord.x), 0, PROBE_N - 1);
  vec3 d = normalize(uProbeDir[i]);
  gFootprint = uProbeFp;
  float h = bakedHeightM(d);
  float hM = h + detailM(d, h) + fineReliefM(d, h);
  gl_FragColor = vec4(uRadius + elevationKm(hM), 0.0, 0.0, 1.0);
}
