// Web Worker entry: runs one pure pipeline stage per message and transfers the result buffers back.

import { stageCube, stageSurfaceFace, stageTerrainFace } from './pipeline.ts';
import type { CubeStageInput, SurfaceSlices } from './pipeline.ts';
import type { GenParams } from './params.ts';

export type WorkerRequest =
  | { id: number; kind: 'terrain'; p: GenParams; face: number }
  | { id: number; kind: 'cube'; p: GenParams; input: CubeStageInput }
  | { id: number; kind: 'surface'; p: GenParams; face: number; slices: SurfaceSlices };

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
  | { id: number; progress: [string, number] };

const ctx = self as unknown as {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
};

function buffersOf(o: object): Transferable[] {
  const out: Transferable[] = [];
  for (const v of Object.values(o)) if (ArrayBuffer.isView(v)) out.push(v.buffer as ArrayBuffer);
  return out;
}

ctx.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const m = e.data;
  try {
    if (m.kind === 'terrain') {
      const r = stageTerrainFace(m.p, m.face);
      ctx.postMessage({ id: m.id, ok: true, result: r }, buffersOf(r));
    } else if (m.kind === 'cube') {
      const r = stageCube(m.input, m.p, (stage, frac) => ctx.postMessage({ id: m.id, progress: [stage, frac] }));
      ctx.postMessage({ id: m.id, ok: true, result: r }, buffersOf(r));
    } else {
      const r = stageSurfaceFace(m.p, m.face, m.slices);
      ctx.postMessage({ id: m.id, ok: true, result: r }, buffersOf(r));
    }
  } catch (err) {
    ctx.postMessage({ id: m.id, ok: false, error: err instanceof Error ? `${err.message}\n${err.stack}` : String(err) });
  }
};
