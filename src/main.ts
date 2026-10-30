import * as THREE from 'three';
import { Pane, type FolderApi } from 'tweakpane';
import * as EssentialsPlugin from '@tweakpane/plugin-essentials';
import { sampleDir } from './core/cube.ts';
import type { PlanetBulk, PlanetData, ResolvedParams, Poi } from './core/types.ts';
import { DEFAULT_PARAMS, GEN_PRESETS, PARAM_SCHEMA, presetParams, type GenParams } from './gen/params.ts';
import { generate, previewWorld } from './app/generate.ts';
import { loadCached, storeCached, clearCache } from './app/cache.ts';
import { Hologram } from './render/hologram.ts';
import { Captions } from './app/captions.ts';
import { Tour } from './app/tour.ts';
import { ScanReadout } from './app/scan.ts';
import { PoiLabels } from './app/pois.ts';
import { DEFAULT_ENV, applyLookHints, archetypeLabel, planetName, MIN_ATMO_DENSITY, type EnvParams } from './app/presets.ts';
import { download, exportPlanet } from './app/export.ts';
import { loadTerrainTextures } from './render/terrainTextures.ts';
import { createSharedUniforms, DEFAULT_LOOK, PlanetView, type LookParams } from './render/planetView.ts';
import { Pipeline } from './render/pipeline.ts';
import { createSky } from './render/sky.ts';
import { PlanetCameraController } from './render/controls.ts';
import { SunShadowMap } from './render/sunShadow.ts';
import { Rocks } from './render/rocks.ts';

const $ = (id: string) => document.getElementById(id)!;

const DEBUG_VIEWS: Record<string, number> = {
  Lit: 0, Albedo: 1, Normals: 2, Height: 3, 'Splat layers': 4, 'Geologic map': 5, Temperature: 6, Volatiles: 7, Flow: 8, 'Cube faces': 9, 'AO / rough': 10,
};

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

async function main() {
  // ---- Renderer --------------------------------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  $('app').appendChild(renderer.domElement);
  if (!renderer.extensions.has('OES_texture_float_linear')) {
    console.warn('OES_texture_float_linear missing: heightmap filtering will be nearest on this GPU.');
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(DEFAULT_ENV.fov, window.innerWidth / window.innerHeight, 1, 1e5);

  // ---- State -----------------------------------------------------------------------------------
  const archetypes = Object.keys(GEN_PRESETS);
  const state = {
    preset: archetypes[0] ?? 'default',
    autoRegen: true,
    autoLook: true,
    cache: true, // reuse planets stored in IndexedDB (production builds)
    meshSegments: 0, // 0 = auto (by on-screen size)
    hideUi: false,
    /** HQ volumetrics: terrain shadows in the dust and haze (sun shadow-height map), more haze steps. */
    hq: true,
    /** HQ only: how far the terrain's shadow volumes reach up into the dust (1 = physical). */
    shafts: 3,
    /** Surface rock density (0 = off). */
    rocks: 1,
    /** Console aid: 1 = shadow map verdict on the ground, 2 = haze glow only. */
    hqDebug: 0,
  };
  // Shareable worlds: #<archetype>/<seed> in the URL.
  const fromHash = /^#([^/]+)\/(\d+)$/.exec(location.hash);
  const hashPreset = fromHash ? decodeURIComponent(fromHash[1]) : '';
  if (hashPreset && GEN_PRESETS[hashPreset]) state.preset = hashPreset;
  const initialSeed = fromHash && GEN_PRESETS[hashPreset] ? Number(fromHash[2]) : Math.floor(Math.random() * 100000);
  let gen: GenParams = presetParams(state.preset, { seed: initialSeed, resolution: DEFAULT_PARAMS.resolution });
  const look: LookParams = { ...DEFAULT_LOOK };
  const env: EnvParams = structuredClone(DEFAULT_ENV);

  // ---- Assets ----------------------------------------------------------------------------------
  // No loading screen: the forging hologram spins up right away and stays until the first world is ready.
  const boot = $('boot');
  boot.classList.add('done');
  const shared = createSharedUniforms();
  const holo = new Hologram(shared.uSunDir);
  {
    const s0 = new THREE.Scene();
    s0.add(holo.mesh);
    camera.position.set(0, 350, 1900);
    camera.lookAt(0, 0, 0);
    holo.begin(600, gen.seed);
    const t0 = performance.now();
    let last = t0;
    renderer.setAnimationLoop(() => {
      const now = performance.now();
      holo.update(Math.min((now - last) / 1000, 0.1), (now - t0) / 1000);
      last = now;
      renderer.render(s0, camera);
    });
  }
  const [layers, sky] = await Promise.all([
    loadTerrainTextures(renderer, `${import.meta.env.BASE_URL}textures/`),
    createSky(scene, shared),
  ]);

  const view = new PlanetView(renderer, shared, layers);
  view.setMeshSegments(state.meshSegments || 192);
  scene.add(view.group);
  scene.add(holo.mesh);
  const rocks = new Rocks(view);
  view.group.add(rocks.group);
  // Nothing to show until the first world is forged (the hologram stands in).
  view.group.visible = false;
  shared.uAtmoDensity.value = 0;
  shared.uHaze.value = 0;

  const pipeline = new Pipeline(renderer, scene, camera, shared);
  const sunShadow = new SunShadowMap(view);
  pipeline.atmoUniforms.tSunShadow.value = sunShadow.rt.texture;
  pipeline.atmoUniforms.uSunShadowS.value = sunShadow.size;
  const controller = new PlanetCameraController(camera, renderer.domElement);
  controller.surface = (dir) => {
    const d = view.data;
    // While the hologram stands in, the old terrain must not push the camera around.
    if (!d || !view.group.visible) return controller.radius;
    return view.surfaceRadiusKm(dir, (x, y, z) => sampleDir(d.height, d.N, x, y, z));
  };

  // ---- Apply settings --------------------------------------------------------------------------
  function applyEnv() {
    const az = THREE.MathUtils.degToRad(env.sunAzimuth);
    const el = THREE.MathUtils.degToRad(env.sunElevation);
    shared.uSunDir.value.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
    shared.uSunColor.value.set(env.sunColor).multiplyScalar(env.sunIntensity);
    renderer.toneMappingExposure = env.exposure;
    pipeline.bloom.strength = env.bloomStrength;
    pipeline.bloom.radius = env.bloomRadius;
    pipeline.bloom.threshold = env.bloomThreshold;
    sky.setStarIntensity(env.starIntensity);
    scene.backgroundIntensity = env.skyIntensity;
    const R = shared.uPlanetRadius.value;
    shared.uAtmoRadius.value = R + env.atmoHeight;
    shared.uRayleigh.value.set(env.rayleigh.x, env.rayleigh.y, env.rayleigh.z).multiplyScalar(1e-3);
    shared.uRayleighH.value = env.rayleighH;
    shared.uMie.value = env.mie * 1e-3;
    shared.uMieH.value = env.mieH;
    shared.uMieG.value = env.mieG;
    shared.uAtmoDensity.value = Math.max(MIN_ATMO_DENSITY, env.atmoDensity);
    pipeline.atmoUniforms.uSteps.value = env.atmoSteps;
    shared.uHaze.value = env.haze * 1e-3;
    shared.uHazeH.value = env.hazeH;
    shared.uHazeColor.value.set(env.hazeColor);
    // Sky ambient: the colour of the scattered light (rayleigh + mie), scaled by density and sun.
    const r = env.rayleigh;
    const mieW = env.mie * 0.6;
    const cr = r.x + mieW, cg = r.y + mieW, cb = r.z + mieW;
    const m = Math.max(cr, cg, cb, 1e-6);
    const k = 0.11 * Math.min(env.atmoDensity, 1.5) * (env.sunIntensity / 6);
    shared.uSkyAmbient.value.setRGB((cr / m) * k, (cg / m) * k, (cb / m) * k);
    // Ground haze adds a dusty skylight of its own.
    const hk = Math.min(env.haze / 30, 1) * 0.06 * (env.sunIntensity / 6);
    const hc = new THREE.Color(env.hazeColor);
    shared.uSkyAmbient.value.r += hc.r * hk;
    shared.uSkyAmbient.value.g += hc.g * hk;
    shared.uSkyAmbient.value.b += hc.b * hk;
    shared.uAmbient.value = env.ambient;
    // Planetshine comes from the giant, which hangs roughly on the night side, a little to one side.
    const faz = az + Math.PI * 0.75;
    shared.uFillDir.value.set(Math.sin(faz), 0.25, Math.cos(faz)).normalize();
    shared.uFillColor.value.set(env.fillColor).multiplyScalar(env.fill * env.sunIntensity);
    camera.fov = env.fov;
    camera.updateProjectionMatrix();
    controller.autoRotate = env.autoRotate;
    controller.autoTilt = env.autoTilt;
    // While the hologram stands in for the world there is no atmosphere around it.
    if (!view.group.visible) {
      shared.uAtmoDensity.value = 0;
      shared.uHaze.value = 0;
    }
  }
  function applyLook() {
    view.applyLook(look);
  }

  // ---- Generation ------------------------------------------------------------------------------
  let abort: AbortController | null = null;
  let regenTimer = 0;
  const captions = new Captions($('captions'));
  const poiLabels = new PoiLabels($('pois'));
  let pois: Poi[] = [];
  const tour = new Tour({
    controller,
    radius: () => controller.radius,
    sunDir: () => shared.uSunDir.value,
    pois: () => pois,
    caption: (kind, title, text) => captions.play([{ when: kind, title, text }], 0),
    labels: (on) => ($('pois').style.visibility = on ? '' : 'hidden'),
    done: () => {
      captions.stop();
      tourBtn.classList.remove('active');
    },
  });
  /** overlay: keep the current world on screen under a faint hologram (live slider tweaks). */
  async function regenerate(overlay = false) {
    abort?.abort();
    const ac = new AbortController();
    abort = ac;
    tour.stop();
    captions.stop();
    const t0 = performance.now();
    const params = structuredClone(gen);
    const session = ++forgeSession;
    try {
      // Planets are cached in IndexedDB by parameters + generator version (not in dev: the generator changes).
      const useCache = state.cache && !import.meta.env.DEV;
      let planet = useCache ? await loadCached(params) : null;
      const cached = !!planet;
      if (ac.signal.aborted) return;
      if (!planet) {
        const pre = scanStart(session, params, overlay);
        // Forging takes seconds: swap the old world for the hologram unless it finishes very quickly.
        const holoTimer = window.setTimeout(() => {
          if (ac.signal.aborted) return;
          const swap = !overlay || !view.data;
          holo.begin(swap ? pre.bulk.radiusKm : controller.radius, params.seed, !swap);
          if (swap) {
            view.group.visible = false;
            shared.uAtmoDensity.value = 0;
            shared.uHaze.value = 0;
            // Pull back to the opening view while the hologram forges (the new radius is already known).
            if (framed) {
              const R = pre.bulk.radiusKm;
              controller.setRadius(R);
              controller.maxAltitude = R * 14;
              controller.flyTo({ altitude: R * 2.6, lat: 0.3, heading: 0, userPitch: 0 }, 2.5);
              pulledBack = true;
            }
          }
        }, 150);
        try {
          planet = await generate(params, {
            signal: ac.signal,
            onProgress: (_stage, frac) => {
              if (!ac.signal.aborted) holo.setProgress(frac);
            },
          });
        } finally {
          clearTimeout(holoTimer);
        }
        if (useCache && !ac.signal.aborted) void storeCached(params, planet);
      }
      if (ac.signal.aborted) return;
      lastFromCache = cached;
      history.replaceState(null, '', `#${encodeURIComponent(state.preset)}/${params.seed}`);
      view.setPlanet(planet);
      // Dense low-altitude meshes are built while the world lands, not on the first dive.
      const want = planet.radius / 1000 >= 600 ? 768 : 512;
      (window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1500)))(() => view.prewarmMesh(want));
      view.group.visible = true;
      pois = planet.info?.pois ?? [];
      poiLabels.set(pois);
      holo.finish(planet.radius / 1000);
      const R = planet.radius / 1000;
      const prevR = controller.radius;
      controller.setRadius(R);
      controller.maxAltitude = R * 14;
      // Small bodies vary a lot in size: reframe when the radius changes noticeably (the forge pull-back
      // already did it on the hologram path).
      if (!framed) {
        controller.setView({ altitude: R * 2.6 }, true);
        framed = true;
      } else if (!pulledBack && Math.abs(R - prevR) / prevR > 0.15) {
        controller.flyTo({ altitude: R * 2.6 }, 0.8);
      }
      pulledBack = false;
      if (state.autoLook && planet.info) applyLookHints(planet.info.look, env, look, planet.info.bulk, planet.info.archetype, gen.seed);
      applyEnv();
      applyLook();
      pane.refresh();
      syncShown(planet.info?.resolved);
      updateHud(planet, performance.now() - t0, session, params.seed);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        console.error(e);
        view.group.visible = true;
        holo.finish(controller.radius);
        applyEnv();
        captions.say('The forge failed: ' + (e as Error).message, 12000);
        return;
      }
    }
  }
  let framed = false;
  let pulledBack = false;
  let lastFromCache = false;
  let forgeSession = 0;
  function scheduleRegen() {
    if (!state.autoRegen) return;
    clearTimeout(regenTimer);
    regenTimer = window.setTimeout(() => regenerate(true), 250);
  }

  const scan = new ScanReadout($('pfacts'), $('pname'), $('pclass'));
  let scanSession = -1;

  const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹';
  const sci = (v: number) => {
    const [m, e] = v.toExponential(2).split('e');
    return `${m}×10${String(Number(e)).replace(/\d/g, (d) => SUP[Number(d)]).replace('-', '⁻')}`;
  };
  function bulkRows(b: PlanetBulk): [string, string][] {
    const pbar = b.atmospherePressureBar;
    const massKg = b.massEarth * 5.972e24;
    return [
      ['radius', `${b.radiusKm.toFixed(0)} km · g ${b.gravity.toFixed(2)} m/s²`],
      ['mass', `${sci(massKg)} kg · ρ ${b.densityGcc.toFixed(2)} g/cm³`],
      ['core', `${(b.coreRadiusFrac * 100).toFixed(0)}% of radius · Fe ${(b.ironFrac * 100).toFixed(0)}%`],
      ['ices', `${(b.volatileFrac * 100).toFixed(0)}% volatiles`],
      ['age', `${b.ageGyr.toFixed(2)} Gyr · ${b.tectonics} lid`],
      ['heat', `${b.heatFlow.toFixed(2)}× Earth flux · sun ${b.insolation.toFixed(3)}×`],
      ['surface', `${b.surfaceTempK.toFixed(0)} K · ${b.seaKind === 'none' ? 'dry' : `${b.seaKind} seas`}`],
      ['air', `${b.atmosphereKind} · ${pbar < 0.01 ? pbar.toExponential(1) : pbar.toFixed(2)} bar`],
    ];
  }
  const classLabel = (archetype: string, seed: number) => `${archetypeLabel(archetype)} world · seed ${seed}`;

  /** Scan readout of the bulk body as soon as a forge starts (the planning step is cheap). */
  function scanStart(session: number, params: GenParams, fast: boolean) {
    const pre = previewWorld(params);
    scanSession = session;
    scan.begin(pre.name, classLabel(pre.archetype, params.seed), bulkRows(pre.bulk), fast);
    return pre;
  }

  function updateHud(p: PlanetData, ms: number, session: number, seed: number) {
    const info = p.info;
    const rows: [string, string][] = [
      ['relief', `${(p.minHeight / 1000).toFixed(1)} … +${(p.maxHeight / 1000).toFixed(1)} km`],
      ['faces', `6 × ${p.N}² · ${lastFromCache ? 'from cache' : 'forged'} in ${(ms / 1000).toFixed(2)} s`],
    ];
    if (scanSession === session) scan.append(rows);
    else {
      // No scan running for this world (e.g. cache hit): quick full readout.
      scanSession = session;
      const head = info?.bulk ? bulkRows(info.bulk) : [['radius', `${(p.radius / 1000).toFixed(0)} km`] as [string, string]];
      scan.begin(info?.name ?? planetName(seed), classLabel(info?.archetype ?? state.preset, seed), [...head, ...rows], true);
    }
    const hist = info?.history ?? [];
    captions.play(hist.map((h) => ({ when: h.gyrAgo > 0 ? `${h.gyrAgo.toFixed(2)} Ga` : 'now', title: h.stage, text: h.text })), 2400);
  }

  // ---- Presets bar (archetypes) ----------------------------------------------------------------
  const presetBar = $('presets');
  function loadPreset(name: string, keepSeed = true) {
    if (!GEN_PRESETS[name]) return;
    state.preset = name;
    gen = presetParams(name, { seed: keepSeed ? gen.seed : Math.floor(Math.random() * 100000), resolution: gen.resolution });
    for (const b of presetBar.querySelectorAll('button')) b.classList.toggle('active', b.dataset.preset === name);
    rebuildGenPane();
    regenerate();
  }
  for (const key of archetypes) {
    const b = document.createElement('button');
    b.textContent = archetypeLabel(key);
    b.dataset.preset = key;
    b.onclick = () => loadPreset(key);
    presetBar.appendChild(b);
  }
  const tourBtn = document.createElement('button');
  tourBtn.className = 'tour';
  tourBtn.textContent = '▶ Tour';
  tourBtn.title = 'Fly a tour of this world (P). Any drag or scroll stops it.';
  function toggleTour() {
    if (!view.group.visible) return;
    tour.toggle();
    tourBtn.classList.toggle('active', tour.active);
  }
  tourBtn.onclick = toggleTour;
  presetBar.appendChild(tourBtn);

  // ---- Tweakpane -------------------------------------------------------------------------------
  const pane = new Pane({ container: $('pane'), title: 'Planet Forge' });
  pane.registerPlugin(EssentialsPlugin);
  const fps = pane.addBlade({ view: 'fpsgraph', label: 'fps', rows: 2 }) as unknown as { begin(): void; end(): void };
  const tabs = pane.addTab({ pages: [{ title: 'Planet' }, { title: 'Look' }, { title: 'Light' }, { title: 'Debug' }] });
  const [tPlanet, tLook, tLight, tDebug] = tabs.pages;

  // Planet tab
  tPlanet.addBinding(state, 'autoRegen', { label: 'live regen' });
  tPlanet.addBinding(state, 'autoLook', { label: 'auto look' });
  if (!import.meta.env.DEV) {
    tPlanet.addBinding(state, 'cache', { label: 'planet cache' });
    tPlanet.addButton({ title: 'Clear planet cache' }).on('click', () => void clearCache());
  }
  const actions = tPlanet.addBlade({ view: 'buttongrid', size: [3, 1], cells: (x: number) => ({ title: ['Forge', 'New seed', 'Export'][x] }) }) as unknown as {
    on(ev: 'click', cb: (e: { index: [number, number] }) => void): void;
  };
  actions.on('click', (e) => {
    const i = e.index[0];
    if (i === 0) regenerate();
    if (i === 1) newSeed();
    if (i === 2 && view.data) {
      const name = view.data.info?.name ?? planetName(gen.seed);
      download(exportPlanet(view.data, { params: gen, archetype: state.preset, name }), `${name.replace(/\s+/g, '_')}_${gen.seed}.planet`);
    }
  });
  let genFolders: FolderApi[] = [];
  // AUTO knobs (-1 in GenParams) show what they resolved to. The pane binds them to `shown`; moving a slider
  // writes the value into `gen`, which pins it. `synced` is what the app last wrote into `shown`, so the change
  // events that refresh() fires are told apart from user edits.
  const shown: Record<string, number> = {};
  const synced: Record<string, number> = {};
  const autoRows = new Map<string, { binding: { element: HTMLElement; refresh(): void }; label: string }>();
  let lastResolved: ResolvedParams = {};
  function syncShown(resolved?: ResolvedParams) {
    if (resolved) lastResolved = resolved;
    else {
      // Pinned bulk values move other AUTO values (e.g. heat sets the volcano count): re-plan, it is cheap.
      lastResolved = { ...previewWorld(gen).resolved, seaVolume: lastResolved.seaVolume ?? 0 };
    }
    const g = gen as unknown as Record<string, number>;
    for (const [key, row] of autoRows) {
      const pinned = g[key] >= 0;
      const v = pinned ? g[key] : (lastResolved[key] ?? 0);
      shown[key] = synced[key] = v;
      row.binding.element.classList.toggle('pf-auto', !pinned);
      row.binding.element.title = pinned ? '' : 'auto: derived from the archetype and seed (move it to pin a value)';
      row.binding.refresh();
    }
  }
  function rebuildGenPane() {
    for (const f of genFolders) f.dispose();
    genFolders = [];
    autoRows.clear();
    const groups = new Map<string, FolderApi>();
    for (const entry of PARAM_SCHEMA) {
      let folder = groups.get(entry.group);
      if (!folder) {
        folder = tPlanet.addFolder({ title: entry.group, expanded: groups.size < 2 });
        groups.set(entry.group, folder);
        genFolders.push(folder);
      }
      const opts: Record<string, unknown> = { label: entry.label };
      if (entry.options) opts.options = entry.options;
      else if (typeof (gen as unknown as Record<string, unknown>)[entry.key] === 'number') {
        Object.assign(opts, { min: entry.auto ? 0 : entry.min, max: entry.max, step: entry.step });
      }
      if (entry.auto) {
        const key = entry.key;
        shown[key] = synced[key] = 0;
        const binding = folder.addBinding(shown, key, opts);
        binding.on('change', (ev) => {
          // A refresh, not the user (Tweakpane also snaps the value to the slider step and writes it back).
          if (Math.abs(shown[key] - synced[key]) <= (entry.step ?? 0) * 0.5 + 1e-9) {
            synced[key] = shown[key];
            return;
          }
          (gen as unknown as Record<string, number>)[key] = shown[key];
          synced[key] = shown[key];
          if (ev.last !== false) {
            syncShown();
            scheduleRegen();
          }
        });
        autoRows.set(key, { binding, label: entry.label });
      } else {
        folder.addBinding(gen as unknown as Record<string, unknown>, entry.key, opts).on('change', (ev) => {
          if (ev.last !== false) {
            if (entry.key === 'seed' || entry.key === 'archetype' || entry.key === 'drama') syncShown();
            scheduleRegen();
          }
        });
      }
    }
    syncShown();
  }
  function newSeed() {
    gen.seed = Math.floor(Math.random() * 100000);
    pane.refresh();
    syncShown();
    regenerate();
  }

  // Look tab
  const fSurf = tLook.addFolder({ title: 'Surface' });
  fSurf.addBinding(look, 'heightExaggeration', { label: 'height exag.', min: 0, max: 8, step: 0.05 });
  fSurf.addBinding(look, 'detailAmp', { label: 'detail relief (m)', min: 0, max: 1500, step: 5 });
  fSurf.addBinding(look, 'detailScale', { label: 'detail size (km)', min: 0.5, max: 40, step: 0.1 });
  fSurf.addBinding(look, 'fineDetail', { label: 'fine relief', min: 0, max: 3, step: 0.05 });
  const fLand = tLook.addFolder({ title: 'Landform detail style', expanded: false });
  fLand.addBinding(look, 'landRidged', { label: 'ridged', min: 0, max: 1, step: 0.01 });
  fLand.addBinding(look, 'landBillowy', { label: 'billowy', min: 0, max: 1, step: 0.01 });
  fLand.addBinding(look, 'landCracked', { label: 'cracked', min: 0, max: 1, step: 0.01 });
  fLand.addBinding(look, 'landPitted', { label: 'pitted', min: 0, max: 1, step: 0.01 });
  fLand.addBinding(look, 'finePits', { label: 'fine craterlets', min: 0, max: 1, step: 0.01 });
  fSurf.addBinding(look, 'shadows', { label: 'cast shadows', min: 0, max: 1, step: 0.05 });
  fSurf.addBinding(look, 'terrainAO', { label: 'terrain AO', min: 0, max: 1.5, step: 0.05 });
  fSurf.addBinding(look, 'specular', { label: 'specular', min: 0, max: 1.5, step: 0.05 });
  fSurf.addBinding(look, 'roughMin', { label: 'min roughness', min: 0, max: 1, step: 0.01 });
  fSurf.addBinding(look, 'seaFloorScale', { label: 'seafloor scale', min: 0, max: 1, step: 0.01 });
  fSurf.addBinding(look, 'textureScale', { label: 'texture scale', min: 10, max: 2000, step: 1 });
  fSurf.addBinding(look, 'weathering', { label: 'weathering', min: 0, max: 2, step: 0.05 });
  fSurf.addBinding(state, 'rocks', { label: 'rocks', min: 0, max: 3, step: 0.05 });
  fSurf.addBinding(look, 'normalStrength', { label: 'detail normal', min: 0, max: 3, step: 0.01 });
  fSurf.addBinding(look, 'macroNormal', { label: 'relief normal', min: 0, max: 1, step: 0.01 });
  fSurf.addBinding(look, 'heightBlend', { label: 'height blend', min: 0, max: 2, step: 0.01 });
  fSurf.addBinding(look, 'triSharp', { label: 'triplanar sharp', min: 1, max: 32, step: 0.5 });
  fSurf.addBinding(look, 'antiTile', { label: 'anti-tiling', min: 0, max: 1, step: 0.01 });
  fSurf.addBinding(look, 'macroVar', { label: 'macro variation', min: 0, max: 1, step: 0.01 });
  fSurf.addBinding(look, 'tintStrength', { label: 'world tint', min: 0, max: 1.5, step: 0.01 });
  fSurf.addBinding(look, 'albedoHarmony', { label: 'albedo harmony', min: 0, max: 1, step: 0.01 });
  fSurf.addBinding(look, 'wetness', { label: 'volatile wetness', min: 0, max: 1, step: 0.01 });
  fSurf.addBinding(look, 'channels', { label: 'channel darkening', min: 0, max: 1, step: 0.01 });
  const fOcean = tLook.addFolder({ title: 'Seas' });
  fOcean.addBinding(look, 'oceanMode', { label: 'mode', options: { water: 0, lava: 1, ice: 2, none: 3 } });
  fOcean.addBinding(look, 'deepColor', { label: 'deep' });
  fOcean.addBinding(look, 'shallowColor', { label: 'shallow' });
  fOcean.addBinding(look, 'clarity', { label: 'clarity (m)', min: 1, max: 300, step: 1 });
  fOcean.addBinding(look, 'waveScale', { label: 'wave scale', min: 0.05, max: 5, step: 0.01 });
  fOcean.addBinding(look, 'waveStrength', { label: 'wave strength', min: 0, max: 1.5, step: 0.01 });
  fOcean.addBinding(look, 'foam', { min: 0, max: 2, step: 0.01 });
  fOcean.addBinding(look, 'lavaColor', { label: 'lava' });
  fOcean.addBinding(look, 'lavaGlow', { label: 'lava glow', min: 0, max: 60, step: 0.1 });
  const fAtmo = tLook.addFolder({ title: 'Atmosphere' });
  fAtmo.addBinding(env, 'atmoDensity', { label: 'density', min: MIN_ATMO_DENSITY, max: 6, step: 0.01 });
  fAtmo.addBinding(env, 'atmoHeight', { label: 'height (km)', min: 10, max: 400, step: 1 });
  fAtmo.addBinding(env, 'rayleigh', { label: 'rayleigh β', x: { min: 0, max: 60 }, y: { min: 0, max: 60 }, z: { min: 0, max: 60 } });
  fAtmo.addBinding(env, 'rayleighH', { label: 'rayleigh H', min: 1, max: 60, step: 0.1 });
  fAtmo.addBinding(env, 'mie', { label: 'mie β (haze)', min: 0, max: 80, step: 0.1 });
  fAtmo.addBinding(env, 'mieH', { label: 'mie H', min: 0.2, max: 40, step: 0.1 });
  fAtmo.addBinding(env, 'mieG', { label: 'mie g', min: 0, max: 0.99, step: 0.01 });
  fAtmo.addBinding(env, 'haze', { label: 'ground haze', min: 0, max: 80, step: 0.1 });
  fAtmo.addBinding(env, 'hazeH', { label: 'haze height (km)', min: 0.3, max: 20, step: 0.1 });
  fAtmo.addBinding(env, 'hazeColor', { label: 'haze colour' });
  fAtmo.addBinding(env, 'atmoSteps', { label: 'march steps', min: 4, max: 64, step: 1 });
  fAtmo.addBinding(state, 'hq', { label: 'HQ volumetrics' });
  fAtmo.addBinding(state, 'shafts', { label: 'dust shafts', min: 1, max: 8, step: 0.1 });

  // Light tab
  tLight.addBinding(env, 'sunAzimuth', { label: 'sun azimuth', min: -180, max: 180, step: 0.5 });
  tLight.addBinding(env, 'sunElevation', { label: 'sun elevation', min: -89, max: 89, step: 0.5 });
  tLight.addBinding(env, 'dayCycle', { label: 'day cycle °/s', min: -30, max: 30, step: 0.1 });
  tLight.addBinding(env, 'sunIntensity', { label: 'sun intensity', min: 0, max: 30, step: 0.1 });
  tLight.addBinding(env, 'sunColor', { label: 'sun color' });
  tLight.addBinding(env, 'ambient', { label: 'space ambient', min: 0, max: 0.1, step: 0.0005 });
  tLight.addBinding(env, 'fill', { label: 'planetshine', min: 0, max: 0.3, step: 0.005 });
  tLight.addBinding(env, 'fillColor', { label: 'planetshine col' });
  const fPost = tLight.addFolder({ title: 'Camera & post' });
  fPost.addBinding(env, 'exposure', { min: 0.05, max: 5, step: 0.01 });
  fPost.addBinding(env, 'bloomStrength', { label: 'bloom', min: 0, max: 3, step: 0.01 });
  fPost.addBinding(env, 'bloomRadius', { label: 'bloom radius', min: 0, max: 1, step: 0.01 });
  fPost.addBinding(env, 'bloomThreshold', { label: 'bloom threshold', min: 0, max: 10, step: 0.01 });
  fPost.addBinding(env, 'starIntensity', { label: 'stars', min: 0, max: 5, step: 0.01 });
  fPost.addBinding(env, 'skyIntensity', { label: 'milky way', min: 0, max: 5, step: 0.01 });
  fPost.addBinding(env, 'fov', { min: 15, max: 90, step: 1 });
  fPost.addBinding(env, 'autoRotate', { label: 'auto orbit', min: -0.3, max: 0.3, step: 0.005 });
  fPost.addBinding(env, 'autoTilt', { label: 'horizon tilt' });

  // Debug tab
  tDebug.addBinding(look, 'debug', { label: 'view', options: DEBUG_VIEWS });
  tDebug.addBinding(look, 'wireframe');
  tDebug
    .addBinding(state, 'meshSegments', { label: 'mesh / face', options: { auto: 0, '128': 128, '256': 256, '384': 384, '512': 512, '768': 768 } })
    .on('change', () => state.meshSegments && view.setMeshSegments(state.meshSegments));
  const camInfo = { text: '' };
  tDebug.addBinding(camInfo, 'text', { label: 'camera', readonly: true, multiline: true, rows: 3, interval: 250 });
  tDebug.addButton({ title: 'Screenshot (PNG)' }).on('click', () => {
    pipeline.render(0);
    renderer.domElement.toBlob((b) => b && download(b, `${planetName(gen.seed)}_${gen.seed}.png`), 'image/png');
  });

  // Renderer-side settings are cheap to apply, so any pane change re-applies them.
  pane.on('change', () => {
    applyLook();
    applyEnv();
  });

  // ---- Keyboard --------------------------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === 'r' || e.key === 'R') newSeed();
    if (e.key === 'h' || e.key === 'H') {
      state.hideUi = !state.hideUi;
      for (const id of ['pane', 'hud', 'presets', 'help', 'captions', 'pois']) $(id).style.display = state.hideUi ? 'none' : '';
    }
    if (e.key === 't' || e.key === 'T') captions.toggle();
    if (e.key === 'l' || e.key === 'L') poiLabels.enabled = !poiLabels.enabled;
    if (e.key === 'p' || e.key === 'P') toggleTour();
    const dv = Object.values(DEBUG_VIEWS);
    if (/^[0-9]$/.test(e.key)) {
      look.debug = dv[Number(e.key)] ?? 0;
      pane.refresh();
      applyLook();
    }
  });

  // ---- Resize ----------------------------------------------------------------------------------
  function onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    pipeline.setSize(w, h);
  }
  window.addEventListener('resize', onResize);

  // ---- Boot ------------------------------------------------------------------------------------
  rebuildGenPane();
  loadPreset(state.preset);
  controller.setView({ altitude: 1300, lat: 0.3, lon: 0.4 }, true);

  const timer = new THREE.Timer();
  let time = 0;
  let paneRefreshT = 0;
  renderer.setAnimationLoop(() => {
    fps.begin();
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1);
    time += dt;
    if (env.dayCycle !== 0) {
      env.sunAzimuth = ((env.sunAzimuth + env.dayCycle * dt + 540) % 360) - 180;
      applyEnv();
      paneRefreshT += dt;
      if (paneRefreshT > 0.5) {
        paneRefreshT = 0;
        pane.refresh();
      }
    }
    shared.uTime.value = time;
    controller.update(dt);
    holo.update(dt, time);
    sky.update(camera, renderer.getPixelRatio());
    // Low down, allow a denser mesh so crater rims and ridges stop looking faceted (the 512-texel heightmap is
    // undersampled at 384). Small bodies get less: their landform octaves still displace the vertices.
    const maxSeg = controller.altitude < 25 ? (controller.radius >= 600 ? 768 : 512) : 384;
    if (!state.meshSegments) view.autoMeshSegments(camera, renderer.domElement.height, controller.altitude, 5, maxSeg);
    view.updateFootprint(camera, renderer.domElement.height);
    if (view.group.visible) rocks.update(renderer, camera, controller.aboveGround, state.rocks, look.debug);
    if (view.group.visible) poiLabels.update(camera, controller.radius, controller.altitude, window.innerWidth, window.innerHeight);
    else poiLabels.update(camera, controller.radius, 0, 1, 1);
    camInfo.text = `alt ${controller.altitude.toFixed(1)} km\nlat ${THREE.MathUtils.radToDeg(controller.lat).toFixed(1)}° lon ${THREE.MathUtils.radToDeg(controller.lon).toFixed(1)}°\nnear ${camera.near.toFixed(2)} far ${camera.far.toFixed(0)}`;
    const hq = state.hq && view.group.visible && shared.uHaze.value + shared.uMie.value * shared.uAtmoDensity.value > 0;
    pipeline.atmoUniforms.uHQ.value = hq ? 1 + state.hqDebug : 0;
    pipeline.atmoUniforms.uShafts.value = state.shafts;
    if (hq) sunShadow.update(renderer, shared.uSunDir.value);
    pipeline.render(dt);
    fps.end();
  });

  // Expose for debugging in the console.
  Object.assign(window as unknown as Record<string, unknown>, {
    forge: { renderer, scene, camera, view, rocks, pipeline, controller, sunShadow, tour, env, look, state, get gen() { return gen; }, regenerate, applyEnv, applyLook, loadPreset },
  });
}

main().catch((e) => {
  console.error(e);
  const boot = document.getElementById('boot');
  if (boot) {
    boot.classList.remove('done');
    boot.innerHTML = `<div class="err">Failed to start: ${(e as Error).message}</div>`;
  }
});
