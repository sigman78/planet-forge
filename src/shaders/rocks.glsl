// Surface rocks: instanced lumpy blocks placed by rocks_place.frag.glsl, lit like the terrain.
#define GRID 96
uniform sampler2D tRock;
uniform float uReach;    // km from the camera's nadir to the window edge: blocks shrink away toward it
uniform vec3 uViewPos;   // the viewing camera (cameraPosition is the sun's when the near shadow map renders)

varying vec3 vWorldPos;
varying vec3 vLocal;     // shape space (unit rock), y up
varying vec3 vOffset;    // world-oriented offset from the rock's base, unit rock scale (small numbers: precise derivatives)
varying float vRadiusM;
varying float vLayer;
varying float vShadow;
varying float vSeed;

void main() {
  ivec2 b = ivec2((gl_InstanceID % GRID) * 3, gl_InstanceID / GRID);
  vec4 t0 = texelFetch(tRock, b, 0);
  vec4 t1 = texelFetch(tRock, b + ivec2(1, 0), 0);
  vec4 t2 = texelFetch(tRock, b + ivec2(2, 0), 0);
  vec3 P = t0.xyz;
  float r = t0.w;
  // Blocks under ~1.5 px would only shimmer: shrink them away. Toward the window edge they shrink away too, by
  // their ground distance from the camera's nadir, so the edge moves with the camera and never with its heading.
  float px = r / max(length(uViewPos - P) * uPixelAngle, 1e-9);
  float reach = acos(clamp(dot(normalize(P), normalize(uViewPos)), -1.0, 1.0)) * uRadius / uReach;
  r *= smoothstep(0.8, 2.0, px) * (1.0 - smoothstep(0.7, 1.0, reach));
  if (r <= 0.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);   // outside the clip volume
    return;
  }
  vec3 up = normalize(t1.xyz);
  float seed = t1.w;
  float yaw = seed * 6.2831853;
  vec3 tx = normalize(cross(up, abs(up.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 tz = cross(tx, up);
  vec3 ax = cos(yaw) * tx + sin(yaw) * tz;
  vec3 az = -sin(yaw) * tx + cos(yaw) * tz;
  // Per-rock shape: lumpy, elongated, flattened, with a flat underside sunk a little into the ground.
  vec3 q = position;
  q *= 1.0 + 0.3 * snoise(q * 1.4 + seed * 91.7);
  q *= vec3(0.9 + 0.6 * fract(seed * 13.17), 0.45 + 0.45 * fract(seed * 7.31), 0.8 + 0.4 * fract(seed * 3.93));
  q.y = max(q.y, -0.3);
  vec3 off = ax * q.x + up * (q.y + 0.15) + az * q.z;
  vec3 wp = P + off * r;
  vWorldPos = wp;
  vOffset = off;
  vLocal = q;
  vRadiusM = r * 1000.0;
  vLayer = floor(t2.x);
  vShadow = fract(t2.x) / 0.99;
  vSeed = t2.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}

//#FRAGMENT
#define LAYERS 8
uniform sampler2DArray tAlbedo;
uniform vec3  uLayerTint[LAYERS];
uniform vec3  uLayerMean[LAYERS];
uniform float uRockTile;   // texture tiles per metre on the rocks (real scale)
uniform float uAmbient;
uniform vec3  uSkyAmbient;
uniform vec3  uFillDir;
uniform vec3  uFillColor;

varying vec3 vWorldPos;
varying vec3 vLocal;
varying vec3 vOffset;
varying float vRadiusM;
varying float vLayer;
varying float vShadow;
varying float vSeed;

void main() {
  // Faceted blocks: the flat triangle normal reads as fractured stone. Taken from the rock-relative offset: world
  // positions are ~1e3 km, where float steps (cm) exceed the pixel-to-pixel change up close and the normal shimmers.
  vec3 N = normalize(cross(dFdx(vOffset), dFdy(vOffset)));
  vec3 V = normalize(cameraPosition - vWorldPos);
  if (dot(N, V) < 0.0) N = -N;
  vec3 n = normalize(vWorldPos);

  // Triplanar texture in rock space at real scale, from the layer the rock came from.
  vec3 Nl = normalize(cross(dFdx(vLocal), dFdy(vLocal)));
  vec3 bw = pow(abs(Nl), vec3(4.0));
  bw /= bw.x + bw.y + bw.z;
  vec3 p = vLocal * vRadiusM * uRockTile + vSeed * 17.0;
  float L = vLayer;
  vec3 tex = texture(tAlbedo, vec3(p.yz, L)).rgb * bw.x + texture(tAlbedo, vec3(p.xz, L)).rgb * bw.y
           + texture(tAlbedo, vec3(p.xy, L)).rgb * bw.z;
  vec3 tint = uLayerTint[0], mean = uLayerMean[0];
  for (int i = 1; i < LAYERS; i++) if (float(i) == L) { tint = uLayerTint[i]; mean = uLayerMean[i]; }
  // Blocks are fresher than the regolith around them: a little brighter.
  vec3 albedo = tex * tint * (1.0 + 0.4 * vSeed);

  // Contact occlusion: the base of a block sits in its own shadow and in the ground's.
  float occ = mix(0.45, 1.0, smoothstep(-0.3, 0.15, vLocal.y));
  vec3 Ls = uSunDir;
  float horizon = smoothstep(-0.02, 0.06, dot(n, Ls));
  vec3 sunCol = sunLightAt(vWorldPos);
  float shadow = vShadow * nearShadow(vWorldPos, N);
  vec3 col = brdf(albedo, 0.85, 0.0, N, V, Ls) * sunCol * horizon * shadow * mix(0.6, 1.0, occ);
  // Bounce from the sunlit ground around the block: without air it is the only light on the shadowed faces.
  float groundLit = max(dot(n, Ls), 0.0) * horizon * shadow;
  col += albedo * tint * mean * sunCol * groundLit * (0.55 - 0.45 * dot(N, n)) * occ / PI;
  float dayAmb = smoothstep(-0.25, 0.3, dot(n, Ls));
  col += albedo * occ * (uSkyAmbient * dayAmb + vec3(uAmbient)) * (0.6 + 0.4 * dot(N, n));
  float fillW = clamp(dot(N, uFillDir) * 0.6 + 0.4, 0.0, 1.0) * clamp(dot(n, uFillDir) * 0.5 + 0.6, 0.0, 1.0);
  col += albedo * occ * uFillColor * fillW / PI;
  gl_FragColor = vec4(col, 1.0);
}
