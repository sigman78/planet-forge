// Formation history narrated as quiet film-style captions: one event at a time, timed by its length,
// with soft cross-fades. Starts over whenever a new world arrives.

export interface CaptionEvent {
  when: string; // e.g. "4.33 Ga"
  title: string; // stage name
  text: string;
}

export class Captions {
  private queue: CaptionEvent[] = [];
  private index = 0;
  private timer = 0;
  private enabled = true;
  private readonly when: HTMLElement;
  private readonly title: HTMLElement;
  private readonly text: HTMLElement;

  constructor(private readonly el: HTMLElement) {
    el.innerHTML = '<div class="cap-head"><span class="cap-when"></span><span class="cap-title"></span></div><div class="cap-text"></div>';
    this.when = el.querySelector('.cap-when') as HTMLElement;
    this.title = el.querySelector('.cap-title') as HTMLElement;
    this.text = el.querySelector('.cap-text') as HTMLElement;
  }

  /** Play a new narration from the start (replaces whatever is playing). */
  play(events: CaptionEvent[], startDelayMs = 900) {
    this.stop();
    this.queue = events;
    this.index = 0;
    if (this.enabled && events.length) this.timer = window.setTimeout(() => this.next(), startDelayMs);
  }

  /** One-off line (errors, notices). */
  say(text: string, ms = 6000) {
    this.stop();
    this.queue = [{ when: '', title: '', text }];
    this.index = 0;
    this.show(this.queue[0], ms);
  }

  stop() {
    clearTimeout(this.timer);
    this.el.classList.remove('on');
  }

  toggle() {
    this.enabled = !this.enabled;
    if (!this.enabled) this.stop();
    else if (this.queue.length) {
      this.index = 0;
      this.next();
    }
    return this.enabled;
  }

  private next() {
    if (this.index >= this.queue.length) return;
    const e = this.queue[this.index++];
    // Reading time: ~16 characters per second, at least 3.5 s.
    this.show(e, Math.max(3500, (e.title.length + e.text.length) * 62));
  }

  private show(e: CaptionEvent, ms: number) {
    const fadeMs = 600;
    this.el.classList.remove('on');
    this.timer = window.setTimeout(() => {
      this.when.textContent = e.when;
      this.title.textContent = e.title;
      this.text.textContent = e.text;
      this.el.classList.add('on');
      this.timer = window.setTimeout(() => {
        this.el.classList.remove('on');
        this.timer = window.setTimeout(() => this.next(), fadeMs + 250);
      }, ms);
    }, this.el.classList.contains('on') ? fadeMs : 0);
  }
}
