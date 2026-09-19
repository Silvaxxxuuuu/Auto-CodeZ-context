type Segment = readonly [number, number, number, number];
type Glyph = readonly [Segment, Segment, Segment];

const TERMINAL_GLYPH: Glyph = [
  [28, 25, 44, 40],
  [44, 40, 28, 55],
  [52, 57, 72, 57],
];

const A_GLYPH: Glyph = [
  [28, 56, 44, 22],
  [44, 22, 60, 56],
  [35, 43, 53, 43],
];

const Z_GLYPH: Glyph = [
  [28, 24, 60, 24],
  [60, 24, 28, 56],
  [28, 56, 60, 56],
];

const easeInOut = (value: number): number => value < 0.5
  ? 4 * value * value * value
  : 1 - Math.pow(-2 * value + 2, 3) / 2;

function getSplash(): HTMLElement | null {
  return document.querySelector<HTMLElement>('#auto-codez-startup');
}

function getSegments(root: HTMLElement): SVGLineElement[] {
  return Array.from(root.querySelectorAll<SVGLineElement>('[data-splash-segment]'));
}

function applySegment(line: SVGLineElement, segment: Segment): void {
  line.setAttribute('x1', String(segment[0]));
  line.setAttribute('y1', String(segment[1]));
  line.setAttribute('x2', String(segment[2]));
  line.setAttribute('y2', String(segment[3]));
}

function applyGlyph(lines: SVGLineElement[], glyph: Glyph): void {
  lines.forEach((line, index) => applySegment(line, glyph[index]));
}

function interpolateGlyph(
  lines: SVGLineElement[],
  from: Glyph,
  to: Glyph,
  durationMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    const startedAt = performance.now();

    const frame = (now: number): void => {
      const raw = Math.min(1, (now - startedAt) / durationMs);
      const progress = easeInOut(raw);

      lines.forEach((line, index) => {
        const source = from[index];
        const target = to[index];
        applySegment(line, [
          source[0] + (target[0] - source[0]) * progress,
          source[1] + (target[1] - source[1]) * progress,
          source[2] + (target[2] - source[2]) * progress,
          source[3] + (target[3] - source[3]) * progress,
        ]);
      });

      if (raw < 1) requestAnimationFrame(frame);
      else resolve();
    };

    requestAnimationFrame(frame);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function playBrandReveal(root: HTMLElement): Promise<void> {
  const mark = root.querySelector<HTMLElement>('.ac-startup-mark');
  const word = root.querySelector<HTMLElement>('.ac-startup-word');
  if (!mark || !word) return;

  root.classList.add('is-branding');
  await delay(30);

  const markAnimation = mark.animate(
    [
      { transform: 'translate3d(0,0,0) scale(1)' },
      { transform: 'translate3d(14px,0,0) scale(1)', offset: .16 },
      { transform: 'translate3d(116px,0,0) scale(.86)', offset: .78 },
      { transform: 'translate3d(142px,0,0) scale(.86)' },
    ],
    {
      duration: 920,
      easing: 'cubic-bezier(.58,.02,.18,1)',
      fill: 'forwards',
    },
  );

  const wordAnimation = word.animate(
    [
      { clipPath: 'inset(0 100% 0 0)', opacity: 0, transform: 'translate3d(7px,-50%,0)' },
      { clipPath: 'inset(0 100% 0 0)', opacity: 0, transform: 'translate3d(7px,-50%,0)', offset: .16 },
      { clipPath: 'inset(0 0 0 0)', opacity: 1, transform: 'translate3d(0,-50%,0)', offset: .84 },
      { clipPath: 'inset(0 0 0 0)', opacity: 1, transform: 'translate3d(0,-50%,0)' },
    ],
    {
      duration: 920,
      easing: 'cubic-bezier(.2,.72,.18,1)',
      fill: 'forwards',
    },
  );

  await Promise.all([
    markAnimation.finished.catch((): void => undefined),
    wordAnimation.finished.catch((): void => undefined),
  ]);
}

async function finishSplash(): Promise<void> {
  const root = getSplash();
  if (!root || root.dataset.finishing === 'true') return;
  root.dataset.finishing = 'true';

  const lines = getSegments(root);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.classList.add('is-ready');

  if (reducedMotion) {
    applyGlyph(lines, Z_GLYPH);
    root.classList.add('is-branding', 'is-final');
    await delay(180);
  } else {
    await delay(90);
    await interpolateGlyph(lines, TERMINAL_GLYPH, A_GLYPH, 520);
    root.classList.add('is-a');
    await delay(150);
    await interpolateGlyph(lines, A_GLYPH, Z_GLYPH, 500);
    root.classList.remove('is-a');
    root.classList.add('is-z');
    await delay(120);
    await playBrandReveal(root);
    root.classList.add('is-final');
    await delay(420);
  }

  root.classList.add('is-leaving');
  await delay(reducedMotion ? 120 : 360);
  root.remove();
  document.documentElement.classList.remove('auto-codez-booting');
  window.dispatchEvent(new CustomEvent('auto-codez-startup-complete'));
}

function initializeStartupSplash(): void {
  const root = getSplash();
  if (!root) return;

  document.documentElement.classList.add('auto-codez-booting');

  const complete = (): void => {
    void finishSplash();
  };

  if (document.documentElement.dataset.autoCodezBootstrapReady === 'true') {
    void finishSplash();
    return;
  }

  window.addEventListener('auto-codez-bootstrap-ready', complete, { once: true });
}

initializeStartupSplash();
