import * as THREE from 'three';
import type { Poi } from '../core/types.ts';
import type { PlanetCameraController, ViewState } from '../render/controls.ts';

/**
 * Auto tour: a scripted camera flight built from the world's landmarks and the current sun.
 *   1. Orbit pass over the top landmarks (labels on, one caption each).
 *   2. Terminator: look along the day-night line from medium height.
 *   3. Low flyby across a lit landmark.
 *   4. Climb away toward the night side.
 *   5. Crescent: the camera hangs behind the planet and the star slowly rises past the limb.
 * Any pointer or wheel input stops it where it is.
 */
export interface TourHost {
  controller: PlanetCameraController;
  /** Datum radius, km. */
  radius(): number;
  sunDir(): THREE.Vector3;
  pois(): Poi[];
  caption(kind: string, title: string, text: string): void;
  /** Show or hide the landmark labels (hidden for the night-side finale). */
  labels(on: boolean): void;
  /** Called once the tour ends or is cancelled. */
  done(): void;
}

interface Step {
  view: Partial<ViewState>;
  /** Flight time, s. */
  fly: number;
  /** Pause after arriving, s. */
  hold: number;
  caption?: [string, string, string];
  labels?: boolean;
}

const DEG = Math.PI / 180;

/** Unit direction -> controller lat / lon (same convention as the camera). */
function latLon(d: THREE.Vector3) {
  return { lat: Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)), lon: Math.atan2(d.x, d.z) };
}

/** Compass heading (from north, toward east) of a tangent direction t at the unit point n. */
function headingOf(n: THREE.Vector3, t: THREE.Vector3) {
  const east = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), n);
  if (east.lengthSq() < 1e-8) east.set(1, 0, 0);
  east.normalize();
  const north = new THREE.Vector3().crossVectors(n, east).normalize();
  return Math.atan2(t.dot(east), t.dot(north));
}

/** Tangent part of v at the unit point n, normalized (or any tangent when v is radial). */
function tangent(n: THREE.Vector3, v: THREE.Vector3) {
  const t = v.clone().addScaledVector(n, -v.dot(n));
  if (t.lengthSq() < 1e-8) t.crossVectors(n, Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0));
  return t.normalize();
}

/** Point reached by walking `ang` radians from unit n along tangent t. */
function walk(n: THREE.Vector3, t: THREE.Vector3, ang: number) {
  return n.clone().multiplyScalar(Math.cos(ang)).addScaledVector(t, Math.sin(ang)).normalize();
}

export class Tour {
  private steps: Step[] = [];
  private index = 0;
  private timer = 0;
  private savedRotate = 0;
  active = false;

  constructor(private host: TourHost) {}

  toggle() {
    if (this.active) this.stop();
    else this.start();
  }

  start() {
    const h = this.host;
    const c = h.controller;
    this.steps = this.plan();
    if (!this.steps.length) return;
    this.active = true;
    this.index = 0;
    this.savedRotate = c.autoRotate;
    c.autoRotate = 0;
    // Any user input ends the tour where the camera is.
    c.onUserInput = () => this.stop();
    this.next();
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    clearTimeout(this.timer);
    const c = this.host.controller;
    c.cancelFlight();
    c.onUserInput = null;
    c.autoRotate = this.savedRotate;
    this.host.labels(true);
    this.host.done();
  }

  private next() {
    if (!this.active) return;
    if (this.index >= this.steps.length) {
      this.stop();
      return;
    }
    const s = this.steps[this.index++];
    if (s.labels !== undefined) this.host.labels(s.labels);
    this.host.controller.flyTo(s.view, s.fly, () => {
      // Captions describe what is on screen, so they come up on arrival.
      if (s.caption) this.host.caption(...s.caption);
      this.timer = window.setTimeout(() => this.next(), s.hold * 1000);
    });
  }

  private plan(): Step[] {
    const h = this.host;
    const c = h.controller;
    const R = h.radius();
    const S = h.sunDir().clone().normalize();
    const pois = h.pois();
    const steps: Step[] = [];
    const dir = (p: Poi) => new THREE.Vector3(p.dir[0], p.dir[1], p.dir[2]);
    const camDir = new THREE.Vector3(Math.cos(c.lat) * Math.sin(c.lon), Math.sin(c.lat), Math.cos(c.lat) * Math.cos(c.lon));

    // 1. Orbit pass: the strongest landmarks on the day side, in an order that keeps the hops short.
    const lit = pois.filter((p) => dir(p).dot(S) > 0.15).slice(0, 4);
    const tourStops: Poi[] = [];
    let at = camDir.clone();
    const left = [...lit];
    while (left.length) {
      left.sort((a, b) => dir(b).dot(at) - dir(a).dot(at));
      const p = left.shift()!;
      tourStops.push(p);
      at = dir(p);
    }
    // No lit landmarks: show the sunlit face instead.
    if (!tourStops.length) {
      steps.push({ view: { ...latLon(walk(S, tangent(S, camDir), 25 * DEG)), altitude: R * 1.6, heading: 0, userPitch: 0 }, fly: 5, hold: 2 });
    }
    for (const p of tourStops) {
      const d = dir(p);
      // Sit a little sunward of the feature so it is seen with relief, not head-on under a noon sun.
      const v = walk(d, tangent(d, S), -Math.min(p.radius * 0.4, 12 * DEG));
      steps.push({
        view: { ...latLon(v), altitude: R * 1.25, heading: 0, userPitch: 0 },
        fly: 5,
        hold: 2.6,
        caption: [p.kind, p.name, p.text],
      });
    }

    // 2. Terminator: just on the day side of the line nearest the last stop, looking along it.
    const last = tourStops.length ? dir(tourStops[tourStops.length - 1]) : camDir;
    const onLine = tangent(S, last); // point on the terminator great circle closest to `last`
    const tn = walk(onLine, S, 6 * DEG);
    const sT = tangent(tn, S);
    const along = new THREE.Vector3().crossVectors(tn, sT).normalize();
    // Look along the line, turned a little toward the night so the shadow side fills part of the frame.
    const look = along.clone().multiplyScalar(Math.cos(25 * DEG)).addScaledVector(sT, -Math.sin(25 * DEG)).normalize();
    // Aim a little below the horizon.
    const tAlt = R * 0.3;
    const dip = Math.acos(R / (R + tAlt));
    steps.push({
      view: { ...latLon(tn), altitude: tAlt, heading: headingOf(tn, look), userPitch: c.userPitchFor(dip + 0.16, tAlt) },
      fly: 6,
      hold: 3,
      caption: ['terminator', 'Day and night', 'Long shadows where the sun stands low.'],
    });

    // 3. Flyby: across the lit landmark closest to the terminator (the lowest sun gives the most relief).
    const fly = pois.filter((p) => dir(p).dot(S) > 0.12).sort((a, b) => dir(a).dot(S) - dir(b).dot(S))[0];
    const fp = fly ? dir(fly) : tn;
    // Cross-lit: fly along the terminator, turned a little toward the sun, so shadows stretch to the side and
    // the haze ahead glows (straight down-sun the far flanks are already in shadow and the frame goes black).
    const fs = tangent(fp, S);
    const fdir = new THREE.Vector3().crossVectors(fp, fs).normalize().multiplyScalar(Math.cos(25 * DEG)).addScaledVector(fs, Math.sin(25 * DEG)).normalize();
    const arc = Math.min(0.09, 320 / R);
    const A = walk(fp, fdir, -arc * 0.6);
    const B = walk(fp, fdir, arc * 0.6);
    const ground = (d: THREE.Vector3) => c.surface(d) - R;
    const flyAlt = Math.max(ground(A), ground(fp), ground(B)) + Math.max(14, Math.min(R * 0.008, 40));
    steps.push({
      view: { ...latLon(A), altitude: flyAlt, heading: headingOf(A, tangent(A, fp.clone().sub(A))), userPitch: -0.1 },
      fly: 7,
      hold: 0,
      caption: fly ? ['flyby', fly.name, fly.text] : undefined,
    });
    steps.push({
      view: { ...latLon(B), altitude: flyAlt, heading: headingOf(B, tangent(B, B.clone().sub(fp))), userPitch: -0.1 },
      fly: 12,
      hold: 0,
    });

    // 4-5. Lift off toward the night side, then hang behind the planet while the star rises past the limb.
    // From distance D the disc spans asin(R/D); the sun sits just outside it.
    const alt = Math.max(R * 3, 1600);
    const D = R + alt;
    const rim = Math.asin(R / D);
    const q = tangent(S.clone().negate(), B); // which side of the anti-sun point to hang on
    const cres = (eps: number) => walk(S.clone().negate(), q, rim + eps);
    const hide = cres(-5 * DEG);
    steps.push({
      // Looking back down at the planet while climbing.
      view: { ...latLon(walk(B, tangent(B, hide), 0.35)), altitude: R * 0.6, userPitch: c.userPitchFor(Math.PI / 2, R * 0.6) },
      fly: 6,
      hold: 0,
      caption: ['departure', 'Leaving orbit', 'Climbing out over the night side.'],
      labels: false,
    });
    steps.push({ view: { ...latLon(hide), altitude: alt, heading: 0, userPitch: 0 }, fly: 8, hold: 0.5 });
    steps.push({ view: { ...latLon(cres(0.15 * DEG)), altitude: alt }, fly: 9, hold: 4 });
    return steps;
  }
}
