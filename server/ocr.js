/* OCR for scanned pages.

   A scan carries no glyphs, only a picture of them. This renders that picture
   back at the resolution it was scanned at — which is not the page's own scale,
   and on a "print to PDF" of a long screenshot is nowhere near it — reads it
   with Tesseract, and hands the words back as runs in the same shape the text
   layer produces. The page then rejoins the pipeline where it fell out of it. */

import { mkdirSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';

export const ocrEnabled = process.env.OCR_ENABLED !== '0';

const LANGUAGE = process.env.OCR_LANG || 'eng';
const MAX_PAGES = positiveInt(process.env.OCR_MAX_PAGES, 20);
const MAX_PIXELS = positiveInt(process.env.OCR_MAX_MEGAPIXELS, 40) * 1e6;
const MAX_EDGE = positiveInt(process.env.OCR_MAX_EDGE, 20000);
const MIN_CONFIDENCE = positiveInt(process.env.OCR_MIN_CONFIDENCE, 40);
/* Tesseract's own default here is 6, "one uniform block of text", and under it
   a page settles on a single type size and throws away whatever does not fit —
   which on a magazine page is the headline. 3 is full page analysis: mixed
   sizes, and columns found rather than read straight across. */
const PAGE_MODE = process.env.OCR_PAGE_MODE || '3';
const WORKERS = positiveInt(process.env.OCR_WORKERS, Math.min(4, Math.max(1, cpus().length - 1)));
const IDLE_MS = positiveInt(process.env.OCR_IDLE_MS, 5 * 60_000);
// A tall page is read in slices so no single image has to be held whole, and so
// the slices can be read at once. Slices are cut through blank bands only.
const SLICE_TARGET = positiveInt(process.env.OCR_SLICE_HEIGHT, 2600);

export { MAX_PAGES as ocrMaxPages };

/* ── lazily loaded machinery ──────────────────────────────────────────────
   Canvas is a native module and Tesseract is a WASM runtime with a language
   model behind it. A library of ordinary web pages should pay for neither. */

let canvasLib = null;
const canvas = () => (canvasLib ??= import('@napi-rs/canvas'));

let factory = null;
/* pdf.js builds scratch canvases of its own for soft masks and patterns, and
   has no way to make one in Node without being handed this. */
export async function canvasFactory() {
  if (factory) return factory;
  const { createCanvas } = await canvas();
  factory = class NodeCanvasFactory {
    create(width, height) {
      const surface = createCanvas(Math.max(1, width | 0), Math.max(1, height | 0));
      return { canvas: surface, context: surface.getContext('2d') };
    }

    reset(owned, width, height) {
      owned.canvas.width = Math.max(1, width | 0);
      owned.canvas.height = Math.max(1, height | 0);
    }

    destroy(owned) {
      if (!owned.canvas) return;
      owned.canvas.width = 0;
      owned.canvas.height = 0;
      owned.canvas = null;
      owned.context = null;
    }
  };
  return factory;
}

let pool = null;
let idleTimer = null;
let outstanding = 0;

async function scheduler() {
  if (!pool) {
    pool = (async () => {
      const { createScheduler, createWorker } = await import('tesseract.js');
      const queue = createScheduler();
      const cachePath = process.env.OCR_CACHE_PATH || defaultCachePath();
      // Tesseract writes the model here and falls back to the working directory
      // without a word if it cannot, which is how a server ends up with a
      // language model in its repository root.
      mkdirSync(cachePath, { recursive: true });
      const options = {
        logger: () => {},
        errorHandler: message => console.error('ocr worker:', message),
        /* Where the downloaded model is kept, so it is fetched once. Tesseract
           also writes itself a copy of it into the working directory, through
           a virtual filesystem that takes no host path — hence the gitignore. */
        cachePath,
        ...(process.env.OCR_LANG_PATH ? { langPath: process.env.OCR_LANG_PATH } : {}),
      };
      const workers = await Promise.all(Array.from({ length: WORKERS }, async () => {
        const worker = await createWorker(LANGUAGE, 1, options);
        await worker.setParameters({ tessedit_pageseg_mode: PAGE_MODE });
        return worker;
      }));
      for (const worker of workers) queue.addWorker(worker);
      return queue;
    })().catch((error) => { pool = null; throw error; });
  }
  return pool;
}

// The language model is a download; keep it beside the database so a container
// fetches it once and a restart does not go back to the network.
function defaultCachePath() {
  const db = process.env.PARTICLE_DB || new URL('../data/particle.db', import.meta.url).pathname;
  return join(dirname(db), 'ocr-cache');
}

/* Four Tesseract workers hold a language model each. A library that is not
   being filled right now should not be paying for them. */
function releaseWhenIdle() {
  clearTimeout(idleTimer);
  if (outstanding > 0) return;
  idleTimer = setTimeout(async () => {
    const queue = pool;
    pool = null;
    try { (await queue)?.terminate(); } catch { /* already gone */ }
  }, IDLE_MS);
  idleTimer.unref?.();
}

/** Put the workers down now rather than at the end of the idle window. */
export async function stopOcr() {
  clearTimeout(idleTimer);
  const queue = pool;
  pool = null;
  try { await (await queue)?.terminate(); } catch { /* already gone */ }
}

/* ── one loose picture ────────────────────────────────────────────────────── */

/** Read a picture that is not a page of anything — a screenshot the reader
    handed over. Returns lines top to bottom with their boxes: where a line sits
    and how tall it is set is most of what separates a headline from the app
    furniture around it. */
export async function ocrImage(bytes) {
  outstanding += 1;
  clearTimeout(idleTimer);
  try {
    const queue = await scheduler();
    const { data } = await queue.addJob('recognize', bytes, {}, { blocks: true });
    const lines = [];
    for (const block of data.blocks || []) {
      for (const paragraph of block.paragraphs || []) {
        for (const line of paragraph.lines || []) {
          if (!line.words?.length || line.confidence < MIN_CONFIDENCE) continue;
          const words = line.words.filter(word => word.text?.trim() && word.confidence >= MIN_CONFIDENCE);
          if (!words.length) continue;
          lines.push({
            text: words.map(word => word.text.trim()).join(' '),
            x: line.bbox.x0,
            y: line.bbox.y0,
            width: line.bbox.x1 - line.bbox.x0,
            height: line.bbox.y1 - line.bbox.y0,
            confidence: Math.round(line.confidence),
          });
        }
      }
    }
    return lines.sort((one, other) => one.y - other.y);
  } finally {
    outstanding -= 1;
    releaseWhenIdle();
  }
}

/* ── one page ─────────────────────────────────────────────────────────────── */

/** Read a page's pictures as text. Returns runs in image pixels — the space the
    words were actually set in — or null when there is nothing to read. */
export async function ocrPage(page, OPS) {
  const rendered = await renderScan(page, OPS);
  if (!rendered) return null;

  outstanding += 1;
  clearTimeout(idleTimer);
  try {
    const queue = await scheduler();
    const slices = await sliceForReading(rendered.surface);
    const results = await Promise.all(slices.map(slice =>
      queue.addJob('recognize', slice.png, {}, { blocks: true })));

    const lines = [];
    for (const [index, { data }] of results.entries()) collectLines(data, slices[index].top, lines);
    lines.sort((one, other) => one.baseline - other.baseline);
    snapSizes(lines);

    const runs = toRuns(lines, rendered.height);
    return runs.length ? { runs, width: rendered.width, height: rendered.height } : null;
  } finally {
    outstanding -= 1;
    releaseWhenIdle();
  }
}

/* Tesseract measures from the top down; the pipeline downstream counts up from
   the foot of the page, and wants a baseline and a type size per line. */
function collectLines(data, sliceTop, lines) {
  for (const block of data.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      const kept = [];
      for (const line of paragraph.lines || []) {
        // A line Tesseract is unsure of, inside a picture, is usually the picture.
        if (!line.words?.length || line.confidence < MIN_CONFIDENCE) continue;
        const words = line.words.filter(word =>
          word.text?.trim() && word.confidence >= MIN_CONFIDENCE);
        if (!words.length) continue;
        const baseline = baselineOf(line, words);
        kept.push({
          words,
          // Measured to the baseline, not to the foot of the deepest tail:
          // "Resolute Desk" and "paragraphs" are the same type, and a box drawn
          // round each is not the same height.
          height: baseline - line.bbox.y0,
          baseline: sliceTop + baseline,
        });
      }
      // A paragraph is set in one size, whatever its lines happen to measure:
      // the tallest is the one that had both an ascender and a tail in it.
      const height = Math.max(...kept.map(line => line.height), 0);
      for (const line of kept) lines.push({ ...line, height });
    }
  }
}

/* Tesseract often reports no baseline at all. Most words in a line have nothing
   below it, so the level the majority of them sit on is the baseline; the few
   carrying a tail hang below and are left out of the reckoning. */
function baselineOf(line, words) {
  if (line.baseline?.has_baseline) return line.baseline.y0;
  const feet = words.map(word => word.bbox.y1).sort((one, other) => one - other);
  return feet[Math.floor(feet.length * 0.3)] ?? line.bbox.y1;
}

/* A line's box is only as tall as the glyphs that happen to be in it — "worn"
   and "gaily" measure differently in the same type, and that wobble is wider
   than the gap between a body line and a heading. So each line is snapped to a
   size the page is actually set in: the sizes carrying the most text, taken
   strongest first, with everything within a fifth of one counted as that one. */
function snapSizes(lines) {
  const carried = new Map();
  for (const line of lines) {
    const text = line.words.reduce((total, word) => total + word.text.length, 0);
    carried.set(line.height, (carried.get(line.height) || 0) + text);
  }

  const sizes = [...carried].sort((a, b) => b[1] - a[1])
    .reduce((kept, [height]) =>
      (kept.some(other => Math.abs(other - height) <= other * 0.2) ? kept : [...kept, height]), []);

  for (const line of lines) {
    line.size = sizes.find(size => Math.abs(size - line.height) <= size * 0.2) ?? line.height;
  }
}

function toRuns(lines, pageHeight) {
  const runs = [];
  for (const [row, line] of lines.entries()) {
    for (const word of line.words) {
      runs.push({
        str: `${word.text.trim()} `,
        x0: word.bbox.x0,
        x1: word.bbox.x1,
        // back to a page's own reckoning, where y counts up from the foot
        y: pageHeight - line.baseline,
        size: line.size,
        /* Which line this word was read from. Guessing it back from baselines
           fails exactly where it matters: a headline set large, or a drop cap,
           forgives a tolerance wide enough to swallow the line below it and
           shuffle the two together. */
        row,
      });
    }
  }
  return runs;
}

/* ── rendering the scan ───────────────────────────────────────────────────── */

export async function renderScan(page, OPS) {
  const placements = imagePlacements(await page.getOperatorList(), OPS);
  if (!placements.length) return null;

  const { createCanvas } = await canvas();
  const scale = readingScale(placements);
  const viewport = page.getViewport({ scale });
  const box = deviceBox(placements, viewport);
  if (box.width < 16 || box.height < 16) return null;

  const surface = createCanvas(box.width, box.height);
  const context = surface.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, box.width, box.height);
  await page.render({
    canvasContext: context,
    viewport: page.getViewport({ scale, offsetX: -box.x, offsetY: -box.y }),
    background: '#ffffff',
  }).promise;

  return { surface, width: box.width, height: box.height };
}

/* Every way pdf.js can name a raster. The first three carry their own size in
   the operator's arguments; the inline forms carry it on the image itself. */
function imageSize(fn, args, OPS) {
  if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
    return { width: args[1], height: args[2] };
  }
  if (fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
    return { width: args[0]?.width, height: args[0]?.height };
  }
  return null;
}

// Where each raster lands on the page, and how many of its own pixels it has.
export function imagePlacements(operatorList, OPS) {
  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const placements = [];

  for (let i = 0; i < operatorList.fnArray.length; i += 1) {
    const fn = operatorList.fnArray[i];
    const args = operatorList.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = multiply(ctm, args);
    else {
      const size = imageSize(fn, args, OPS);
      if (!size?.width || !size?.height) continue;
      const across = Math.hypot(ctm[0], ctm[1]);
      const down = Math.hypot(ctm[2], ctm[3]);
      if (across < 1 || down < 1) continue;
      placements.push({ ...size, ctm, across, down, area: across * down });
    }
  }
  return placements;
}

/* The scale that gives the page's main picture its own pixels back. A page's
   nominal size says nothing about it: a screenshot printed to PDF is squeezed
   into whatever box the printer chose, and rendering at page scale would read
   a 708-pixel-wide column of text as a 46-pixel smear. */
export function readingScale(placements) {
  const dominant = placements.reduce((best, one) => (one.area > best.area ? one : best));
  const density = Math.max(dominant.width / dominant.across, dominant.height / dominant.down);
  return Math.min(Math.max(density, 1), 40);
}

function deviceBox(placements, viewport) {
  const points = placements.flatMap(({ ctm }) => [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) =>
    viewport.convertToViewportPoint(ctm[0] * u + ctm[2] * v + ctm[4], ctm[1] * u + ctm[3] * v + ctm[5])));

  const x = Math.max(0, Math.floor(Math.min(...points.map(p => p[0]))));
  const y = Math.max(0, Math.floor(Math.min(...points.map(p => p[1]))));
  const right = Math.floor(Math.min(viewport.width, Math.ceil(Math.max(...points.map(p => p[0])))));
  const bottom = Math.floor(Math.min(viewport.height, Math.ceil(Math.max(...points.map(p => p[1])))));
  return fitBudget({ x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) });
}

// Rendering is the one step whose cost is not bounded by the file's own size.
function fitBudget(box) {
  const pixels = box.width * box.height;
  const shrink = Math.min(
    pixels > MAX_PIXELS ? Math.sqrt(MAX_PIXELS / pixels) : 1,
    MAX_EDGE / Math.max(box.width, box.height, MAX_EDGE),
  );
  if (shrink >= 1) return box;
  return {
    x: Math.floor(box.x * shrink),
    y: Math.floor(box.y * shrink),
    width: Math.max(1, Math.floor(box.width * shrink)),
    height: Math.max(1, Math.floor(box.height * shrink)),
  };
}

function multiply(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

/* ── slicing ──────────────────────────────────────────────────────────────── */

/* Cuts fall in blank bands, never through type: a word sliced in half is a word
   read wrong twice, and stitching the halves back is guesswork. */
export async function sliceForReading(surface) {
  const { createCanvas } = await canvas();
  const cuts = surface.height <= SLICE_TARGET * 1.5 ? [] : blankCuts(surface);
  const bounds = [0, ...cuts, surface.height];

  return bounds.slice(0, -1).map((top, index) => {
    const height = bounds[index + 1] - top;
    if (!cuts.length) return { top, png: surface.encodeSync('png') };
    const slice = createCanvas(surface.width, height);
    slice.getContext('2d').drawImage(surface, 0, top, surface.width, height, 0, 0, surface.width, height);
    return { top, png: slice.encodeSync('png') };
  });
}

function blankCuts(surface) {
  const blank = blankRows(surface);
  const cuts = [];
  let last = 0;
  while (surface.height - last > SLICE_TARGET * 1.5) {
    const target = last + SLICE_TARGET;
    const cut = nearestBlankRun(blank, target, last + SLICE_TARGET * 0.4);
    if (cut === null) break;
    cuts.push(cut);
    last = cut;
  }
  return cuts;
}

/* A row is blank when almost nothing on it is dark. Read in bands so a tall
   page is never held as pixels twice over. */
function blankRows(surface) {
  const context = surface.getContext('2d');
  const rows = new Uint8Array(surface.height);
  const band = 512;
  const threshold = Math.max(1, Math.round(surface.width * 0.002));

  for (let top = 0; top < surface.height; top += band) {
    const height = Math.min(band, surface.height - top);
    const { data } = context.getImageData(0, top, surface.width, height);
    for (let row = 0; row < height; row += 1) {
      let dark = 0;
      const start = row * surface.width * 4;
      for (let i = 0; i < surface.width; i += 1) {
        const at = start + i * 4;
        if (data[at] * 0.299 + data[at + 1] * 0.587 + data[at + 2] * 0.114 < 170) dark += 1;
        if (dark > threshold) break;
      }
      rows[top + row] = dark > threshold ? 0 : 1;
    }
  }
  return rows;
}

// The middle of the widest blank band near the target, so the cut clears the
// descenders above it and the ascenders below.
export function nearestBlankRun(blank, target, earliest) {
  const limit = Math.min(blank.length - 1, target + (target - earliest));
  let best = null;
  let start = null;
  for (let row = Math.max(0, Math.floor(earliest)); row <= limit; row += 1) {
    if (blank[row]) { start ??= row; continue; }
    if (start !== null) best = betterRun(best, [start, row], target);
    start = null;
  }
  if (start !== null) best = betterRun(best, [start, limit + 1], target);
  return best ? Math.floor((best[0] + best[1]) / 2) : null;
}

// A deeper gap is a safer cut and worth going a little out of the way for, but
// not far: slices that drift from the target stop being slices.
function betterRun(best, run, target) {
  if (run[1] - run[0] < 4) return best;
  if (!best) return run;
  const score = candidate => (candidate[1] - candidate[0]) - Math.abs((candidate[0] + candidate[1]) / 2 - target) * 0.5;
  return score(run) > score(best) ? run : best;
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
