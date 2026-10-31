// Rock cast shadows as ground decals: one quad per rock in the plane of its mesh triangle, stretched away from
// the sun by the sun's elevation, multiplied into the lit terrain (dst *= src).
#define GRID 96
uniform sampler2D tRock;
uniform float uReach;
uniform vec3 uViewPos;
uniform mat4 uNearShadowVP;
uniform float uNearShadow;

varying vec2 vQuad;        // x across, y along the shadow (0 at the rock, 1 at the tip)
varying float vStrength;

void main() {
  ivec2 b = ivec2((gl_InstanceID % GRID) * 3, gl_InstanceID / GRID);
  vec4 t0 = texelFetch(tRock, b, 0);
  vec4 t1 = texelFetch(tRock, b + ivec2(1, 0), 0);
  vec4 t2 = texelFetch(tRock, b + ivec2(2, 0), 0);
  vec3 P = t0.xyz;
  float r = t0.w;
  float px = r / max(length(uViewPos - P) * uPixelAngle, 1e-9);
  float reach = acos(clamp(dot(normalize(P), normalize(uViewPos)), -1.0, 1.0)) * uRadius / uReach;
  r *= smoothstep(0.8, 2.0, px) * (1.0 - smoothstep(0.7, 1.0, reach));
  vec3 up = normalize(t1.xyz);
  float sunUp = dot(uSunDir, up);
  vec3 Lt = uSunDir - up * sunUp;
  float lt = length(Lt);
  float sh = fract(t2.x) / 0.99;   // already in terrain shadow: nothing to add
  if (r <= 0.0 || sunUp <= 0.02 || lt < 1e-4 || sh <= 0.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  Lt /= lt;
  vec3 across = cross(up, Lt);
  // Shadow length from the block height (~0.6 r) and the sun elevation, capped for grazing light.
  float len = r * (0.7 + min(0.6 * lt / sunUp, 6.0));
  vec2 q = position.xy;   // plane geometry in [-1, 1]
  float along = q.y * 0.5 + 0.5;
  vec3 wp = P + across * q.x * r * 1.05 - Lt * (along * len - 0.45 * r) + up * (0.03 * r);
  vQuad = vec2(q.x, along);
  vStrength = sh * smoothstep(0.02, 0.12, sunUp) * clamp(dot(normalize(P), uSunDir) * 8.0, 0.0, 1.0);
  // Inside the near shadow map the block's real shadow is drawn; the decal stands down there.
  vec4 sc = uNearShadowVP * vec4(P, 1.0);
  vec2 suv = sc.xy / sc.w * 0.5 + 0.5;
  vec2 sm = min(suv, 1.0 - suv);
  vStrength *= 1.0 - 0.5 * uNearShadow * smoothstep(0.0, 0.04, min(sm.x, sm.y));
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}

//#FRAGMENT
varying vec2 vQuad;
varying float vStrength;

void main() {
  // Tapered, soft-ended streak: dark next to the block, fading and narrowing toward the tip.
  float d = vQuad.y;
  float w = abs(vQuad.x) / mix(1.0, 0.45, d);
  float s = (1.0 - smoothstep(0.55, 1.0, w)) * (1.0 - smoothstep(0.5, 1.0, d)) * smoothstep(0.0, 0.12, d);
  gl_FragColor = vec4(vec3(1.0 - 0.75 * s * vStrength), 1.0);
}
