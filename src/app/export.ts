import type { PlanetData } from '../core/types.ts';
import { LAYERS } from '../core/types.ts';

/**
 * Single-file planet export for engine import (".planet").
 * Layout: magic "PLNT" | u32 version | u32 headerBytes | JSON header (utf-8) | padding to 16 | blobs.
 * Each blob is described in header.blobs with byte offset (from file start), length, dtype and shape.
 */
export function exportPlanet(planet: PlanetData, meta: Record<string, unknown>): Blob {
  const blobs: { name: string; data: ArrayBufferView; dtype: string; shape: number[] }[] = [
    { name: 'height', data: planet.height, dtype: 'f32', shape: [6, planet.T, planet.T] },
    { name: 'splat0', data: planet.splat0, dtype: 'u8', shape: [6, planet.T, planet.T, 4] },
    { name: 'splat1', data: planet.splat1, dtype: 'u8', shape: [6, planet.T, planet.T, 4] },
    { name: 'climate', data: planet.climate, dtype: 'u8', shape: [6, planet.T, planet.T, 4] },
    { name: 'clouds', data: planet.clouds, dtype: 'u8', shape: [6, planet.cloudN + 2, planet.cloudN + 2] },
  ];
  const align = (n: number) => (n + 15) & ~15;
  const descr: Record<string, { offset: number; bytes: number; dtype: string; shape: number[] }> = {};
  const header = {
    format: 'planet-forge',
    version: 1,
    faceOrder: ['+X', '-X', '+Y', '-Y', '+Z', '-Z'],
    mapping: 'tan-warped cube sphere, 1-texel gutter, see CONTRACT.md',
    N: planet.N,
    T: planet.T,
    radiusM: planet.radius,
    minHeight: planet.minHeight,
    maxHeight: planet.maxHeight,
    layers: LAYERS,
    cloudN: planet.cloudN,
    meta,
    blobs: descr,
  };
  // Two passes: header size depends on offsets, so reserve generously.
  let headerText = '';
  let start = 0;
  for (let pass = 0; pass < 2; pass++) {
    headerText = JSON.stringify(header);
    start = align(12 + new TextEncoder().encode(headerText).length + 256);
    let off = start;
    for (const b of blobs) {
      descr[b.name] = { offset: off, bytes: b.data.byteLength, dtype: b.dtype, shape: b.shape };
      off = align(off + b.data.byteLength);
    }
  }
  headerText = JSON.stringify(header);
  const headerBytes = new TextEncoder().encode(headerText);
  const pre = new Uint8Array(start);
  const dv = new DataView(pre.buffer);
  pre.set([0x50, 0x4c, 0x4e, 0x54]);
  dv.setUint32(4, 1, true);
  dv.setUint32(8, headerBytes.length, true);
  pre.set(headerBytes, 12);
  for (let i = 12 + headerBytes.length; i < start; i++) pre[i] = 0x20;
  const parts: BlobPart[] = [pre];
  let pos = start;
  for (const b of blobs) {
    const off = descr[b.name].offset;
    if (off > pos) parts.push(new Uint8Array(off - pos));
    parts.push(new Uint8Array(b.data.buffer as ArrayBuffer, b.data.byteOffset, b.data.byteLength));
    pos = off + b.data.byteLength;
  }
  return new Blob(parts, { type: 'application/octet-stream' });
}

export function download(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
