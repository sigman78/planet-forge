import * as THREE from 'three';
import { Pane, type FolderApi } from 'tweakpane';
import * as EssentialsPlugin from '@tweakpane/plugin-essentials';
import { sampleDir } from './core/cube.ts';
import type { PlanetData } from './core/types.ts';
import { DEFAULT_PARAMS, GEN_PRESETS, PARAM_SCHEMA, presetParams, type GenParams } from './gen/params.ts';
import { generate } from './app/generate.ts';
import { DEFAULT_ENV, applyLookHints, archetypeLabel, planetName, MIN_ATMO_DENSITY, type EnvParams } from './app/presets.ts';
import { download, exportPlanet } from './app/export.ts';
import { loadTerrainTextures } from './render/terrainTextures.ts';
import { createSharedUniforms, DEFAULT_LOOK, PlanetView, type LookParams } from './render/planetView.ts';
import { Pipeline } from './render/pipeline.ts';
import { createSky } from './render/sky.ts';
import { PlanetCameraController } from './render/controls.ts';

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
    meshSegments: 0, // 0 = auto (by on-screen size)
    hideUi: false,
  };
  let gen: GenParams = presetParams(state.preset, { seed: Math.floor(Math.random() * 100000), resolution: DEFAULT_PARAMS.resolution });
  const look: LookParams = { ...DEFAULT_LOOK };
  const env: EnvParams = structuredClone(DEFAULT_ENV);

  // ---- Assets ----------------------------------------------------------------------------------
  const boot = $('boot');
  boot.textContent = 'LOADING MATERIALS…';
  const shared = createSharedUniforms();
  const [layers, sky] = await Promise.all([
    loadTerrainTextures(renderer, '/textures/', undefined, (f) => (boot.textContent = `LOADING MATERIALS ${Math.round(f * 100)}%`)),
    createSky(scene, shared),
  ]);

  const view = new PlanetView(renderer, shared, layers);
  view.setMeshSegments(state.meshSegments || 192);
  scene.add(view.group);

  const pipeline = new Pipeline(renderer, scene, camera, shared);
  const controller = new PlanetCameraController(camera, renderer.domElement);
  controller.surface = (dir) => {
    const d = view.data;
    if (!d) return shared.uPlanetRadius.value;
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
    camera.fov = env.fov;
    camera.updateProjectionMatrix();
    controller.autoRotate = env.autoRotate;
    controller.autoTilt = env.autoTilt;
  }
  function applyLook() {
    view.applyLook(look);
  }

  // ---- Generation ------------------------------------------------------------------------------
  let abort: AbortController | null = null;
  let regenTimer = 0;
  const progressEl = $('progress');
  async function regenerate() {
    abort?.abort();
    const ac = new AbortController();
    abort = ac;
    progressEl.classList.add('on');
    const t0 = performance.now();
    try {
      const planet = await generate(gen, {
        signal: ac.signal,
        onProgress: (stage, frac) => {
          if (ac.signal.aborted) return;
          $('plabel').textContent = stage.toUpperCase();
          ($('pfill') as HTMLElement).style.width = `${Math.round(frac * 100)}%`;
        },
      });
      if (ac.signal.aborted) return;
      view.setPlanet(planet);
      const R = planet.radius / 1000;
      const prevR = controller.radius;
      controller.radius = R;
      controller.maxAltitude = R * 14;
      // Small bodies vary a lot in size: reframe when the radius changes noticeably.
      if (!framed || Math.abs(R - prevR) / prevR > 0.15) {
        controller.setView({ altitude: R * 2.6 }, !framed);
        framed = true;
      }
      if (state.autoLook && planet.info) applyLookHints(planet.info.look, env, look, planet.info.bulk);
      applyEnv();
      applyLook();
      pane.refresh();
      updateHud(planet, performance.now() - t0);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        console.error(e);
        $('plabel').textContent = 'GENERATION FAILED: ' + (e as Error).message;
        return;
      }
    }
    if (abort === ac) progressEl.classList.remove('on');
  }
  let framed = false;
  function scheduleRegen() {
    if (!state.autoRegen) return;
    clearTimeout(regenTimer);
    regenTimer = window.setTimeout(regenerate, 250);
  }

  function updateHud(p: PlanetData, ms: number) {
    const info = p.info;
    $('pname').textContent = info?.name ?? planetName(gen.seed);
    $('pclass').textContent = `${archetypeLabel(info?.archetype ?? state.preset)} world · seed ${gen.seed}`;
    const b = info?.bulk;
    const rows: [string, string][] = [];
    if (b) {
      rows.push(['radius', `${b.radiusKm.toFixed(0)} km · g ${b.gravity.toFixed(2)} m/s²`]);
      rows.push(['mass', `${b.massEarth.toFixed(3)} M⊕ · ρ ${b.densityGcc.toFixed(2)} g/cm³`]);
      rows.push(['core', `${(b.coreRadiusFrac * 100).toFixed(0)}% of radius · Fe ${(b.ironFrac * 100).toFixed(0)}%`]);
      rows.push(['age', `${b.ageGyr.toFixed(2)} Gyr · ${b.tectonics} lid`]);
      rows.push(['surface', `${b.surfaceTempK.toFixed(0)} K · ${b.seaKind === 'none' ? 'dry' : `${b.seaKind} seas`}`]);
      const pbar = b.atmospherePressureBar;
      rows.push(['air', `${b.atmosphereKind} · ${pbar < 0.01 ? pbar.toExponential(1) : pbar.toFixed(2)} bar`]);
    } else {
      rows.push(['radius', `${(p.radius / 1000).toFixed(0)} km`]);
    }
    rows.push(['relief', `${(p.minHeight / 1000).toFixed(1)} … +${(p.maxHeight / 1000).toFixed(1)} km`]);
    rows.push(['faces', `6 × ${p.N}² · forged in ${(ms / 1000).toFixed(2)} s`]);
    $('pfacts').innerHTML = rows.map(([k, v]) => `${k.padEnd(8)} <span>${esc(v)}</span>`).join('\n');

    const hist = info?.history ?? [];
    $('timeline').innerHTML = hist.length
      ? `<div class="tl-title">Formation history <kbd>T</kbd></div>` +
        hist
          .map((h) => `<div class="tl-row"><span class="tl-t">${h.gyrAgo.toFixed(2)} Ga</span><span class="tl-s">${esc(h.stage)}</span><span class="tl-x">${esc(h.text)}</span></div>`)
          .join('')
      : '';
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

  // ---- Tweakpane -------------------------------------------------------------------------------
  const pane = new Pane({ container: $('pane'), title: 'Planet Forge' });
  pane.registerPlugin(EssentialsPlugin);
  const fps = pane.addBlade({ view: 'fpsgraph', label: 'fps', rows: 2 }) as unknown as { begin(): void; end(): void };
  const tabs = pane.addTab({ pages: [{ title: 'Planet' }, { title: 'Look' }, { title: 'Light' }, { title: 'Debug' }] });
  const [tPlanet, tLook, tLight, tDebug] = tabs.pages;

  // Planet tab
  tPlanet.addBinding(state, 'autoRegen', { label: 'live regen' });
  tPlanet.addBinding(state, 'autoLook', { label: 'auto look' });
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
  function rebuildGenPane() {
    for (const f of genFolders) f.dispose();
    genFolders = [];
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
      else if (typeof (gen as unknown as Record<string, unknown>)[entry.key] === 'number') Object.assign(opts, { min: entry.min, max: entry.max, step: entry.step });
      folder.addBinding(gen as unknown as Record<string, unknown>, entry.key, opts).on('change', (ev) => {
        if (ev.last !== false) scheduleRegen();
      });
    }
  }
  function newSeed() {
    gen.seed = Math.floor(Math.random() * 100000);
    pane.refresh();
    regenerate();
  }

  // Look tab
  const fSurf = tLook.addFolder({ title: 'Surface' });
  fSurf.addBinding(look, 'heightExaggeration', { label: 'height exag.', min: 0, max: 8, step: 0.05 });
  fSurf.addBinding(look, 'detailAmp', { label: 'detail relief (m)', min: 0, max: 1500, step: 5 });
  fSurf.addBinding(look, 'detailScale', { label: 'detail size (km)', min: 0.5, max: 40, step: 0.1 });
  fSurf.addBinding(look, 'fineDetail', { label: 'fine relief', min: 0, max: 3, step: 0.05 });
  fSurf.addBinding(look, 'seaFloorScale', { label: 'seafloor scale', min: 0, max: 1, step: 0.01 });
  fSurf.addBinding(look, 'textureScale', { label: 'texture scale', min: 10, max: 2000, step: 1 });
  fSurf.addBinding(look, 'normalStrength', { label: 'detail normal', min: 0, max: 3, step: 0.01 });
  fSurf.addBinding(look, 'macroNormal', { label: 'relief normal', min: 0, max: 1, step: 0.01 });
  fSurf.addBinding(look, 'heightBlend', { label: 'height blend', min: 0, max: 2, step: 0.01 });
  fSurf.addBinding(look, 'triSharp', { label: 'triplanar sharp', min: 1, max: 32, step: 0.5 });
  fSurf.addBinding(look, 'antiTile', { label: 'anti-tiling', min: 0, max: 1, step: 0.01 });
  fSurf.addBinding(look, 'macroVar', { label: 'macro variation', min: 0, max: 1, step: 0.01 });
  fSurf.addBinding(look, 'tintStrength', { label: 'world tint', min: 0, max: 1.5, step: 0.01 });
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

  // Light tab
  tLight.addBinding(env, 'sunAzimuth', { label: 'sun azimuth', min: -180, max: 180, step: 0.5 });
  tLight.addBinding(env, 'sunElevation', { label: 'sun elevation', min: -89, max: 89, step: 0.5 });
  tLight.addBinding(env, 'dayCycle', { label: 'day cycle °/s', min: -30, max: 30, step: 0.1 });
  tLight.addBinding(env, 'sunIntensity', { label: 'sun intensity', min: 0, max: 30, step: 0.1 });
  tLight.addBinding(env, 'sunColor', { label: 'sun color' });
  tLight.addBinding(env, 'ambient', { label: 'space ambient', min: 0, max: 0.1, step: 0.0005 });
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
      for (const id of ['pane', 'hud', 'presets', 'help', 'timeline']) $(id).style.display = state.hideUi ? 'none' : '';
    }
    if (e.key === 't' || e.key === 'T') $('timeline').classList.toggle('collapsed');
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
  boot.classList.add('done');

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
    sky.update(camera, renderer.getPixelRatio());
    if (!state.meshSegments) view.autoMeshSegments(camera, renderer.domElement.height, controller.altitude);
    view.updateFootprint(camera, renderer.domElement.height);
    camInfo.text = `alt ${controller.altitude.toFixed(1)} km\nlat ${THREE.MathUtils.radToDeg(controller.lat).toFixed(1)}° lon ${THREE.MathUtils.radToDeg(controller.lon).toFixed(1)}°\nnear ${camera.near.toFixed(2)} far ${camera.far.toFixed(0)}`;
    pipeline.render(dt);
    fps.end();
  });

  // Expose for debugging in the console.
  Object.assign(window as unknown as Record<string, unknown>, {
    forge: { renderer, scene, camera, view, pipeline, controller, env, look, state, get gen() { return gen; }, regenerate, applyEnv, applyLook, loadPreset },
  });
}

main().catch((e) => {
  console.error(e);
  const boot = document.getElementById('boot');
  if (boot) boot.innerHTML = `<div class="err">Failed to start: ${(e as Error).message}</div>`;
});
