// Fine procedural relief (detail octaves 3-7) as a height, for geometry that resolves it (the HQ terrain rings).
// Mirror of the fine-style prologue in terrain.frag.glsl main() and the fine branch of detailGrad(): same style,
// masks and amplitudes, so the drawn shape matches the analytic normal the fragment paints. Keep the two in sync.
// The fragment shader is deliberately left alone: on D3D small edits to it changed its compiled cost a lot.
// Vertex-side differences: textures at LOD 0, octaves faded by the mesh footprint (gFootprint) instead of the pixel's.
uniform sampler2DArray tSplat0;
uniform sampler2DArray tSplat1;
uniform sampler2DArray tGrad;
uniform vec4  uLayerStyle[8];
uniform float uFinePits;
uniform vec3  uWindAxis;
uniform float uWindAniso;
uniform float uFineDetail;

vec4 fineOctaveStyle(vec4 st, float crackM, float pitM) {
  float dz = st.z * (1.0 - crackM), dw = st.w * (1.0 - pitM);
  return vec4(st.x + 0.25 * dw, st.y + 0.5 * dz + 0.25 * dw, st.z - dz, st.w - dw);
}

// Height (metres) of the fine octaves at unit direction d over baked height h.
float fineReliefM(vec3 d, float h) {
  if (uDetailAmp <= 0.0 || uFineDetail <= 0.0) return 0.0;
  float s3 = uDetailScale / (DETAIL_STEP * DETAIL_STEP * DETAIL_STEP);
  if (octaveFade(s3) <= 0.0) return 0.0;   // the mesh cannot carry even the coarsest fine octave
  // Frozen sea: flat ice, no fine geometry (the clamp to the datum would rectify plates into bumps).
  float iceK = uSeaIce * (1.0 - smoothstep(-1.0, 3.0, h));
  if (iceK >= 1.0) return 0.0;

  vec3 tc = cubeTexCoord(d, uN);
  vec4 s0 = textureLod(tSplat0, tc, 0.0);
  vec4 s1 = textureLod(tSplat1, tc, 0.0);
  float w[8] = float[8](s0.r, s0.g, s0.b, s0.a, s1.r, s1.g, s1.b, s1.a);
  if (iceK > 0.0) for (int i = 0; i < 8; i++) w[i] = mix(w[i], i == 6 ? 1.0 : 0.0, iceK);
  vec3 Gh = textureLod(tGrad, tc, 0.0).xyz * uHeightScale * mix(uSeaFloorScale, 1.0, smoothstep(-40.0, 40.0, h));
  Gh *= 1.0 - iceK;
  Gh -= dot(Gh, d) * d;

  vec4 fineStyle = vec4(0.0);
  for (int i = 0; i < 8; i++) fineStyle += w[i] * uLayerStyle[i];
  fineStyle.w *= uFinePits;
  float duneAniso = uWindAniso * w[3];
  float slope = length(Gh);
  float flatK = 1.0 - smoothstep(0.08, 0.3, slope);
  float steep = smoothstep(0.3, 0.6, slope);
  float macro = fbm3(d * 9.0) + 0.5 * fbm3(d * 37.0) * octaveFade(uRadius / 37.0 * 0.25);
  float region = snoise(d * (uRadius / 30.0) + 11.3);
  float region2 = 0.7 * snoise(d * (uRadius / 12.0) + 5.1) + 0.3 * snoise(d * (uRadius / 4.0) + 2.7);
  {
    float cz = fineStyle.z;
    float field = 0.35 + 0.95 * smoothstep(-0.5, 0.6, region + 0.3 * macro);
    fineStyle.z = cz * field * flatK;
    fineStyle.x += cz * (1.0 - flatK);
    fineStyle.y += max(cz * flatK - fineStyle.z, 0.0);
    fineStyle.x += 0.4 * steep;
  }
  fineStyle /= max(fineStyle.x + fineStyle.y + fineStyle.z + fineStyle.w, 1e-4);
  float fineAmp = (0.15 + 1.1 * smoothstep(-0.35, 0.45, region2)) * (1.0 + 0.4 * steep);

  float fineM = (h < 0.0 ? 0.3 : mix(0.5, 1.4, smoothstep(300.0, 5000.0, h))) * uFineDetail * fineAmp;
  float rr = 0.5 + 0.5 * region;
  float crackM[5] = float[5](mix(1.0, 0.4, rr), mix(0.6, 1.0, rr), 0.15, 0.0, 0.0);
  const float PIT_M[5] = float[5](1.0, 1.0, 0.7, 0.3, 0.0);
  float a = 0.4;
  float s = s3;
  float sum = 0.0;
  for (int k = 3; k < 8; k++) {
    float f = octaveFade(s);
    if (f <= 0.0) break;
    int j = k - 3;
    vec4 st = fineOctaveStyle(fineStyle, crackM[j], PIT_M[j]);
    // Crack troughs (~0.16 s wide) need a few cells: coarser meshes get the billowy swap the normals get far away.
    float cf = 1.0 - smoothstep(0.035, 0.09, gFootprint / s);
    st.y += st.z * (1.0 - cf);
    st.z *= cf;
    vec3 g;
    vec3 q = d * (uRadius / s) + float(k) * 17.3;
    q -= duneAniso * dot(q, uWindAxis) * uWindAxis;   // dune trains across the wind, as in terrain.frag.glsl
    float v = k < 6 ? styleOct(q, st, g) : styleOctSmooth(q, st, 0.05, g);
    sum += a * f * v;
    a *= 0.38;
    s /= DETAIL_STEP;
  }
  return sum * fineM * uDetailAmp * (1.0 - iceK);
}
