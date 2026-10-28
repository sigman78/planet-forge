import * as THREE from 'three';
import type { Poi } from '../core/types.ts';

/**
 * Landmark labels on the globe: a dot on the feature, a short leader and the name with a one-line note.
 * Shown from orbit only (they fade out as you descend), hidden behind the limb, and decluttered by rank so
 * the strongest feature wins when two labels would overlap.
 */
export class PoiLabels {
  private items: { poi: Poi; el: HTMLDivElement; w: number }[] = [];
  private p = new THREE.Vector3();
  private camDir = new THREE.Vector3();
  enabled = true;

  constructor(private root: HTMLElement) {}

  set(pois: Poi[]) {
    this.root.replaceChildren();
    this.items = pois.map((poi) => {
      const el = document.createElement('div');
      el.className = `poi poi-${poi.kind}`;
      el.innerHTML = `<i></i><b></b><span></span>`;
      el.querySelector('b')!.textContent = poi.name;
      el.querySelector('span')!.textContent = poi.text;
      this.root.appendChild(el);
      // Declutter box width from the name length (11px caps with wide tracking).
      return { poi, el, w: 26 + poi.name.length * 9.5 };
    });
  }

  /** radiusKm: datum radius; altitude: camera height above the datum (km). */
  update(camera: THREE.PerspectiveCamera, radiusKm: number, altitude: number, width: number, height: number) {
    // Globe zoom only: fully shown from ~1 R up, gone below ~0.45 R.
    const zoomK = this.enabled ? THREE.MathUtils.smoothstep(altitude / radiusKm, 0.45, 1.0) : 0;
    this.root.style.opacity = String(zoomK);
    if (zoomK <= 0) {
      for (const it of this.items) it.el.style.display = 'none';
      return;
    }
    const D = camera.position.length();
    this.camDir.copy(camera.position).divideScalar(D);
    const cosHorizon = radiusKm / D;
    const placed: { x: number; y: number; w: number }[] = [];
    for (const it of this.items) {
      const d = it.poi.dir;
      const c = d[0] * this.camDir.x + d[1] * this.camDir.y + d[2] * this.camDir.z;
      // Behind the limb (with a margin so labels do not sit on the silhouette).
      const limb = THREE.MathUtils.smoothstep(c - cosHorizon, 0.03, 0.18);
      if (limb <= 0) {
        it.el.style.display = 'none';
        continue;
      }
      this.p.set(d[0], d[1], d[2]).multiplyScalar(radiusKm).project(camera);
      if (this.p.z > 1 || Math.abs(this.p.x) > 1.05 || Math.abs(this.p.y) > 1.05) {
        it.el.style.display = 'none';
        continue;
      }
      const x = (this.p.x * 0.5 + 0.5) * width;
      const y = (-this.p.y * 0.5 + 0.5) * height;
      // Declutter: label boxes sit up-right of the dot.
      const hit = placed.some((q) => x < q.x + q.w && q.x < x + it.w && Math.abs(y - q.y) < 30);
      if (hit) {
        it.el.style.display = 'none';
        continue;
      }
      placed.push({ x, y, w: it.w });
      it.el.style.display = '';
      it.el.style.opacity = String(limb);
      it.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  }
}
