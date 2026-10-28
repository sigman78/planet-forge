import * as THREE from 'three';
import { Pane, type FolderApi, type TabPageApi } from 'tweakpane';
import * as EssentialsPlugin from '@tweakpane/plugin-essentials';
import { sampleDir } from './core/cube.ts';
import type { PlanetData } from './core/types.ts';
import { DEFAULT_PARAMS, GEN_PRESETS, PARAM_SCHEMA, presetParams, type GenParams } from './gen/params.ts';
import { generate } from './app/generate.ts';
import { DEFAULT_ENV, PLANET_PRESETS, planetName, type EnvParams } from './app/presets.ts';
import { download, exportPlanet } from './app/export.ts';
import { loadTerrainTextures } from './render/terrainTextures.ts';
import { createSharedUniforms, DEFAULT_LOOK, PlanetView, type LookParams } from './render/planetView.ts';
import { Pipeline } from './render/pipeline.ts';
import { createSky, type Sky } from './render/sky.ts';
import { PlanetCameraController } from './render/controls.ts';

const $ = (id: string) => document.getElementById(id)!;

const DEBUG_VIEWS: Record<string, number> = {
  Lit: 0, Albedo: 1, Normals: 2, Height: 3, 'Splat layers': 4, Biomes: 5, Temperature: 6, Moisture: 7, 'Water flow': 8, 'Cube faces': 9, 'AO / rough': 10,
};

async function main() {
  // ---- Renderer --------------------------------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.autoClear = true;
  $('app').appendChild(renderer.domElement);
  if (!renderer.extensions.has('OES_texture_float_linear')) {
    console.warn('OES_texture_float_linear missing: heightmap filtering will be nearest on this GPU.');
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(DEFAULT_ENV.fov, window.innerWidth / window.innerHeight, 1, 1e5);

  // ---- State -----------------------------------------------------------------------------------
  const state = {
    preset: 'terran',
    autoRegen: true,
    meshSegments: 384,
    hideUi: false,
  };
  let gen: GenParams = presetParams('terran', { seed: Math.floor(Math.random() * 100000), resolution: DEFAULT_PARAMS.resolution });
  const look: LookParams = { ...DEFAULT_LOOK, ...PLANET_PRESETS.terran.look };
  const env: EnvParams = structuredClone({ ...DEFAULT_ENV, ...PLANET_PRESETS.terran.env });

  // ---- Assets ----------------------------------------------------------------------------------
  const boot = $('boot');
  boot.textContent = 'LOADING MATERIALS…';
  const shared = createSharedUniforms();
  const [layers, sky] = await Promise.all([
    loadTerrainTextures(renderer, '/textures/', undefined, (f) => (boot.textContent = `LOADING MATERIALS ${Math.round(f * 100)}%`)),
    createSky(scene, shared) as Promise<Sky>,
  ]);

  const view = new PlanetView(renderer, shared, layers);
  view.setMeshSegments(state.meshSegments);
  scene.add(view.group);

  const pipeline = new Pipeline(renderer, scene, camera, shared);
  const controller = new PlanetCameraController(camera, renderer.domElement);
  controller.surface = (dir) => {
    const d = view.data;
    if (!d) return shared.uPlanetRadius.value;
    return view.surfaceRadiusKm(dir, (x, y, z) => sampleDir(d.height, d.N, x, y, z));
  };

  // ---- Apply settings --------------------------------------------------------------------------
  const sunDir = new THREE.Vector3();
  function applyEnv() {
    const az = THREE.MathUtils.degToRad(env.sunAzimuth);
    const el = THREE.MathUtils.degToRad(env.sunElevation);
    sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
    shared.uSunDir.value.copy(sunDir);
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
    shared.uAtmoDensity.value = env.atmoDensity;
    pipeline.atmoUniforms.uSteps.value = env.atmoSteps;
    // Sky ambient: the colour of the scattering, scaled by density and sun strength.
    const r = env.rayleigh;
    const m = Math.max(r.x, r.y, r.z, 1e-6);
    const k = 0.11 * Math.min(env.atmoDensity, 1.5) * (env.sunIntensity / 6);
    shared.uSkyAmbient.value.setRGB((r.x / m) * k, (r.y / m) * k, (r.z / m) * k);
    shared.uAmbient.value = env.ambient;
    shared.uCloudShadow.value = env.cloudShadow;
    shared.uCloudAlt.value = env.cloudAltitude;
    shared.uCloudCover.value = env.cloudCover;
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
      controller.radius = planet.radius / 1000;
      applyEnv();
      applyLook();
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
  function scheduleRegen() {
    if (!state.autoRegen) return;
    clearTimeout(regenTimer);
    regenTimer = window.setTimeout(regenerate, 250);
  }

  function updateHud(p: PlanetData, ms: number) {
    $('pname').textContent = planetName(gen.seed);
    $('pclass').textContent = `${PLANET_PRESETS[state.preset]?.label ?? 'Custom'} world · seed ${gen.seed}`;
    let water = 0;
    const T = p.T;
    for (let f = 0; f < 6; f++) for (let y = 1; y <= p.N; y += 2) for (let x = 1; x <= p.N; x += 2) if (p.height[(f * T + y) * T + x] < 0) water++;
    const frac = water / (6 * Math.ceil(p.N / 2) ** 2);
    const timings = p.timings ? Object.entries(p.timings).map(([k, v]) => `${k} ${Math.round(v)}`).join(' · ') : '';
    $('pfacts').innerHTML =
      `radius   <span>${(p.radius / 1000).toFixed(0)} km</span>\n` +
      `surface  <span>${(gen.seaKind === 'none' ? 'no seas' : `${(frac * 100).toFixed(0)}% ${gen.seaKind}`)}</span>\n` +
      `relief   <span>${(p.minHeight / 1000).toFixed(1)} … +${(p.maxHeight / 1000).toFixed(1)} km</span>\n` +
      `faces    <span>6 × ${p.N}²</span>\n` +
      `forged   <span>${(ms / 1000).toFixed(2)} s</span>${timings ? `\n<span style="color:var(--dim)">${timings}</span>` : ''}`;
  }

  // ---- Presets bar -----------------------------------------------------------------------------
  const presetBar = $('presets');
  function loadPreset(name: string, keepSeed = true) {
    const p = PLANET_PRESETS[name];
    if (!p) return;
    state.preset = name;
    gen = presetParams(p.gen, { seed: keepSeed ? gen.seed : Math.floor(Math.random() * 100000), resolution: gen.resolution });
    Object.assign(look, DEFAULT_LOOK, p.look, { vegTint: p.vegTint ?? '#ffffff', debug: look.debug });
    Object.assign(env, structuredClone({ ...DEFAULT_ENV, ...p.env, sunAzimuth: env.sunAzimuth, sunElevation: env.sunElevation, fov: env.fov }));
    for (const b of presetBar.querySelectorAll('button')) b.classList.toggle('active', b.dataset.preset === name);
    rebuildGenPane();
    pane.refresh();
    applyEnv();
    applyLook();
    regenerate();
  }
  for (const [key, p] of Object.entries(PLANET_PRESETS)) {
    if (!GEN_PRESETS[p.gen] && p.gen !== 'terran') continue;
    const b = document.createElement('button');
    b.textContent = p.label;
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
  const actions = tPlanet.addBlade({ view: 'buttongrid', size: [3, 1], cells: (x: number) => ({ title: ['Forge', 'New seed', 'Export'][x] }) }) as unknown as {
    on(ev: 'click', cb: (e: { index: [number, number] }) => void): void;
  };
  actions.on('click', (e) => {
    const i = e.index[0];
    if (i === 0) regenerate();
    if (i === 1) newSeed();
    if (i === 2 && view.data) download(exportPlanet(view.data, { params: gen, preset: state.preset, name: planetName(gen.seed) }), `${planetName(gen.seed).replace(/\s+/g, '_')}_${gen.seed}.planet`);
  });
  let genFolders: FolderApi[] = [];
  function rebuildGenPane() {
    for (const f of genFolders) f.dispose();
    genFolders = [];
    const groups = new Map<string, FolderApi>();
    for (const entry of PARAM_SCHEMA) {
      let folder = groups.get(entry.group);
      if (!folder) {
        folder = (tPlanet as TabPageApi).addFolder({ title: entry.group, expanded: entry.group === 'General' || entry.group === 'Continents' });
        groups.set(entry.group, folder);
        genFolders.push(folder);
      }
      const opts: Record<string, unknown> = { label: entry.label };
      if (entry.options) opts.options = entry.options;
      else Object.assign(opts, { min: entry.min, max: entry.max, step: entry.step });
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
  fSurf.addBinding(look, 'seaFloorScale', { label: 'seafloor scale', min: 0, max: 1, step: 0.01 });
  fSurf.addBinding(look, 'textureScale', { label: 'texture scale', min: 10, max: 2000, step: 1 });
  fSurf.addBinding(look, 'normalStrength', { label: 'detail normal', min: 0, max: 3, step: 0.01 });
  fSurf.addBinding(look, 'macroNormal', { label: 'relief normal', min: 0, max: 1, step: 0.01 });
  fSurf.addBinding(look, 'heightBlend', { label: 'height blend', min: 0, max: 2, step: 0.01 });
  fSurf.addBinding(look, 'triSharp', { label: 'triplanar sharp', min: 1, max: 32, step: 0.5 });
  fSurf.addBinding(look, 'macroVar', { label: 'macro variation', min: 0, max: 1, step: 0.01 });
  fSurf.addBinding(look, 'climateTint', { label: 'climate tint', min: 0, max: 1, step: 0.01 });
  fSurf.addBinding(look, 'vegTint', { label: 'vegetation tint' });
  fSurf.addBinding(look, 'wetness', { min: 0, max: 1, step: 0.01 });
  fSurf.addBinding(look, 'rivers', { min: 0, max: 1, step: 0.01 });
  fSurf.addBinding(look, 'cityLights', { label: 'city lights', min: 0, max: 5, step: 0.05 });
  const fOcean = tLook.addFolder({ title: 'Ocean' });
  fOcean.addBinding(look, 'oceanMode', { label: 'mode', options: { water: 0, lava: 1, ice: 2, none: 3 } });
  fOcean.addBinding(look, 'deepColor', { label: 'deep' });
  fOcean.addBinding(look, 'shallowColor', { label: 'shallow' });
  fOcean.addBinding(look, 'clarity', { label: 'clarity (m)', min: 1, max: 300, step: 1 });
  fOcean.addBinding(look, 'waveScale', { label: 'wave scale', min: 0.05, max: 5, step: 0.01 });
  fOcean.addBinding(look, 'waveStrength', { label: 'wave strength', min: 0, max: 1.5, step: 0.01 });
  fOcean.addBinding(look, 'foam', { min: 0, max: 2, step: 0.01 });
  fOcean.addBinding(look, 'lavaColor', { label: 'lava' });
  fOcean.addBinding(look, 'lavaGlow', { label: 'lava glow', min: 0, max: 60, step: 0.1 });
  const fClouds = tLook.addFolder({ title: 'Clouds' });
  fClouds.addBinding(look, 'cloudsVisible', { label: 'visible' });
  fClouds.addBinding(env, 'cloudCover', { label: 'coverage', min: 0, max: 1, step: 0.01 });
  fClouds.addBinding(look, 'cloudOpacity', { label: 'opacity', min: 0, max: 1, step: 0.01 });
  fClouds.addBinding(look, 'cloudTint', { label: 'tint' });
  fClouds.addBinding(env, 'cloudSpeed', { label: 'drift speed', min: 0, max: 20, step: 0.1 });
  fClouds.addBinding(env, 'cloudShadow', { label: 'shadows', min: 0, max: 1, step: 0.01 });
  fClouds.addBinding(env, 'cloudAltitude', { label: 'altitude (km)', min: 1, max: 40, step: 0.5 });
  const fAtmo = tLook.addFolder({ title: 'Atmosphere' });
  fAtmo.addBinding(env, 'atmoDensity', { label: 'density', min: 0, max: 4, step: 0.01 });
  fAtmo.addBinding(env, 'atmoHeight', { label: 'height (km)', min: 10, max: 300, step: 1 });
  fAtmo.addBinding(env, 'rayleigh', { label: 'rayleigh β', x: { min: 0, max: 60 }, y: { min: 0, max: 60 }, z: { min: 0, max: 60 } });
  fAtmo.addBinding(env, 'rayleighH', { label: 'rayleigh H', min: 1, max: 40, step: 0.1 });
  fAtmo.addBinding(env, 'mie', { label: 'mie β', min: 0, max: 60, step: 0.1 });
  fAtmo.addBinding(env, 'mieH', { label: 'mie H', min: 0.2, max: 20, step: 0.1 });
  fAtmo.addBinding(env, 'mieG', { label: 'mie g', min: 0, max: 0.99, step: 0.01 });
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
  tDebug.addBinding(state, 'meshSegments', { label: 'mesh / face', options: { '128': 128, '256': 256, '384': 384, '512': 512, '768': 768 } }).on('change', () => view.setMeshSegments(state.meshSegments));
  const camInfo = { text: '' };
  tDebug.addBinding(camInfo, 'text', { label: 'camera', readonly: true, multiline: true, rows: 3, interval: 250 });
  tDebug.addButton({ title: 'Screenshot (PNG)' }).on('click', () => {
    pipeline.render(0);
    renderer.domElement.toBlob((b) => b && download(b, `${planetName(gen.seed)}_${gen.seed}.png`), 'image/png');
  });

  // Renderer-side settings are cheap to apply, so any pane change re-applies them.
  pane.on('change', () => { applyLook(); applyEnv(); });

  // ---- Keyboard --------------------------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === 'r' || e.key === 'R') newSeed();
    if (e.key === 'h' || e.key === 'H') {
      state.hideUi = !state.hideUi;
      for (const id of ['pane', 'hud', 'presets', 'help']) $(id).style.display = state.hideUi ? 'none' : '';
    }
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
  loadPreset('terran');
  controller.setView({ altitude: 2600, lat: 0.3, lon: 0.4 }, true);
  boot.classList.add('done');

  const timer = new THREE.Timer();
  let time = 0;
  let paneRefreshT = 0;
  const cloudRot4 = new THREE.Matrix4();
  renderer.setAnimationLoop(() => {
    fps.begin();
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1);
    time += dt;
    if (env.dayCycle !== 0) {
      env.sunAzimuth = ((env.sunAzimuth + env.dayCycle * dt + 540) % 360) - 180;
      applyEnv();
      paneRefreshT += dt;
      if (paneRefreshT > 0.5) { paneRefreshT = 0; pane.refresh(); }
    }
    shared.uTime.value = time;
    cloudRot4.makeRotationY(time * env.cloudSpeed * 0.002);
    shared.uCloudRot.value.setFromMatrix4(cloudRot4);
    controller.update(dt);
    sky.update(camera, renderer.getPixelRatio());
    camInfo.text = `alt ${controller.altitude.toFixed(1)} km\nlat ${THREE.MathUtils.radToDeg(controller.lat).toFixed(1)}° lon ${THREE.MathUtils.radToDeg(controller.lon).toFixed(1)}°\nnear ${camera.near.toFixed(2)} far ${camera.far.toFixed(0)}`;
    pipeline.render(dt);
    fps.end();
  });

  // Expose for debugging in the console.
  Object.assign(window as unknown as Record<string, unknown>, { forge: { renderer, scene, camera, view, pipeline, controller, env, look, get gen() { return gen; }, regenerate, applyEnv, applyLook } });
}

main().catch((e) => {
  console.error(e);
  const boot = document.getElementById('boot');
  if (boot) boot.innerHTML = `<div class="err">Failed to start: ${(e as Error).message}</div>`;
});
