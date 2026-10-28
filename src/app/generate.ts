import type { PlanetData } from '../core/types.ts';
import type { GenParams } from '../gen/params.ts';
import { makeStubPlanet } from '../render/devStub.ts';

export interface GenOptions {
  onProgress?: (stage: string, frac: number) => void;
  signal?: AbortSignal;
}

/** Facade over the generator so the app does not depend on its internals. */
export async function generate(params: GenParams, opts: GenOptions = {}): Promise<PlanetData> {
  opts.onProgress?.('stub', 0.5);
  await new Promise((r) => setTimeout(r, 10));
  const p = makeStubPlanet(Math.min(params.resolution, 256));
  opts.onProgress?.('done', 1);
  return p;
}
