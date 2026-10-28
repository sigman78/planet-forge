// HUD facts revealed like scan results: rows arrive one by one, each value decoding out of noise glyphs.

const GLYPHS = '░▒▓#%&@$01<>/\\=+*';
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

interface Line {
  key: string;
  value: string;
  start: number; // ms timestamp when the row starts decoding
}

export class ScanReadout {
  private lines: Line[] = [];
  private name = { text: '', start: 0 };
  private klass = '';
  private nextStart = 0;
  private raf = 0;
  private rowGap = 380; // ms between rows
  private charMs = 20; // ms per resolved character

  constructor(
    private readonly factsEl: HTMLElement,
    private readonly nameEl: HTMLElement,
    private readonly classEl: HTMLElement,
  ) {}

  /** Start a new readout (clears the old one). fast: quicker cadence (cached worlds). */
  begin(name: string, klass: string, rows: [string, string][], fast = false) {
    // A full readout takes about as long as a typical forge (~3 s); cached worlds scan quickly.
    this.rowGap = fast ? 70 : 380;
    this.charMs = fast ? 5 : 20;
    const now = performance.now();
    this.name = { text: name, start: now };
    this.klass = klass;
    this.lines = [];
    this.nextStart = now + name.length * this.charMs + 120;
    this.append(rows);
    this.tick();
  }

  /** Queue more rows after the ones already shown (e.g. measurements once the surface exists). */
  append(rows: [string, string][]) {
    const now = performance.now();
    for (const [key, value] of rows) {
      const start = Math.max(this.nextStart, now);
      this.lines.push({ key, value, start });
      this.nextStart = start + this.rowGap;
    }
    this.tick();
  }

  private decode(text: string, elapsed: number): string {
    if (elapsed <= 0) return '';
    const n = Math.floor(elapsed / this.charMs);
    if (n >= text.length) return esc(text);
    let noise = '';
    for (let i = n; i < Math.min(text.length, n + 4); i++) noise += text[i] === ' ' ? ' ' : GLYPHS[(Math.random() * GLYPHS.length) | 0];
    return `${esc(text.slice(0, n))}<i class="scan-noise">${esc(noise)}</i>`;
  }

  private tick = () => {
    cancelAnimationFrame(this.raf);
    const now = performance.now();
    this.nameEl.innerHTML = this.decode(this.name.text, now - this.name.start) || '&nbsp;';
    this.classEl.textContent = now > this.name.start + 150 ? this.klass : '';
    let html = '';
    let busy = now < this.name.start + this.name.text.length * this.charMs;
    for (const l of this.lines) {
      const e = now - l.start;
      if (e < 0) {
        busy = true;
        break;
      }
      const done = e >= l.value.length * this.charMs;
      if (!done) busy = true;
      html += `${done ? esc(l.key.padEnd(8)) : `<b class="scan-key">${esc(l.key.padEnd(8))}</b>`} <span>${this.decode(l.value, e)}</span>\n`;
    }
    this.factsEl.innerHTML = html;
    if (busy) this.raf = requestAnimationFrame(this.tick);
  };
}
