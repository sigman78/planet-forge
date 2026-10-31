// HQ terrain height probe: the surface radius (km) the rings draw under one direction, for the camera ground clamp.
// One pixel, read back asynchronously.
uniform vec3 uProbeDir;
uniform float uProbeFp;   // footprint of the finest ring at the probe point (km)

void main() {
  vec3 d = normalize(uProbeDir);
  gFootprint = uProbeFp;
  float h = bakedHeightM(d);
  float hM = h + detailM(d, h) + fineReliefM(d, h);
  gl_FragColor = vec4(uRadius + elevationKm(hM), 0.0, 0.0, 1.0);
}
