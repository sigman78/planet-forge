// Public generator API.
//   generatePlanet(params, { onProgress, signal }) -> Promise<PlanetData>
// Runs the pure pipeline stages (pipeline.ts) on a worker pool when Web Workers are available, otherwise on the
// calling thread (yielding between stages). The newest request wins: starting a new generation aborts the previous one.

import type { PlanetData } from '../core/types.ts';
import { resolveParams } from './params.ts';
import type { GenParams } from './params.ts';
import { pipelineSteps } from './pipeline.ts';
import type { ProgressFn } from './pipeline.ts';
import { generateInWorkers, workersAvailable } from './pool.ts';

export { DEFAULT_PARAMS, GEN_PRESETS, PARAM_SCHEMA, ARCHETYPE_LABELS, ARCHETYPE_FAMILIES, AUTO, presetParams, resolveParams } from './params.ts';
export type { Archetype, GenParams, ParamSchemaEntry } from './params.ts';
export { GEO_UNITS } from './world.ts';
export { LAYER_ALBEDO, LAYER_COLORS } from './preview.ts';

export interface GenerateOptions {
  onProgress?: (stage: string, frac: number) => void;
  signal?: AbortSignal;
  /** Force main-thread generation (debugging). */
  mainThread?: boolean;
}

let generation = 0;

function abortError(): Error {
  const e = new Error('Generation aborted');
  e.name = 'AbortError';
  return e;
}

/**
 * Generate a planet. Deterministic for a given seed + params. Rejects with an `AbortError` when `signal` aborts or a
 * newer `generatePlanet` call starts. Accepts `onProgress` directly as the second argument too (CONTRACT.md form).
 */
export async function generatePlanet(params: Partial<GenParams>, opts: GenerateOptions | ProgressFn = {}): Promise<PlanetData> {
  const o: GenerateOptions = typeof opts === 'function' ? { onProgress: opts } : opts;
  const my = ++generation;
  const p = resolveParams(params);
  const cancelled = () => my !== generation || !!o.signal?.aborted;
  if (!o.mainThread && workersAvailable()) return generateInWorkers(p, o.onProgress, cancelled, abortError, o.signal);
  const it = pipelineSteps(p, o.onProgress);
  for (;;) {
    if (cancelled()) throw abortError();
    const r = it.next();
    if (r.done) return r.value;
    await new Promise<void>((res) => setTimeout(res, 0));
  }
}
