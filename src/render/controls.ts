import * as THREE from 'three';

/**
 * Planet orbit camera.
 * - Left drag: orbit (speed scales with altitude, so it feels the same from orbit and near the ground).
 * - Wheel / pinch: exponential zoom in altitude.
 * - Right drag (or shift+left): heading / pitch.
 * - Keys: W/S fly toward / away from the point under the cursor, A/D strafe, E/Q up / down, arrows turn,
 *   shift = faster. Speed scales with the height above the ground.
 * - Pitch automatically eases toward the horizon as you get close to the surface.
 *
 * Where the camera stands and which way it faces is one quaternion (`frame`: x = right, y = local up,
 * -z = forward along the ground). Drags rotate that frame, so there is no pole and no gimbal lock; lat, lon and
 * heading are read back from it for the HUD, the tour and `flyTo`.
 */
export interface ViewState {
  lat: number;
  lon: number;
  altitude: number;
  heading: number;
  userPitch: number;
}

interface Flight {
  q0: THREE.Quaternion;
  /** Shortest rotation taking the start position to the end position. */
  move: THREE.Quaternion;
  /** Heading change still needed at the end, after carrying the start heading along the path. */
  twist: number;
  alt0: number;
  alt1: number;
  pitch0: number;
  pitch1: number;
  t: number;
  duration: number;
  onDone?: () => void;
}

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();

/** Unit position (local up) of a frame. */
const upOf = (q: THREE.Quaternion, out = new THREE.Vector3()) => out.set(0, 1, 0).applyQuaternion(q);
/** Forward tangent of a frame. */
const fwdOf = (q: THREE.Quaternion, out = new THREE.Vector3()) => out.set(0, 0, -1).applyQuaternion(q);
/** Right tangent of a frame. */
const rightOf = (q: THREE.Quaternion, out = new THREE.Vector3()) => out.set(1, 0, 0).applyQuaternion(q);

/** East and north at a unit position (any pair at the exact poles). */
function eastNorth(n: THREE.Vector3, east: THREE.Vector3, north: THREE.Vector3) {
  east.crossVectors(Y, n);
  if (east.lengthSq() < 1e-12) east.set(1, 0, 0);
  east.normalize();
  north.crossVectors(n, east).normalize();
}

/** Frame standing at lat/lon facing `heading` (clockwise from north). */
function frameFrom(lat: number, lon: number, heading: number, out = new THREE.Quaternion()) {
  const n = new THREE.Vector3(Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon));
  const east = new THREE.Vector3(), north = new THREE.Vector3();
  eastNorth(n, east, north);
  const f = north.multiplyScalar(Math.cos(heading)).addScaledVector(east, Math.sin(heading));
  const right = new THREE.Vector3().crossVectors(f, n);
  return out.setFromRotationMatrix(_m.makeBasis(right, n, f.negate()));
}

/** Lat, lon and heading read from a frame. */
function anglesOf(q: THREE.Quaternion) {
  const n = upOf(q), f = fwdOf(q);
  const east = new THREE.Vector3(), north = new THREE.Vector3();
  eastNorth(n, east, north);
  return {
    lat: Math.asin(THREE.MathUtils.clamp(n.y, -1, 1)),
    lon: Math.atan2(n.x, n.z),
    heading: Math.atan2(f.dot(east), f.dot(north)),
  };
}

/** Rotate a frame in place by a world rotation, renormalised so rounding never builds up. */
function turn(q: THREE.Quaternion, r: THREE.Quaternion) {
  return q.premultiply(r).normalize();
}

const FLY_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

export class PlanetCameraController {
  altitude = 2400; // km above sea level
  userPitch = 0; // added to the automatic pitch, radians
  minAltitude = 0.4; // km above the terrain
  maxAltitude = 12000;
  /** Smallest near plane (km). A reversed depth buffer keeps its precision at any near plane; set it lower then. */
  nearFloor = 0.02;
  autoTilt = true;
  autoRotate = 0; // rad/s around the planet axis
  radius = 800;
  /** Fly speed in heights-above-ground per second. */
  flySpeed = 1.2;
  /** Returns terrain surface radius (km) under a unit direction. */
  surface: (dir: THREE.Vector3) => number = () => this.radius;
  /**
   * Highest ground radius (km) among the samples `probeDirs` asked for (each less its allowance), set by the
   * host when a reading arrives; NaN when there is none. The camera eases up to `minAltitude` above it.
   */
  probeFloor = NaN;
  /** The eased floor radius (km) the camera keeps above and its rate (km/s); NaN until the first update. */
  private floorR = NaN;
  private floorV = 0;
  /** Camera velocity (km/s) over the last update, for the look-ahead samples. */
  private vel = new THREE.Vector3();
  private prevPos = new THREE.Vector3();
  private hasPrev = false;

  /** Current frame (eases toward `target.frame`). */
  private frame = frameFrom(0.35, 0.6, 0);
  private target = { frame: frameFrom(0.35, 0.6, 0), altitude: 2400, userPitch: 0 };
  /** Orbit inertia: world rotation axis scaled by rad/s, carried after the drag is released. */
  private spin = new THREE.Vector3();
  /** Recent drag steps (rotation vectors), used to measure the release velocity. */
  private samples: { t: number; rot: THREE.Vector3 }[] = [];
  /** Pitch and height above the ground from the last update (they scale drags). */
  private pitch = Math.PI / 2;
  private groundAlt = 2400;
  private groundR = 800;
  private flight: Flight | null = null;
  /** Called when the user takes over (pointer, wheel or fly keys). */
  onUserInput: (() => void) | null = null;
  private dragging: 'orbit' | 'look' | null = null;
  private last = new THREE.Vector2();
  private pointers = new Map<number, THREE.Vector2>();
  private pinchDist = 0;
  /** Cursor in normalised device coordinates (the screen centre when it is off the canvas). */
  private cursor = new THREE.Vector2();
  private keys = new Set<string>();

  constructor(
    private camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
  ) {
    dom.addEventListener('pointerdown', this.onDown);
    dom.addEventListener('pointermove', this.onMove);
    dom.addEventListener('pointerup', this.onUp);
    dom.addEventListener('pointercancel', this.onUp);
    dom.addEventListener('pointerleave', () => !this.dragging && this.cursor.set(0, 0));
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      this.shiftHeld = e.shiftKey;
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.shiftHeld = false;
    });
    dom.style.touchAction = 'none';
  }

  get lat() {
    return anglesOf(this.frame).lat;
  }
  get lon() {
    return anglesOf(this.frame).lon;
  }
  get heading() {
    return anglesOf(this.frame).heading;
  }

  setView(v: Partial<ViewState>, instant = false) {
    this.flight = null;
    this.spin.set(0, 0, 0);
    if (v.lat !== undefined || v.lon !== undefined || v.heading !== undefined) {
      const a = anglesOf(this.target.frame);
      frameFrom(v.lat ?? a.lat, v.lon ?? a.lon, v.heading ?? a.heading, this.target.frame);
    }
    if (v.altitude !== undefined) this.target.altitude = v.altitude;
    if (v.userPitch !== undefined) this.target.userPitch = v.userPitch;
    if (instant) {
      this.frame.copy(this.target.frame);
      this.altitude = this.target.altitude;
      this.userPitch = this.target.userPitch;
      // A cut: the floor restarts where the new ground is, and the jump is not a velocity.
      this.floorR = NaN;
      this.hasPrev = false;
      this.vel.set(0, 0, 0);
    }
  }

  /**
   * Directions for the host's surface probe: the nadir; two rings of 8 around it, half and the full floor height
   * out, with that distance as allowance (a 45° cone: ground beside the camera counts only when it would reach
   * into the cone); and five along the velocity 0.5 to 3 s ahead, allowed the height the camera can climb on
   * the way there (0.4 of the distance, less the 0.5 s the spring lags), so distant ground only lifts it as
   * steeply as needed. Fills `dirs` and `allow` (km to take off each sample); returns the count.
   */
  probeDirs(dirs: THREE.Vector3[], allow: Float32Array): number {
    const n = upOf(this.frame, this.dir);
    const R = this.radius;
    let k = 0;
    const put = (off: THREE.Vector3, a: number) => {
      if (k >= dirs.length) return;
      dirs[k].copy(n).add(off).normalize();
      allow[k++] = a;
    };
    put(_v.set(0, 0, 0), 0);
    const t1 = _t1.crossVectors(n, Math.abs(n.y) < 0.9 ? Y : X).normalize();
    const t2 = _t2.crossVectors(n, t1);
    const D = Math.max(this.minAltitude, 0.02);
    for (const s of [0.5 * D, D]) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        put(_v.copy(t1).multiplyScalar((Math.cos(a) * s) / R).addScaledVector(t2, (Math.sin(a) * s) / R), s);
      }
    }
    const vt = _w.copy(this.vel).addScaledVector(n, -this.vel.dot(n));
    if (vt.lengthSq() > 1e-12) {
      const v = vt.length();
      for (const t of [0.5, 1, 1.5, 2, 3]) put(_v.copy(vt).multiplyScalar(t / R), 0.4 * v * Math.max(t - 0.5, 0));
    }
    return k;
  }

  /** Camera height above the terrain under it (km), from the last update. */
  get aboveGround() {
    return this.groundAlt;
  }

  get state(): ViewState {
    return { ...anglesOf(this.target.frame), altitude: this.target.altitude, userPitch: this.target.userPitch };
  }

  get flying() {
    return this.flight !== null;
  }

  /**
   * Fly to a view over `duration` seconds (ease in-out). The position follows the great circle, the heading is
   * carried along it and turns smoothly into the requested one, and altitude moves in log space. Any user input
   * cancels the flight.
   */
  flyTo(v: Partial<ViewState>, duration: number, onDone?: () => void) {
    const q0 = this.frame.clone();
    const a = anglesOf(q0);
    const q1 =
      v.lat !== undefined || v.lon !== undefined || v.heading !== undefined
        ? frameFrom(v.lat ?? a.lat, v.lon ?? a.lon, v.heading ?? a.heading)
        : q0.clone();
    const n0 = upOf(q0), n1 = upOf(q1);
    const move = new THREE.Quaternion().setFromUnitVectors(n0, n1);
    const fCarried = fwdOf(q0).applyQuaternion(move);
    const f1 = fwdOf(q1);
    const twist = Math.atan2(_v.crossVectors(fCarried, f1).dot(n1), fCarried.dot(f1));
    this.spin.set(0, 0, 0);
    this.flight = {
      q0,
      move,
      twist,
      alt0: this.altitude,
      alt1: THREE.MathUtils.clamp(v.altitude ?? this.altitude, this.minAltitude, this.maxAltitude),
      pitch0: this.userPitch,
      pitch1: v.userPitch ?? this.userPitch,
      t: 0,
      duration: Math.max(duration, 1e-3),
      onDone,
    };
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
      this.target.frame.copy(this.frame);
      this.target.altitude = this.altitude;
      this.target.userPitch = this.userPitch;
    }
    this.onUserInput?.();
  }

  private trackCursor(e: PointerEvent) {
    const r = this.dom.getBoundingClientRect();
    this.cursor.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
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
    this.trackCursor(e);
    // Grabbing the planet stops it.
    this.spin.set(0, 0, 0);
    this.samples.length = 0;
    this.takeOver();
  };

  private onMove = (e: PointerEvent) => {
    this.trackCursor(e);
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
    const q = this.target.frame;
    if (this.dragging === 'orbit') {
      // Angular speed so that the ground at the screen centre follows the mouse. When the view tilts toward the
      // horizon that ground is much farther away than the altitude: alt / sin(pitch), at most the horizon.
      const fovRad = (this.camera.fov * Math.PI) / 180;
      const alt = Math.max(this.groundAlt, 1e-3);
      const horizon = Math.sqrt(Math.max((this.groundR + alt) ** 2 - this.groundR ** 2, alt * alt));
      const D = THREE.MathUtils.clamp(alt / Math.max(Math.sin(this.pitch), 0.15), alt, horizon);
      const k = Math.min((D / this.radius) * fovRad, 2.2) / h;
      // Dragging down moves the camera forward, dragging right moves it left (the ground follows the hand).
      const move = fwdOf(q, _v).multiplyScalar(dy).addScaledVector(rightOf(q, _w), -dx);
      const len = move.length();
      if (len < 1e-9) return;
      const axis = upOf(q, _w).cross(move).divideScalar(len);
      const angle = len * k;
      turn(q, _q.setFromAxisAngle(axis, angle));
      const now = performance.now();
      this.samples.push({ t: now, rot: axis.clone().multiplyScalar(angle) });
      while (this.samples.length && now - this.samples[0].t > 100) this.samples.shift();
    } else {
      // Heading turns about the local up: clockwise (toward the right) for a drag to the right.
      turn(q, _q.setFromAxisAngle(upOf(q, _w), -(dx / h) * 2.5));
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
        this.spin.set(0, 0, 0);
        for (const p of recent) this.spin.add(p.rot);
        this.spin.divideScalar(span);
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
    // A notch (100 units) is a gentler step low down: ×1.06 under 2 km above the ground, ×1.13 from 20 km up,
    // ramping in log height between. Low over high ground this used to multiply the datum altitude, so one notch
    // at 100 m over a 3 km plateau was a 500 m leap.
    const h = Math.max(Math.max(this.target.altitude, this.altitude) - (this.groundR - this.radius), this.minAltitude);
    const t = THREE.MathUtils.clamp(Math.log(h / 2) / Math.log(10), 0, 1);
    this.zoomBy(Math.exp(delta * 0.0012 * (0.5 + 0.5 * t)));
  };

  private onKeyDown = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    this.shiftHeld = e.shiftKey;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!FLY_KEYS.has(e.code)) return;
    e.preventDefault();
    if (!this.keys.has(e.code)) {
      this.keys.add(e.code);
      this.spin.set(0, 0, 0);
      this.takeOver();
    }
  };

  /** Scale the height above the ground under the camera by f (the datum altitude would make steps over high
   * ground huge and over deep basins tiny). */
  zoomBy(f: number) {
    const g = this.groundR - this.radius;
    // From the camera's own height when the terrain floor holds it above its target.
    const h = Math.max(Math.max(this.target.altitude, this.altitude) - g, this.minAltitude);
    this.target.altitude = THREE.MathUtils.clamp(g + h * f, g + this.minAltitude, this.maxAltitude);
  }

  /** Apply held fly keys to the target view. */
  private fly(dt: number, shift: boolean) {
    const k = this.keys;
    const axis = (a: string, b: string) => (k.has(a) ? 1 : 0) - (k.has(b) ? 1 : 0);
    const fwd = axis('KeyW', 'KeyS') + axis('ArrowUp', 'ArrowDown');
    const side = axis('KeyD', 'KeyA');
    const lift = axis('KeyE', 'KeyQ');
    const yaw = axis('ArrowRight', 'ArrowLeft');
    const q = this.target.frame;
    if (yaw) turn(q, _q.setFromAxisAngle(upOf(q, _w), -yaw * 1.2 * dt));
    if (!fwd && !side && !lift) return;
    // W/S move along the ray under the cursor, so the point being flown at stays under it and grows.
    const ray = _v.set(this.cursor.x, this.cursor.y, 0.5).unproject(this.camera).sub(this.camera.position).normalize();
    const n = upOf(q, new THREE.Vector3());
    const move = ray.multiplyScalar(fwd).addScaledVector(rightOf(q, _w), side).addScaledVector(n, lift);
    if (move.lengthSq() < 1e-12) return;
    move.normalize();
    // Height above the ground sets the pace: it slows on the way down and the ground clamp stops the fall.
    const speed = this.flySpeed * Math.min(Math.max(this.groundAlt, this.minAltitude), this.radius) * (shift ? 4 : 1);
    const r = this.radius + this.target.altitude;
    const p = n.clone().multiplyScalar(r).addScaledVector(move, speed * dt);
    const r1 = p.length();
    turn(q, _q.setFromUnitVectors(n, p.divideScalar(r1)));
    this.target.altitude = THREE.MathUtils.clamp(r1 - this.radius, -this.radius * 0.5, this.maxAltitude);
  }

  /** Automatic pitch (radians below the local horizontal): the planet centre when far, the horizon when low. */
  private autoPitch(r: number, ground: number) {
    const t = this.autoTilt ? THREE.MathUtils.smoothstep(Math.log(r - ground), Math.log(15), Math.log(1500)) : 1;
    // Horizon dip plus a little, so the low view still shows some ground.
    const horizonPitch = Math.acos(Math.min(ground / r, 1)) + 0.12;
    return THREE.MathUtils.lerp(horizonPitch, Math.PI / 2, t);
  }

  /** userPitch that gives the camera an absolute pitch (radians below the local horizontal) at `altitude`. */
  userPitchFor(pitch: number, altitude: number, ground = this.radius) {
    return this.autoPitch(this.radius + altitude, ground) - pitch;
  }

  update(dt: number) {
    const T = this.target;
    if (this.flight) {
      // Scripted flight drives the view directly; the target follows, so nothing eases afterwards.
      const f = this.flight;
      f.t = Math.min(f.t + dt / f.duration, 1);
      const e = f.t * f.t * (3 - 2 * f.t);
      const L = THREE.MathUtils.lerp;
      const step = new THREE.Quaternion().slerp(f.move, e);
      this.frame.copy(f.q0).premultiply(step);
      turn(this.frame, _q.setFromAxisAngle(upOf(this.frame, _w), f.twist * e));
      this.altitude = Math.exp(L(Math.log(Math.max(f.alt0, 1e-3)), Math.log(Math.max(f.alt1, 1e-3)), e));
      this.userPitch = L(f.pitch0, f.pitch1, e);
      T.frame.copy(this.frame);
      T.altitude = this.altitude;
      T.userPitch = this.userPitch;
      if (f.t >= 1) {
        this.flight = null;
        f.onDone?.();
      }
    } else {
      if (this.autoRotate) turn(T.frame, _q.setFromAxisAngle(Y, this.autoRotate * dt));
      if (this.keys.size) this.fly(dt, this.shiftHeld);
      // Inertia: keep drifting after a throw, decaying over about 0.7 s.
      const w = this.spin.length();
      if (!this.dragging && w > 0) {
        turn(T.frame, _q.setFromAxisAngle(_v.copy(this.spin).divideScalar(w), w * dt));
        this.spin.multiplyScalar(Math.exp(-dt / 0.7));
        if (w < 1e-5) this.spin.set(0, 0, 0);
      }
    }
    const a = 1 - Math.exp(-dt * 8);
    this.frame.slerp(T.frame, a).normalize();
    // Altitude eases in log space for a smooth exponential zoom. Below the datum (deep basins) it eases linearly.
    if (this.altitude > 0 && T.altitude > 0) {
      this.altitude = Math.exp(Math.log(this.altitude) + (Math.log(T.altitude) - Math.log(this.altitude)) * a);
    } else {
      this.altitude += (T.altitude - this.altitude) * a;
    }
    this.userPitch += (T.userPitch - this.userPitch) * a;

    const n = upOf(this.frame, this.dir);
    // Keep above the terrain. The floor is `minAltitude` over the highest ground the probe saw around and ahead
    // of the camera, followed by a critically damped spring (0.25 s up, 1 s down) so rising ground lifts the
    // camera before it gets there, without a kick, and lets it back down afterwards; the target height is left
    // alone, so the lift is temporary. The ground right under the camera stays a hard stop at half that height
    // for whatever the samples missed, and that one does raise the target.
    const ground = this.surface(n);
    const soft = Math.max(ground, this.probeFloor || -Infinity) + this.minAltitude;
    if (Number.isNaN(this.floorR)) {
      this.floorR = soft;
      this.floorV = 0;
    } else {
      const w = 1 / (soft > this.floorR ? 0.25 : 1);
      const x = this.floorR - soft;
      const c = this.floorV + w * x;
      const e = Math.exp(-w * dt);
      this.floorR = soft + (x + c * dt) * e;
      this.floorV = (this.floorV - w * dt * c) * e;
    }
    let r = this.radius + this.altitude;
    const hard = ground + this.minAltitude * 0.5;
    if (r < hard) {
      r = hard;
      T.altitude = Math.max(T.altitude, r - this.radius);
    }
    if (r < this.floorR) r = this.floorR;
    this.altitude = r - this.radius;

    const altAboveGround = r - ground;
    let pitch = this.autoPitch(r, ground) - this.userPitch;
    pitch = THREE.MathUtils.clamp(pitch, -0.3, Math.PI / 2);
    this.pitch = pitch;
    this.groundAlt = altAboveGround;
    this.groundR = ground;

    // Camera = frame tilted down by the pitch about its right axis.
    this.camera.position.copy(n).multiplyScalar(r);
    if (this.hasPrev && dt > 0) this.vel.subVectors(this.camera.position, this.prevPos).divideScalar(dt);
    this.prevPos.copy(this.camera.position);
    this.hasPrev = true;
    this.camera.quaternion.copy(this.frame).multiply(_q.setFromAxisAngle(_v.set(1, 0, 0), -pitch));

    // Depth range adapted to altitude.
    const near = THREE.MathUtils.clamp(altAboveGround * 0.25, this.nearFloor, 200);
    const far = r + this.radius * 1.5 + 200;
    if (Math.abs(this.camera.near - near) > near * 0.05 || this.camera.far !== far) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
  }

  private dir = new THREE.Vector3();
  private shiftHeld = false;
}
