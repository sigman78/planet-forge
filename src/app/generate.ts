import type { PlanetData } from '../core/types.ts';
import type { GenParams } from '../gen/params.ts';
import { generatePlanet } from '../gen/index.ts';

export interface GenOptions {
  onProgress?: (stage: string, frac: number) => void;
  signal?: AbortSignal;
}

/** Facade over the generator so the app does not depend on its internals. */
export function generate(params: GenParams, opts: GenOptions = {}): Promise<PlanetData> {
  return generatePlanet(params, { onProgress: opts.onProgress, signal: opts.signal });
}
