import * as THREE from 'three';
import { FACE_BASIS } from '../core/cube.ts';

/**
 * Unit cube-sphere mesh: 6 face grids with `segments` quads per side, laid out on the same tan-warped
 * grid as the data textures. Positions are unit directions; the vertex shader displaces them.
 * Edge vertices are snapped so adjacent faces share bit-identical positions (no cracks).
 */
export function createCubeSphereGeometry(segments: number): THREE.BufferGeometry {
  const vertsPerFace = (segments + 1) * (segments + 1);
  const positions = new Float32Array(vertsPerFace * 6 * 3);
  const faceIds = new Float32Array(vertsPerFace * 6);
  const indexCount = segments * segments * 6 * 6;
  const indices = vertsPerFace * 6 > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);

  // Pre-compute warped coordinates once, snapping the ends to exactly +-1.
  const warped = new Float64Array(segments + 1);
  for (let i = 0; i <= segments; i++) {
    const s = -1 + (2 * i) / segments;
    warped[i] = i === 0 ? -1 : i === segments ? 1 : Math.tan((s * Math.PI) / 4);
  }

  let v = 0;
  let k = 0;
  for (let f = 0; f < 6; f++) {
    const { n, u, v: vb } = FACE_BASIS[f];
    const base = v;
    for (let j = 0; j <= segments; j++) {
      for (let i = 0; i <= segments; i++) {
        const cu = warped[i];
        const cv = warped[j];
        const x = n[0] + cu * u[0] + cv * vb[0];
        const y = n[1] + cu * u[1] + cv * vb[1];
        const z = n[2] + cu * u[2] + cv * vb[2];
        const inv = 1 / Math.hypot(x, y, z);
        positions[v * 3] = x * inv;
        positions[v * 3 + 1] = y * inv;
        positions[v * 3 + 2] = z * inv;
        faceIds[v] = f;
        v++;
      }
    }
    const row = segments + 1;
    for (let j = 0; j < segments; j++) {
      for (let i = 0; i < segments; i++) {
        const a = base + j * row + i;
        const b = a + 1;
        const c = a + row + 1;
        const d = a + row;
        // Alternate the diagonal to reduce directional artifacts.
        if ((i + j) & 1) {
          indices[k++] = a; indices[k++] = b; indices[k++] = d;
          indices[k++] = b; indices[k++] = c; indices[k++] = d;
        } else {
          indices[k++] = a; indices[k++] = b; indices[k++] = c;
          indices[k++] = a; indices[k++] = c; indices[k++] = d;
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('faceId', new THREE.BufferAttribute(faceIds, 1));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  // Generous bounds: displacement happens in the shader.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.1);
  return geo;
}
