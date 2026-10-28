// Reusable Web Worker pool for the generator. Jobs carry a generation number; when a newer generation starts,
// workers still busy with older jobs are terminated and respawned (JS running in a worker cannot be interrupted
// otherwise), so slider spam never queues stale work.

import type { PlanetData } from '../core/types.ts';
import type { GenParams } from './params.ts';
import { assembleCube, assemblePlanet, finalizeSurface, now, surfaceSlices, worldPlan } from './pipeline.ts';
import type { CubeStageInput, CubeStageOutput, SurfaceSlices } from './pipeline.ts';
import type { SurfaceFaceOutput } from './surface.ts';
import type { FaceTerrain } from './terrain.ts';
import type { WorkerResponse } from './worker.ts';

type Req =
  | { kind: 'terrain'; p: GenParams; face: number }
  | { kind: 'cube'; p: GenParams; input: CubeStageInput }
  | { kind: 'surface'; p: GenParams; face: number; slices: SurfaceSlices };

interface Job {
  id: number;
  gen: number;
  msg: Req;
  transfer: Transferable[];
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (stage: string, frac: number) => void;
}

interface Slot { w: Worker; job: Job | null }

export function workersAvailable(): boolean {
  return typeof Worker !== 'undefined' && typeof window !== 'undefined';
}

class Pool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private nextId = 1;
  private currentGen = 0;
  private size: number;

  constructor(size: number) {
    this.size = size;
  }

  private spawn(): Slot {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const slot: Slot = { w, job: null };
    w.onmessage = (e: MessageEvent<WorkerResponse>) => this.onMessage(slot, e.data);
    w.onerror = (e) => {
      const job = slot.job;
      slot.job = null;
      job?.reject(new Error(`generator worker error: ${e.message}`));
      this.pump();
    };
    return slot;
  }

  private onMessage(slot: Slot, m: WorkerResponse): void {
    const job = slot.job;
    if (!job || job.id !== m.id) return;
    if ('progress' in m) { job.onProgress?.(m.progress[0], m.progress[1]); return; }
    slot.job = null;
    if (m.ok) job.resolve(m.result); else job.reject(new Error(m.error));
    this.pump();
  }

  private pump(): void {
    while (this.slots.length < this.size) this.slots.push(this.spawn());
    for (const slot of this.slots) {
      if (slot.job || this.queue.length === 0) continue;
      const job = this.queue.shift()!;
      slot.job = job;
      slot.w.postMessage({ ...job.msg, id: job.id }, job.transfer);
    }
  }

  /** Reject every job older than `gen`; busy workers running them are terminated and respawned. */
  cancelBefore(gen: number, err: () => Error): void {
    if (gen > this.currentGen) this.currentGen = gen;
    this.queue = this.queue.filter((j) => {
      if (j.gen < gen) { j.reject(err()); return false; }
      return true;
    });
    this.slots.forEach((slot, i) => {
      if (slot.job && slot.job.gen < gen) {
        const job = slot.job;
        slot.w.terminate();
        this.slots[i] = this.spawn();
        job.reject(err());
      }
    });
    this.pump();
  }

  run<T>(gen: number, msg: Req, transfer: Transferable[], err: () => Error, onProgress?: (stage: string, frac: number) => void): Promise<T> {
    if (gen < this.currentGen) return Promise.reject(err());
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ id: this.nextId++, gen, msg, transfer, resolve: resolve as (v: unknown) => void, reject, onProgress });
      this.pump();
    });
  }
}

let pool: Pool | null = null;
let genCounter = 0;

function getPool(): Pool {
  if (!pool) {
    const hc = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
    pool = new Pool(Math.max(2, Math.min(6, hc - 1)));
  }
  return pool;
}

function buffers(o: object): Transferable[] {
  const out: Transferable[] = [];
  for (const v of Object.values(o)) if (ArrayBuffer.isView(v)) out.push(v.buffer as ArrayBuffer);
  return out;
}

/** Generation on the worker pool. Same stage functions as the sync pipeline, so results are identical. */
export async function generateInWorkers(
  p: GenParams, onProgress: ((stage: string, frac: number) => void) | undefined, cancelled: () => boolean, abortError: () => Error,
  signal?: AbortSignal,
): Promise<PlanetData> {
  const pl = getPool();
  const gen = ++genCounter;
  pl.cancelBefore(gen, abortError);
  const onAbort = () => pl.cancelBefore(gen + 1, abortError);
  signal?.addEventListener('abort', onAbort, { once: true });
  const check = () => {
    if (cancelled()) { pl.cancelBefore(gen + 1, abortError); throw abortError(); }
  };
  try {
    const N = p.resolution;
    const T = N + 2;
    const timings: Record<string, number> = {};
    const tAll = now();
    let t0 = now();
    const plan = worldPlan(p);
    timings.plan = now() - t0;

    t0 = now();
    let done = 0;
    const faces = await Promise.all([0, 1, 2, 3, 4, 5].map((face) =>
      pl.run<FaceTerrain>(gen, { kind: 'terrain', p, face }, [], abortError).then((r) => { onProgress?.('terrain', ++done / 6); return r; })));
    check();
    const featA = assembleCube(faces.map((f) => f.featA), (k) => new Uint8Array(k));
    const featB = assembleCube(faces.map((f) => f.featB), (k) => new Uint8Array(k));
    const vkind = assembleCube(faces.map((f) => f.vkind), (k) => new Uint8Array(k));
    const input: CubeStageInput = {
      height: assembleCube(faces.map((f) => f.height), (k) => new Float32Array(k)),
      young: assembleCube(faces.map((f) => f.young), (k) => new Float32Array(k)),
      vkind: vkind.slice(),
    };
    timings.terrain = now() - t0;

    t0 = now();
    const cube = await pl.run<CubeStageOutput>(gen, { kind: 'cube', p, input }, buffers(input), abortError, onProgress);
    check();
    Object.assign(timings, cube.timings);
    timings.cube = now() - t0;

    t0 = now();
    done = 0;
    const surf = await Promise.all([0, 1, 2, 3, 4, 5].map((face) => {
      const slices = surfaceSlices(N, face, cube, featA, featB, vkind);
      return pl.run<SurfaceFaceOutput>(gen, { kind: 'surface', p, face, slices }, buffers(slices), abortError)
        .then((r) => { onProgress?.('surface', ++done / 6); return r; });
    }));
    check();
    const splat0 = new Uint8Array(6 * T * T * 4);
    const splat1 = new Uint8Array(6 * T * T * 4);
    const climate = new Uint8Array(6 * T * T * 4);
    surf.forEach((r, f) => {
      splat0.set(r.splat0, f * T * T * 4);
      splat1.set(r.splat1, f * T * T * 4);
      climate.set(r.climate, f * T * T * 4);
    });
    finalizeSurface(splat0, splat1, climate, N);
    timings.surface = now() - t0;
    timings.total = now() - tAll;
    return assemblePlanet(p, plan, cube, splat0, splat1, climate, timings);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
