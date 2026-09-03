/* PDF articles.

   A PDF carries no document structure worth reading — it is glyphs at
   coordinates. This rebuilds the structure the reader needs (headings,
   paragraphs, columns) from geometry, then hands back HTML that goes through
   exactly the same sanitiser, rewriter and quality checks as a scraped page. */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const MAX_PAGES = positiveInt(process.env.PDF_MAX_PAGES, 300);

// pdf.js is a megabyte of parser that most saves never touch: load it on first use.
let pdfjs = null;
async function loadPdfjs() {
  if (!pdfjs) pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs;
}

// Shipped alongside the library; without them a PDF that relies on a standard
// font or a CJK encoding comes back as blanks.
const assetDir = name => pathToFileURL(require.resolve(`pdfjs-dist/package.json`)
  .replace(/package\.json$/, `${name}/`)).href;

export function looksLikePdfUrl(input) {
  try {
    return /\.pdf$/i.test(new URL(input).pathname);
  } catch {
    return false;
  }
}

export function isPdfBytes(bytes) {
  const head = Buffer.from(bytes.buffer || bytes, bytes.byteOffset || 0, Math.min(1024, bytes.byteLength || bytes.length));
  // Some servers prepend whitespace or a BOM before the header.
  return head.toString('latin1').trimStart().startsWith('%PDF-');
}

export class PdfError extends Error {}

/** Read a PDF into the same shape Readability hands back for a web page. */
export async function readPdf(bytes, { maxPages = MAX_PAGES } = {}) {
  const { getDocument } = await loadPdfjs();
  const task = getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: assetDir('standard_fonts'),
    cMapUrl: assetDir('cmaps'),
    cMapPacked: true,
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  });

  let doc;
  try {
    doc = await task.promise;
  } catch (error) {
    if (error?.name === 'PasswordException') throw new PdfError('that PDF is password protected');
    if (error?.name === 'InvalidPDFException') throw new PdfError('that file is not a readable PDF');
    throw new PdfError(`could not open that PDF: ${error?.message || error}`);
  }

  try {
    const pageCount = doc.numPages;
    const pages = [];
    for (let n = 1; n <= Math.min(pageCount, maxPages); n += 1) {
      const page = await doc.getPage(n);
      try {
        pages.push(await readPage(page, n));
      } finally {
        page.cleanup();
      }
    }

    const info = (await doc.getMetadata().catch(() => null))?.info || {};
    const lines = dropRunningHeads(pages);
    const bodySize = dominantSize(lines);
    const title = pickTitle(info, pages[0], bodySize);
    const blocks = assembleBlocks(stripTitleLines(lines, title), bodySize);

    return {
      title,
      byline: cleanAuthor(info.Author),
      publishedAt: pdfDate(info.CreationDate) || pdfDate(info.ModDate),
      html: renderBlocks(blocks),
      text: blocks.map(blockText).join('\n\n').trim(),
      pageCount,
      truncated: pageCount > maxPages,
    };
  } finally {
    await task.destroy().catch(() => {});
  }
}

/* ── one page → ordered lines ─────────────────────────────────────────────── */

async function readPage(page, number) {
  const content = await page.getTextContent();
  const [, viewBottom, , viewTop] = page.view;
  const runs = [];

  for (const item of content.items) {
    if (!item.str || !item.str.trim()) continue;
    const [a, b, c, d, x, y] = item.transform;
    const size = item.height || Math.hypot(c, d) || Math.hypot(a, b);
    if (!size) continue;
    // Rotated text on an otherwise upright page is a watermark or a spine label.
    if (Math.abs(b) > size * 0.05 || Math.abs(c) > size * 0.05) continue;
    runs.push({ str: item.str, x0: x, x1: x + (item.width || 0), y, size });
  }

  const lines = orderByColumn(groupRows(runs)).map(line => ({ ...line, page: number }));
  return { number, lines, top: viewTop, bottom: viewBottom };
}

/* Runs sharing a baseline are one row of type. On a multi-column page that is
   one row *from each column*, which is why the columns have to be found before
   a row is ever read as a line. */
function groupRows(runs) {
  const sorted = [...runs].sort((p, q) => (q.y - p.y) || (p.x0 - q.x0));
  const rows = [];
  let current = null;
  for (const run of sorted) {
    if (!current || Math.abs(current.y - run.y) > Math.max(1, Math.max(current.size, run.size) * 0.4)) {
      current = { y: run.y, size: run.size, runs: [] };
      rows.push(current);
    }
    current.runs.push(run);
    current.size = Math.max(current.size, run.size);
    current.y = Math.max(current.y, run.y);
  }
  return rows;
}

/* Read each column out in full before starting the next. Rows that cross a
   gutter (a title, a wide figure) belong to no column and keep their place
   above or below the column flow. */
function orderByColumn(rows) {
  const layout = rows.length >= 6 ? columnLayout(rows) : null;
  if (!layout) return rows.map(finishRow).filter(line => line.text);

  const { bands, gutters } = layout;
  const columns = bands.map(() => []);
  const spanning = [];

  for (const row of rows) {
    if (row.runs.some(run => gutters.some(([from, to]) => run.x0 < to && run.x1 > from))) {
      spanning.push(row);
      continue;
    }
    for (const [index, band] of bands.entries()) {
      const inside = row.runs.filter(run => centre(run) >= band[0] && centre(run) < band[1]);
      if (inside.length) columns[index].push({ ...row, runs: inside });
    }
  }
  if (columns.some(column => column.length < 3)) return rows.map(finishRow).filter(line => line.text);

  const placed = columns.flat();
  const highest = Math.max(...placed.map(row => row.y));
  const lowest = Math.min(...placed.map(row => row.y));
  // A spanning row inside the column flow has no true reading position; the
  // first column is where the eye already is.
  const inside = spanning.filter(row => row.y <= highest && row.y >= lowest);

  return [
    ...spanning.filter(row => row.y > highest),
    ...[...columns[0], ...inside].sort((p, q) => q.y - p.y),
    ...columns.slice(1).flat(),
    ...spanning.filter(row => row.y < lowest),
  ].map(finishRow).filter(line => line.text);
}

function columnLayout(rows) {
  const left = Math.min(...rows.flatMap(row => row.runs.map(run => run.x0)));
  const right = Math.max(...rows.flatMap(row => row.runs.map(run => run.x1)));
  const width = right - left;
  if (!(width > 0)) return null;

  const buckets = 240;
  const at = x => Math.min(buckets - 1, Math.max(0, Math.floor(((x - left) / width) * buckets)));
  const coverage = new Array(buckets).fill(0);
  for (const row of rows) {
    const touched = new Set();
    for (const run of row.runs) for (let i = at(run.x0); i <= at(run.x1); i += 1) touched.add(i);
    for (const i of touched) coverage[i] += 1;
  }

  // A gutter is quiet rather than empty: the rows that span the page cross it.
  const quiet = Math.max(1, Math.round(rows.length * 0.08));
  const gaps = [];
  let start = null;
  for (let i = 0; i < buckets; i += 1) {
    if (coverage[i] <= quiet) { if (start === null) start = i; continue; }
    // A gap running off either edge is a margin, not a gutter.
    if (start !== null && start > 0 && i - start >= buckets * 0.035) gaps.push([start, i]);
    start = null;
  }
  if (!gaps.length) return null;

  const toX = bucket => left + (bucket / buckets) * width;
  const edges = [left, ...gaps.map(([from, to]) => toX((from + to) / 2)), right + 1];
  const bands = edges.slice(0, -1).map((edge, i) => [edge, edges[i + 1]]);
  if (bands.length < 2 || bands.some(([from, to]) => to - from < width * 0.15)) return null;
  return { bands, gutters: gaps.map(([from, to]) => [toX(from), toX(to)]) };
}

function finishRow(row) {
  const runs = [...row.runs].sort((p, q) => p.x0 - q.x0);
  let text = '';
  let prev = null;
  for (const run of runs) {
    // A horizontal jump wider than a space is a space the PDF never encoded.
    if (prev && run.x0 - prev.x1 > Math.max(1, prev.size * 0.2) && !/\s$/.test(text) && !/^\s/.test(run.str)) {
      text += ' ';
    }
    text += run.str;
    prev = run;
  }
  return {
    text: text.replace(/\s+/g, ' ').trim(),
    x0: runs[0].x0,
    x1: runs[runs.length - 1].x1,
    y: row.y,
    size: weightedSize(runs),
  };
}

// The size that sets most of a row, not the size of its tallest stray glyph.
function weightedSize(runs) {
  const tally = new Map();
  for (const run of runs) {
    const key = Math.round(run.size * 2) / 2;
    tally.set(key, (tally.get(key) || 0) + run.str.trim().length);
  }
  return [...tally].sort((p, q) => q[1] - p[1])[0]?.[0] || runs[0].size;
}

const centre = box => (box.x0 + box.x1) / 2;

/* ── running heads ────────────────────────────────────────────────────────── */

/* The same line at the top or foot of page after page is furniture — a journal
   name, a chapter title, a page number — and it interrupts every paragraph it
   lands in. */
function dropRunningHeads(pages) {
  const zoneCounts = new Map();
  const zoned = pages.map(page => {
    const height = page.top - page.bottom || 1;
    return page.lines.map(line => {
      const offset = (page.top - line.y) / height;
      const edge = offset < 0.09 || offset > 0.91;
      const key = edge ? normalizeHead(line.text) : null;
      if (key) zoneCounts.set(key, (zoneCounts.get(key) || 0) + 1);
      return { line, key };
    });
  });

  const threshold = Math.max(2, Math.ceil(pages.length * 0.4));
  const repeats = pages.length >= 3;
  return zoned.flat()
    .filter(({ key }) => !key || !(PAGE_NUMBER.test(key) || (repeats && zoneCounts.get(key) >= threshold)))
    .map(({ line }) => line);
}

const PAGE_NUMBER = /^(#+|page #+( of #+)?|#+ ?\/ ?#+|[ivxlcdm]+)$/;
const normalizeHead = text => text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

/* ── lines → blocks ───────────────────────────────────────────────────────── */

function dominantSize(lines) {
  const tally = new Map();
  for (const line of lines) tally.set(line.size, (tally.get(line.size) || 0) + line.text.length);
  return [...tally].sort((p, q) => q[1] - p[1])[0]?.[0] || 11;
}

function assembleBlocks(lines, bodySize) {
  const leading = medianLeading(lines);
  const columnLeft = percentile(lines.map(line => line.x0), 0.15);
  const columnWidth = Math.max(1, percentile(lines.map(line => line.x1), 0.92) - columnLeft);
  const column = { left: columnLeft, width: columnWidth, leading };
  const blocks = [];
  let open = null;

  for (const [index, line] of lines.entries()) {
    const prev = index ? lines[index - 1] : null;
    const next = lines[index + 1] || null;

    const level = headingLevel(line, bodySize, { prev, next, column });
    if (level) { open = null; blocks.push({ type: 'h', level, text: line.text }); continue; }

    const bullet = BULLET.exec(line.text);
    if (bullet) {
      const item = line.text.slice(bullet[0].length);
      if (open?.type === 'ul') open.items.push(item);
      else blocks.push(open = { type: 'ul', items: [item], x0: line.x0, right: line.x1 });
      continue;
    }

    // A line set in from the bullet it follows is the rest of that bullet.
    if (open?.type === 'ul' && line.x0 > open.x0 + line.size * 0.5 && !separated(prev, line, leading)) {
      open.items[open.items.length - 1] = join(open.items[open.items.length - 1], line.text);
      open.right = Math.max(open.right, line.x1);
      continue;
    }

    const broken = open?.type !== 'p'
      || separated(prev, line, leading)
      || Math.abs(line.size - open.size) > 1
      || firstLineIndent(prev, line, columnWidth)
      || shortLastLine(prev, Math.max(open.right, line.x1));

    if (broken) blocks.push(open = { type: 'p', text: line.text, size: line.size, right: line.x1 });
    else {
      open.text = join(open.text, line.text);
      open.right = Math.max(open.right, line.x1);
    }
  }

  return blocks.filter(block => block.type !== 'p' || block.text.trim());
}

const BULLET = /^[\u2022\u2023\u25aa\u25e6\u25cf\u25cb\u2219\u00b7\u2013\u2014*]\s+/;

// Across a page break, only an unfinished sentence carries the paragraph over.
function separated(prev, line, leading) {
  if (!prev) return true;
  if (prev.page !== line.page) return /[.!?:;)"'\u201d\u2019]$/.test(prev.text) || !/^[a-z(\u201c"']/.test(line.text);
  const gap = prev.y - line.y;
  return gap < 0 || gap > leading * 1.45;
}

/* Both paragraph marks below are read against the lines around them rather than
   against the page: a quoted or inset block keeps its own margins, and judging
   it by the body column's would break every one of its lines into a paragraph. */

// A line starting further right than the one above it is the printer's indent.
function firstLineIndent(prev, line, columnWidth) {
  const inset = line.x0 - prev.x0;
  return inset > Math.max(2, line.size * 0.5) && inset < columnWidth * 0.25;
}

// A line that stops short of the block's own right edge, mid-sentence, ends it.
function shortLastLine(prev, right) {
  return prev.x1 < right - prev.size * 2 && /[.!?"'\u201d\u2019]$/.test(prev.text);
}

function headingLevel(line, bodySize, { prev, next, column }) {
  const text = line.text;
  if (text.length > 160 || !/[a-z0-9]/i.test(text)) return null;
  const ratio = line.size / bodySize;
  if (ratio >= 1.5) return 2;
  if (ratio >= 1.16) return 3;
  // pdf.js reports no weight, so a section head set in bold at body size has to
  // be recognised by how it sits: alone, with air above it and its text below.
  return standsAlone(line, prev, next, column) && readsAsHeading(text) ? 3 : null;
}

function standsAlone(line, prev, next, { left, width, leading }) {
  if (!next || next.page !== line.page) return false;
  const centred = Math.abs(centre(line) - (left + width / 2)) < width * 0.08;
  if (line.x0 > left + line.size * 1.5 && !centred) return false;
  const above = prev && prev.page === line.page ? prev.y - line.y : Infinity;
  const below = next.y - line.y;
  return above >= leading * 1.5 && below > 0 && below <= leading * 1.35;
}

function readsAsHeading(text) {
  if (text.length > 80 || /[.,;:]$/.test(text)) return false;
  if (/^\d+(\.\d+)*\.?\s+\S/.test(text)) return true;
  const letters = text.replace(/[^a-z]/gi, '');
  if (letters.length > 2 && letters === letters.toUpperCase()) return true;
  const words = text.split(/\s+/).filter(word => /[a-z]/i.test(word));
  return words.length > 0 && words.filter(word => /^[A-Z]/.test(word)).length / words.length >= 0.6;
}

// A line broken mid-word rejoins without its hyphen; anything else takes a space.
function join(left, right) {
  if (!/[a-zÀ-ɏ][-‐‑]$/i.test(left) || !/^[a-zÀ-ɏ]/.test(right)) return `${left} ${right}`;
  // "English-" + "to-German" is a compound broken at a hyphen it already had,
  // not a word cut in two; a second hyphen in the tail gives it away.
  return /^[a-zÀ-ɏ]+[-‐‑]/i.test(right) ? left + right : left.slice(0, -1) + right;
}

function medianLeading(lines) {
  const gaps = [];
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].page !== lines[i - 1].page) continue;
    const gap = lines[i - 1].y - lines[i].y;
    if (gap > 0) gaps.push(gap);
  }
  return gaps.length ? percentile(gaps, 0.5) : 14;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/* ── title ────────────────────────────────────────────────────────────────── */

/* /Title is often the source document's filename, or whatever the exporter
   pasted in ("printmgr file"), so it is only trusted when the document also
   prints it. Otherwise the largest type on page one is the honest answer. */
function pickTitle(info, firstPage, bodySize) {
  const declared = cleanTitle(info.Title);
  if (declared && firstPage && printedOn(firstPage, declared)) return declared;
  return largestOn(firstPage, bodySize) || declared || null;
}

function printedOn(page, title) {
  const wanted = normalizeHead(title);
  return wanted.length >= 4 && normalizeHead(page.lines.map(line => line.text).join(' ')).includes(wanted);
}

function largestOn(page, bodySize) {
  if (!page) return null;
  const half = page.bottom + (page.top - page.bottom) * 0.45;
  const candidates = page.lines.filter(line => line.y >= half && line.size > bodySize * 1.15
    && /[a-z]/i.test(line.text) && line.text.length <= 200);
  if (!candidates.length) return null;

  const largest = Math.max(...candidates.map(line => line.size));
  return candidates.filter(line => line.size >= largest - 0.5)
    .reduce((text, line) => (text ? join(text, line.text) : line.text), '')
    .slice(0, 300) || null;
}

function cleanTitle(value) {
  let title = String(value || '').replace(/\s+/g, ' ').trim();
  // Word and friends title the export after the file they exported.
  title = title.replace(/^Microsoft (?:Word|PowerPoint|Publisher)\s*-\s*/i, '');
  title = title.replace(/\.(pdf|docx?|pptx?|indd|tex|pages)$/i, '');
  if (!title || title.length > 300) return null;
  if (/^(untitled|document\d*|slide \d+|print|final|draft|no title)$/i.test(title)) return null;
  return /[a-z]/i.test(title) ? title : null;
}

// /Author is as often the software that wrote the file as the person who wrote
// it. Matched whole, so a person really called "A Writer" survives.
const NOT_A_PERSON = /^(?:unknown|users?|admin(?:istrator)?|guest|owner|author|n\/?a|none|[-.]+|(?:adobe |microsoft |libre ?|open ?)?(?:acrobat|distiller|ghostscript|pdf(?:la)?tex|latex|quark ?xpress|indesign|word|writer|office|scribus|canva|pages|publisher|photoshop|illustrator)[\w .]*)$/i;

function cleanAuthor(value) {
  const author = String(value || '').replace(/\s+/g, ' ').trim();
  if (!author || author.length > 200 || NOT_A_PERSON.test(author)) return null;
  return author;
}

// PDF dates are D:YYYYMMDDHHmmSS with an offset written as +HH'mm'.
function pdfDate(value) {
  const match = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:(Z)|([+-])(\d{2})'?(\d{2})?)?/
    .exec(String(value || '').trim());
  if (!match) return null;
  const [, year, month = '01', day = '01', hour = '00', minute = '00', second = '00', zulu, sign, offHour, offMinute = '00'] = match;
  const zone = zulu || !sign ? 'Z' : `${sign}${offHour}:${offMinute}`;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${zone}`);
  if (Number.isNaN(date.getTime())) return null;
  const stamp = date.toISOString();
  // A clock that says 1970 or 2140 is a broken field, not a publication date.
  return stamp > '1980' && date.getTime() < Date.now() + 86_400_000 ? stamp : null;
}

/* The title is set in the largest type on page one, so it is also the first
   thing in the body. The reader already shows it as the title. */
function stripTitleLines(lines, title) {
  if (!title) return lines;
  const wanted = normalizeHead(title);
  // The title may sit under a notice or a running head, so look for it rather
  // than assuming it opens the document.
  for (let start = 0; start < Math.min(lines.length, 10); start += 1) {
    let seen = '';
    for (let end = start; end < Math.min(lines.length, start + 5); end += 1) {
      seen = normalizeHead(seen ? `${seen} ${lines[end].text}` : lines[end].text);
      if (seen === wanted) return [...lines.slice(0, start), ...lines.slice(end + 1)];
      if (!wanted.startsWith(seen)) break;
    }
  }
  return lines;
}

/* ── blocks → HTML ────────────────────────────────────────────────────────── */

function renderBlocks(blocks) {
  return blocks.map((block) => {
    if (block.type === 'h') return `<h${block.level}>${inline(block.text)}</h${block.level}>`;
    if (block.type === 'ul') return `<ul>${block.items.map(item => `<li>${inline(item)}</li>`).join('')}</ul>`;
    return `<p>${inline(block.text)}</p>`;
  }).join('\n');
}

function blockText(block) {
  return block.type === 'ul' ? block.items.join('\n') : block.text;
}

const URL_IN_TEXT = /\b(?:https?:\/\/|www\.)[^\s<>()]+[^\s<>().,;:!?'"]/gi;

// A PDF has no anchors in its text layer, but it is full of written-out links.
function inline(text) {
  let out = '';
  let index = 0;
  for (const match of String(text).matchAll(URL_IN_TEXT)) {
    out += escapeHtml(text.slice(index, match.index));
    const href = escapeHtml(match[0].startsWith('www.') ? `https://${match[0]}` : match[0]);
    out += `<a href="${href}">${escapeHtml(match[0])}</a>`;
    index = match.index + match[0].length;
  }
  return out + escapeHtml(text.slice(index));
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
