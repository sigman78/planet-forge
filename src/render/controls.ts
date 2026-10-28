import * as THREE from 'three';

/**
 * Planet orbit camera.
 * - Left drag: orbit (speed scales with altitude, so it feels the same from orbit and near the ground).
 * - Wheel / pinch: exponential zoom in altitude.
 * - Right drag (or shift+left): heading / pitch.
 * - Pitch automatically eases toward the horizon as you get close to the surface.
 */
export interface ViewState {
  lat: number;
  lon: number;
  altitude: number;
  heading: number;
  userPitch: number;
}

interface Flight {
  from: ViewState;
  to: ViewState;
  t: number;
  duration: number;
  onDone?: () => void;
}

const wrapPi = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

export class PlanetCameraController {
  lat = 0.35;
  lon = 0.6;
  altitude = 2400; // km above sea level
  heading = 0;
  userPitch = 0; // added to the automatic pitch, radians
  minAltitude = 0.4; // km above the terrain
  maxAltitude = 12000;
  autoTilt = true;
  autoRotate = 0; // rad/s around the planet axis
  radius = 800;
  /** Returns terrain surface radius (km) under a unit direction. */
  surface: (dir: THREE.Vector3) => number = () => this.radius;

  private target = { lat: 0.35, lon: 0.6, altitude: 2400, heading: 0, userPitch: 0 };
  /** Orbit inertia (rad/s in lat/lon), carried after the drag is released. */
  private vel = { lat: 0, lon: 0 };
  /** Recent drag steps, used to measure the release velocity. */
  private samples: { t: number; lat: number; lon: number }[] = [];
  /** Pitch and height above the ground from the last update (they scale drags). */
  private pitch = Math.PI / 2;
  private groundAlt = 2400;
  private groundR = 800;
  private flight: Flight | null = null;
  /** Called when the user takes over (pointer or wheel input). */
  onUserInput: (() => void) | null = null;
  private dragging: 'orbit' | 'look' | null = null;
  private last = new THREE.Vector2();
  private pointers = new Map<number, THREE.Vector2>();
  private pinchDist = 0;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
  ) {
    dom.addEventListener('pointerdown', this.onDown);
    dom.addEventListener('pointermove', this.onMove);
    dom.addEventListener('pointerup', this.onUp);
    dom.addEventListener('pointercancel', this.onUp);
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.style.touchAction = 'none';
  }

  setView(v: Partial<ViewState>, instant = false) {
    this.flight = null;
    Object.assign(this.target, v);
    if (instant) Object.assign(this, this.target);
  }

  get state() {
    return { ...this.target };
  }

  get flying() {
    return this.flight !== null;
  }

  /**
   * Fly to a view over `duration` seconds (ease in-out). Altitude moves in log space, angles take the short way
   * round. Pointer or wheel input cancels the flight.
   */
  flyTo(v: Partial<ViewState>, duration: number, onDone?: () => void) {
    const from: ViewState = { lat: this.lat, lon: this.lon, altitude: this.altitude, heading: this.heading, userPitch: this.userPitch };
    const to: ViewState = { ...from, ...v };
    to.lon = from.lon + wrapPi(to.lon - from.lon);
    to.heading = from.heading + wrapPi(to.heading - from.heading);
    to.altitude = THREE.MathUtils.clamp(to.altitude, this.minAltitude, this.maxAltitude);
    this.vel.lat = this.vel.lon = 0;
    this.flight = { from, to, t: 0, duration: Math.max(duration, 1e-3), onDone };
  }

  cancelFlight() {
    this.flight = null;
  }

  /** Change the reference radius but keep the camera at the same distance from the centre. */
  setRadius(R: number) {
    const shift = this.radius - R;
    this.radius = R;
    const fix = (a: number) => Math.max(a + shift, R * 0.05);
    this.altitude = fix(this.altitude);
    this.target.altitude = fix(this.target.altitude);
  }

  /** The user takes over: stop any flight where the view is now. */
  private takeOver() {
    if (this.flight) {
      this.flight = null;
      Object.assign(this.target, { lat: this.lat, lon: this.lon, altitude: this.altitude, heading: this.heading, userPitch: this.userPitch });
    }
    this.onUserInput?.();
  }

  private onDown = (e: PointerEvent) => {
    this.dom.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, new THREE.Vector2(e.clientX, e.clientY));
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchDist = a.distanceTo(b);
    }
    this.dragging = e.button === 2 || e.shiftKey ? 'look' : 'orbit';
    this.last.set(e.clientX, e.clientY);
    // Grabbing the planet stops it.
    this.vel.lat = this.vel.lon = 0;
    this.samples.length = 0;
    this.takeOver();
  };

  private onMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    const p = this.pointers.get(e.pointerId);
    if (p) p.set(e.clientX, e.clientY);
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = a.distanceTo(b);
      if (this.pinchDist > 0) this.zoomBy(Math.pow(this.pinchDist / d, 2));
      this.pinchDist = d;
      return;
    }
    const dx = e.clientX - this.last.x;
    const dy = e.clientY - this.last.y;
    this.last.set(e.clientX, e.clientY);
    const h = this.dom.clientHeight || 1;
    if (this.dragging === 'orbit') {
      // Angular speed so that the ground at the screen centre follows the mouse. When the view tilts toward the
      // horizon that ground is much farther away than the altitude: alt / sin(pitch), at most the horizon.
      const fovRad = (this.camera.fov * Math.PI) / 180;
      const alt = Math.max(this.groundAlt, 1e-3);
      const horizon = Math.sqrt(Math.max((this.groundR + alt) ** 2 - this.groundR ** 2, alt * alt));
      const D = THREE.MathUtils.clamp(alt / Math.max(Math.sin(this.pitch), 0.15), alt, horizon);
      const k = Math.min((D / this.radius) * fovRad, 2.2) / h;
      const ch = Math.cos(this.target.heading);
      const sh = Math.sin(this.target.heading);
      // Rotate screen motion by heading.
      const north = dy * ch + dx * sh;
      const east = -dx * ch + dy * sh;
      const lat0 = this.target.lat;
      this.target.lat = THREE.MathUtils.clamp(this.target.lat + north * k, -1.55, 1.55);
      const dLon = (east * k) / Math.max(Math.cos(this.target.lat), 0.05);
      this.target.lon += dLon;
      const now = performance.now();
      this.samples.push({ t: now, lat: this.target.lat - lat0, lon: dLon });
      while (this.samples.length && now - this.samples[0].t > 100) this.samples.shift();
    } else {
      this.target.heading += (dx / h) * 2.5;
      this.target.userPitch = THREE.MathUtils.clamp(this.target.userPitch + (dy / h) * 2.0, -1.2, 1.2);
    }
  };

  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) {
      // Throw velocity from the last ~100 ms of the drag. A pause before letting go means no throw.
      const now = performance.now();
      const recent = this.samples.filter((p) => now - p.t < 100);
      if (this.dragging === 'orbit' && recent.length >= 2 && now - recent[recent.length - 1].t < 50) {
        const span = Math.max((now - recent[0].t) / 1000, 1 / 60);
        let dLat = 0, dLon = 0;
        for (const p of recent) {
          dLat += p.lat;
          dLon += p.lon;
        }
        this.vel.lat = dLat / span;
        this.vel.lon = dLon / span;
      }
      this.samples.length = 0;
      this.dragging = null;
    }
    this.pinchDist = 0;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.takeOver();
    const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    this.zoomBy(Math.exp(delta * 0.0012));
  };

  zoomBy(f: number) {
    this.target.altitude = THREE.MathUtils.clamp(this.target.altitude * f, this.minAltitude, this.maxAltitude);
  }

  private dir = new THREE.Vector3();

  update(dt: number) {
    if (this.flight) {
      // Scripted flight drives the view directly; the target follows, so nothing eases afterwards.
      const f = this.flight;
      f.t = Math.min(f.t + dt / f.duration, 1);
      const e = f.t * f.t * (3 - 2 * f.t);
      const L = THREE.MathUtils.lerp;
      this.lat = L(f.from.lat, f.to.lat, e);
      this.lon = L(f.from.lon, f.to.lon, e);
      this.altitude = Math.exp(L(Math.log(Math.max(f.from.altitude, 1e-3)), Math.log(Math.max(f.to.altitude, 1e-3)), e));
      this.heading = L(f.from.heading, f.to.heading, e);
      this.userPitch = L(f.from.userPitch, f.to.userPitch, e);
      Object.assign(this.target, { lat: this.lat, lon: this.lon, altitude: this.altitude, heading: this.heading, userPitch: this.userPitch });
      if (f.t >= 1) {
        this.flight = null;
        f.onDone?.();
      }
    } else {
      this.target.lon += this.autoRotate * dt;
      // Inertia: keep drifting after a throw, decaying over about 0.7 s.
      if (!this.dragging && (this.vel.lat !== 0 || this.vel.lon !== 0)) {
        this.target.lat = THREE.MathUtils.clamp(this.target.lat + this.vel.lat * dt, -1.55, 1.55);
        this.target.lon += this.vel.lon * dt;
        const d = Math.exp(-dt / 0.7);
        this.vel.lat *= d;
        this.vel.lon *= d;
        if (Math.abs(this.vel.lat) + Math.abs(this.vel.lon) < 1e-5) this.vel.lat = this.vel.lon = 0;
      }
    }
    const a = 1 - Math.exp(-dt * 8);
    this.lat += (this.target.lat - this.lat) * a;
    this.lon += (this.target.lon - this.lon) * a;
    // Altitude eases in log space for a smooth exponential zoom.
    this.altitude = Math.exp(Math.log(this.altitude) + (Math.log(this.target.altitude) - Math.log(this.altitude)) * a);
    this.heading += (this.target.heading - this.heading) * a;
    this.userPitch += (this.target.userPitch - this.userPitch) * a;

    const n = this.dir.set(
      Math.cos(this.lat) * Math.sin(this.lon),
      Math.sin(this.lat),
      Math.cos(this.lat) * Math.cos(this.lon),
    );
    // Keep above the terrain.
    const ground = this.surface(n);
    const minR = ground + this.minAltitude;
    let r = this.radius + this.altitude;
    if (r < minR) {
      r = minR;
      this.altitude = r - this.radius;
      this.target.altitude = Math.max(this.target.altitude, this.altitude);
    }
    const pos = n.clone().multiplyScalar(r);

    // Local frame: north tangent & east.
    const worldUp = new THREE.Vector3(0, 1, 0);
    let east = new THREE.Vector3().crossVectors(worldUp, n);
    if (east.lengthSq() < 1e-8) east.set(1, 0, 0);
    east.normalize();
    const north = new THREE.Vector3().crossVectors(n, east).normalize();
    // Forward tangent rotated by heading.
    const fwd = north.clone().multiplyScalar(Math.cos(this.heading)).addScaledVector(east, Math.sin(this.heading));

    // Pitch: 90deg (looking at the planet centre) when far, toward the horizon when low.
    const altAboveGround = r - ground;
    const t = this.autoTilt ? THREE.MathUtils.smoothstep(Math.log(altAboveGround), Math.log(15), Math.log(1500)) : 1;
    // Horizon dip angle so "horizon" view still shows a little ground.
    const horizonPitch = Math.acos(Math.min(ground / r, 1)) + 0.12;
    let pitch = THREE.MathUtils.lerp(horizonPitch, Math.PI / 2, t) - this.userPitch;
    pitch = THREE.MathUtils.clamp(pitch, -0.3, Math.PI / 2);
    this.pitch = pitch;
    this.groundAlt = altAboveGround;
    this.groundR = ground;

    const view = fwd.clone().multiplyScalar(Math.cos(pitch)).addScaledVector(n, -Math.sin(pitch)).normalize();
    const up = fwd.clone().multiplyScalar(Math.sin(pitch)).addScaledVector(n, Math.cos(pitch)).normalize();
    const z = view.clone().negate();
    const x = new THREE.Vector3().crossVectors(up, z).normalize();
    const y = new THREE.Vector3().crossVectors(z, x);
    this.camera.position.copy(pos);
    this.camera.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));

    // Depth range adapted to altitude.
    const near = THREE.MathUtils.clamp(altAboveGround * 0.25, 0.02, 200);
    const far = r + this.radius * 1.5 + 200;
    if (Math.abs(this.camera.near - near) > near * 0.05 || this.camera.far !== far) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
  }
}
