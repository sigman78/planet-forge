// Node CLI: runs the generator single-threaded and writes previews + raw engine exports.
//   node src/gen/cli.ts --seed 42 --res 256 --preset rust --out out/rust
// Options: --seed n, --res n, --preset name, --out dir, --set key=value (repeatable), --no-preview,
//          --zoom lon,lat,fovDeg (repeatable; gnomonic close-up zoomK.png)

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LAYERS } from '../core/types.ts';
import { GEO_UNITS } from './world.ts';
import { GEN_PRESETS, presetParams } from './params.ts';
import type { GenParams } from './params.ts';
import { generatePlanetSync, now } from './pipeline.ts';
import { encodePng } from './png.ts';
import { renderEquirect, renderGlobes, renderZoom } from './preview.ts';

const proc = (globalThis as unknown as { process: { argv: string[]; exit(code: number): never; stdout: { write(s: string): void } } }).process;

function parseArgs(argv: string[]) {
  const o: { seed?: number; res?: number; preset: string; out: string; set: Record<string, string>; preview: boolean; zoom: number[][]; exag: number } = {
    preset: 'rust', out: 'out/planet', set: {}, preview: true, zoom: [], exag: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--seed') { o.seed = Number(v); i++; }
    else if (a === '--res') { o.res = Number(v); i++; }
    else if (a === '--preset') { o.preset = v; i++; }
    else if (a === '--out') { o.out = v; i++; }
    else if (a === '--set') { const [k, val] = v.split('='); o.set[k] = val; i++; }
    else if (a === '--zoom') { o.zoom.push(v.split(',').map(Number)); i++; }
    else if (a === '--exag') { o.exag = Number(v); i++; }
    else if (a === '--no-preview') o.preview = false;
    else if (a === '--help' || a === '-h') {
      proc.stdout.write(`usage: node src/gen/cli.ts [--seed n] [--res n] [--preset "${Object.keys(GEN_PRESETS).join('|')}"] [--exag k] [--out dir] [--set key=value]\n`);
      proc.exit(0);
    }
  }
  return o;
}

function main() {
  const args = parseArgs(proc.argv.slice(2));
  if (!(args.preset in GEN_PRESETS)) {
    proc.stdout.write(`unknown preset "${args.preset}", known: ${Object.keys(GEN_PRESETS).join(', ')}\n`);
    proc.exit(1);
  }
  const over: Partial<GenParams> = {};
  if (args.seed !== undefined) over.seed = args.seed;
  if (args.res !== undefined) over.resolution = args.res;
  for (const [k, v] of Object.entries(args.set)) {
    const num = Number(v);
    (over as Record<string, unknown>)[k] = Number.isFinite(num) && v.trim() !== '' ? num : v;
  }
  const p = presetParams(args.preset, over);
  mkdirSync(args.out, { recursive: true });

  let lastStage = '';
  const pd = generatePlanetSync(p, (stage, frac) => {
    if (stage !== lastStage) { proc.stdout.write(`\n${stage} `); lastStage = stage; }
    if (frac >= 1) proc.stdout.write('done');
  });
  proc.stdout.write('\n');
  const t = pd.timings ?? {};
  proc.stdout.write(`timings (ms): ${Object.entries(t).map(([k, v]) => `${k}=${v.toFixed(0)}`).join(' ')}\n`);
  if (pd.info) {
    const b = pd.info.bulk;
    proc.stdout.write(`${pd.info.name ?? ''} [${pd.info.archetype}] R=${b.radiusKm.toFixed(0)} km g=${b.gravity.toFixed(2)} rho=${b.densityGcc.toFixed(2)} T=${b.surfaceTempK.toFixed(0)} K P=${b.atmospherePressureBar.toExponential(1)} bar (${b.atmosphereKind}) sea=${b.seaKind} tect=${b.tectonics}
`);
    for (const h of pd.info.history) proc.stdout.write(`  ${h.gyrAgo.toFixed(2).padStart(5)} Ga  ${h.stage}: ${h.text}
`);
  }
  proc.stdout.write(`height range: ${pd.minHeight.toFixed(0)} .. ${pd.maxHeight.toFixed(0)} m\n`);

  // Raw exports.
  const T = pd.T;
  const bytes = (a: Float32Array | Uint8Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  writeFileSync(join(args.out, 'height.f32'), bytes(pd.height));
  writeFileSync(join(args.out, 'splat0.rgba'), pd.splat0);
  writeFileSync(join(args.out, 'splat1.rgba'), pd.splat1);
  writeFileSync(join(args.out, 'climate.rgba'), pd.climate);
  const header = {
    format: 'planet-forge/2',
    preset: args.preset,
    params: p,
    N: pd.N,
    T,
    radius: pd.radius,
    minHeight: pd.minHeight,
    maxHeight: pd.maxHeight,
    faceOrder: ['+X', '-X', '+Y', '-Y', '+Z', '-Z'],
    layout: 'row-major per face, index = (face*T + y)*T + x, 1-texel gutter on every side, little-endian',
    files: {
      'height.f32': 'float32, metres relative to datum (sea level if info.look.seaKind != none, else area-mean radius), 6*T*T',
      'splat0.rgba': `uint8 RGBA, layers ${LAYERS.slice(0, 4).join(', ')}`,
      'splat1.rgba': `uint8 RGBA, layers ${LAYERS.slice(4).join(', ')}`,
      'climate.rgba': 'uint8 RGBA: R temperature K/2, G volatile wetness, B flow, A geologic unit id (info.units)',
    },
    layers: LAYERS,
    units: GEO_UNITS.map((u) => ({ id: u.id, name: u.name })),
    info: pd.info,
    timings: t,
  };
  writeFileSync(join(args.out, 'planet.json'), JSON.stringify(header, null, 2));

  if (args.preview) {
    const t0 = now();
    const W = 2048, H = 1024;
    writeFileSync(join(args.out, 'preview.png'), encodePng(renderEquirect(pd, W, H, { mode: 'splat' }), W, H, 3));
    writeFileSync(join(args.out, 'units.png'), encodePng(renderEquirect(pd, W, H, { mode: 'units' }), W, H, 3));
    writeFileSync(join(args.out, 'height.png'), encodePng(renderEquirect(pd, W, H, { mode: 'height' }), W, H, 3));
    const S = 768;
    writeFileSync(join(args.out, 'globe.png'), encodePng(renderGlobes(pd, S, { mode: 'splat', exaggerate: args.exag }), 2 * S, S, 3));
    args.zoom.forEach(([lon, lat, fov], k) => {
      const Z = 1024;
      writeFileSync(join(args.out, `zoom${k}.png`), encodePng(renderZoom(pd, Z, lon, lat, fov ?? 30, { mode: 'splat' }), Z, Z, 3));
    });
    proc.stdout.write(`previews: ${(now() - t0).toFixed(0)} ms
`);
  }
  proc.stdout.write(`wrote ${args.out}\n`);
}

main();
