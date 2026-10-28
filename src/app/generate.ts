import type { PlanetBulk, PlanetData, ResolvedParams } from '../core/types.ts';
import type { GenParams } from '../gen/params.ts';
import { generatePlanet, resolveParams } from '../gen/index.ts';
import { worldPlan } from '../gen/pipeline.ts';

export interface GenOptions {
  onProgress?: (stage: string, frac: number) => void;
  signal?: AbortSignal;
}

/** Facade over the generator so the app does not depend on its internals. */
export function generate(params: GenParams, opts: GenOptions = {}): Promise<PlanetData> {
  return generatePlanet(params, { onProgress: opts.onProgress, signal: opts.signal });
}

/** Bulk body + name for a parameter set, without generating any terrain (cheap, deterministic). */
export function previewWorld(params: GenParams): { name: string; archetype: string; bulk: PlanetBulk; resolved: ResolvedParams } {
  const plan = worldPlan(resolveParams(params));
  return { name: plan.name, archetype: plan.archetype, bulk: plan.bulk, resolved: plan.resolved };
}
