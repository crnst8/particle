import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, test } from 'node:test';
import { imagePlacements, nearestBlankRun, readingScale, stopOcr } from '../server/ocr.js';
import { readPdf } from '../server/pdf.js';
import { column, makePdf, makeScanPdf } from './fixtures.js';

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const { OPS } = pdfjs;

after(stopOcr);

// An operator list, written the way pdf.js hands one over.
function operatorList(ops) {
  return {
    fnArray: ops.map(([fn]) => fn),
    argsArray: ops.map(([, ...args]) => args),
  };
}

test('an image is placed by the transform stack that was in force', () => {
  const placements = imagePlacements(operatorList([
    [OPS.save],
    [OPS.transform, 2, 0, 0, 2, 10, 10],
    [OPS.save],
    // 300x300 pixels drawn into a 50x50 box, inside a stack scaling by two
    [OPS.transform, 50, 0, 0, 50, 0, 0],
    [OPS.paintImageXObject, 'img_a', 300, 300],
    [OPS.restore],
    // back outside that box: 100x100 into a 100x100 one, so pixel for pixel
    [OPS.transform, 100, 0, 0, 100, 0, 0],
    [OPS.paintImageXObject, 'img_b', 100, 100],
    [OPS.restore],
  ]), OPS);

  assert.equal(placements.length, 2);
  assert.equal(Math.round(placements[0].across), 100); // 50 points, doubled
  assert.equal(Math.round(placements[1].across), 200);
  assert.equal(placements[0].width, 300);
});

test('a squeezed scan is read at its own resolution, not the page’s', () => {
  // A long screenshot printed to PDF: 708x12030 pixels crammed into a
  // 46-point-wide sliver of a letter page. At page scale that is a smear.
  const squeezed = [{ width: 708, height: 12030, across: 46.6, down: 792, area: 46.6 * 792 }];
  assert.ok(readingScale(squeezed) > 15, readingScale(squeezed));

  // An ordinary 300 DPI letter scan asks for a little over four.
  const scan = [{ width: 2550, height: 3300, across: 612, down: 792, area: 612 * 792 }];
  assert.ok(Math.abs(readingScale(scan) - 4.17) < 0.05, readingScale(scan));

  // A small high-resolution logo does not get to decide the whole page.
  const withLogo = [...scan, { width: 900, height: 900, across: 20, down: 20, area: 400 }];
  assert.equal(readingScale(withLogo), readingScale(scan));

  // Nothing is ever rendered smaller than the page itself.
  assert.equal(readingScale([{ width: 100, height: 100, across: 612, down: 792, area: 1 }]), 1);
});

test('slices are cut through blank bands, never through a line of type', () => {
  const rows = new Uint8Array(1000);          // 0 = ink on this row
  for (const [from, to] of [[300, 340], [521, 524], [700, 760]]) rows.fill(1, from, to);

  // asked for 500: the deeper band further off does not beat the nearer one
  assert.equal(nearestBlankRun(rows, 500, 200), 320);
  // a band three rows deep is a gap between lines, not a place to cut
  assert.equal(nearestBlankRun(rows, 522, 521), null);
  // nothing blank in range at all
  assert.equal(nearestBlankRun(rows, 100, 50), null);
});

/* The end to end path needs a Tesseract language model, which is fetched on
   first use. Skipped rather than downloaded, so the suite stays offline. */
const model = process.env.OCR_CACHE_PATH || new URL('../data/ocr-cache', import.meta.url).pathname;
const noModel = existsSync(`${model}/eng.traineddata`) ? false : 'no cached Tesseract model';

test('a page with no text layer is read by eye', { skip: noModel }, async () => {
  const lines = [
    'The Reading Machine',
    'A scanned page carries no letters at all,',
    'only a picture of them, and the words in',
    'that picture must become paragraphs again.',
    'A second paragraph proves the first ended.',
  ];
  // Set the type, render it, and throw the letters away — which is all that
  // separates a scan from a page.
  const typeset = makePdf([[
    { text: lines[0], y: 700, size: 30 },
    ...column(lines.slice(1), { top: 640, size: 18, leading: 28 }),
  ]]);

  const doc = await pdfjs.getDocument({ data: new Uint8Array(typeset), verbosity: 0 }).promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 2 });
  const { createCanvas } = await import('@napi-rs/canvas');
  const surface = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = surface.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, surface.width, surface.height);
  await page.render({ canvasContext: context, viewport }).promise;

  /* Squeezed onto the page the way a printed screenshot is: a 1224-pixel-wide
     capture given 90 points to sit in. Rendered at the page's own scale that is
     90 pixels across, and unreadable — this only comes back as words if the
     scan is rendered at the resolution it actually has. */
  const box = { x: 250, y: 300, width: 90, height: 90 * (surface.height / surface.width) };
  const scanned = await readPdf(makeScanPdf(surface.encodeSync('jpeg'), {
    width: surface.width,
    height: surface.height,
    box,
  }));

  assert.equal(scanned.ocrPages, 1);
  assert.match(scanned.text, /scanned page carries no letters/);
  assert.match(scanned.text, /second paragraph proves/i);
  // the lines came back as a paragraph, not as one paragraph each
  assert.match(scanned.html, /no letters at all,? only a picture of them/);
});
