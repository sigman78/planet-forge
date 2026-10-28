import * as THREE from 'three';

/**
 * Planet orbit camera.
 * - Left drag: orbit (speed scales with altitude, so it feels the same from orbit and near the ground).
 * - Wheel / pinch: exponential zoom in altitude.
 * - Right drag (or shift+left): heading / pitch.
 * - Pitch automatically eases toward the horizon as you get close to the surface.
 */
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

  setView(v: Partial<{ lat: number; lon: number; altitude: number; heading: number; userPitch: number }>, instant = false) {
    Object.assign(this.target, v);
    if (instant) Object.assign(this, this.target);
  }

  get state() {
    return { ...this.target };
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
      // Angular speed so that the ground under the cursor roughly follows the mouse.
      const visibleAngle = (this.target.altitude / this.radius) * (this.camera.fov * Math.PI / 180);
      const k = Math.min(visibleAngle, 2.2) / h;
      const ch = Math.cos(this.target.heading);
      const sh = Math.sin(this.target.heading);
      // Rotate screen motion by heading.
      const north = dy * ch + dx * sh;
      const east = -dx * ch + dy * sh;
      this.target.lat = THREE.MathUtils.clamp(this.target.lat + north * k, -1.55, 1.55);
      this.target.lon += (east * k) / Math.max(Math.cos(this.target.lat), 0.05);
    } else {
      this.target.heading += (dx / h) * 2.5;
      this.target.userPitch = THREE.MathUtils.clamp(this.target.userPitch + (dy / h) * 2.0, -1.2, 1.2);
    }
  };

  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) this.dragging = null;
    this.pinchDist = 0;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    this.zoomBy(Math.exp(delta * 0.0012));
  };

  zoomBy(f: number) {
    this.target.altitude = THREE.MathUtils.clamp(this.target.altitude * f, this.minAltitude, this.maxAltitude);
  }

  private dir = new THREE.Vector3();

  update(dt: number) {
    this.target.lon += this.autoRotate * dt;
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
    const t = this.autoTilt ? THREE.MathUtils.smoothstep(Math.log(altAboveGround), Math.log(8), Math.log(450)) : 1;
    // Horizon dip angle so "horizon" view still shows a little ground.
    const horizonPitch = Math.acos(Math.min(ground / r, 1)) + 0.12;
    let pitch = THREE.MathUtils.lerp(horizonPitch, Math.PI / 2, t) - this.userPitch;
    pitch = THREE.MathUtils.clamp(pitch, -0.3, Math.PI / 2);

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
