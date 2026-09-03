import assert from 'node:assert/strict';
import test from 'node:test';
import { isPdfBytes, looksLikePdfUrl, readPdf } from '../server/pdf.js';
import { extractArticle } from '../server/extract.js';

/* A PDF is glyphs at coordinates, so the fixtures are written that way too:
   each run is a string placed at an (x, y) in points, at a point size. */
function makePdf(pages, meta = {}) {
  const esc = value => String(value).replace(/([\\()])/g, '\\$1');
  const objects = [];
  const add = body => objects.push(body);

  const catalog = add(null);
  const pageList = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const kids = pages.map((runs) => {
    const ops = runs.map(run =>
      `BT /F1 ${run.size ?? 11} Tf ${run.x ?? 72} ${run.y} Td (${esc(run.text)}) Tj ET`).join('\n');
    const content = add(`<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`);
    return add(`<< /Type /Page /Parent ${pageList} 0 R /MediaBox [0 0 612 792]`
      + ` /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`);
  });

  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pageList} 0 R >>`;
  objects[pageList - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}]`
    + ` /Count ${kids.length} >>`;
  const info = add(`<< ${meta.title ? `/Title (${esc(meta.title)}) ` : ''}`
    + `${meta.author ? `/Author (${esc(meta.author)}) ` : ''}`
    + `${meta.date ? `/CreationDate (${esc(meta.date)}) ` : ''}>>`);

  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const startxref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
    + `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\n`
    + `startxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// A body paragraph, laid out line by line down the page.
const column = (lines, { top = 700, size = 11, x = 72, leading = 14 } = {}) =>
  lines.map((text, i) => ({ text, x, y: top - i * leading, size }));

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => handler(String(input instanceof URL ? input.href : input));
  return () => { globalThis.fetch = original; };
}

const pdfResponse = (bytes, type = 'application/pdf') =>
  new Response(bytes, { status: 200, headers: { 'content-type': type } });

test('PDFs are told apart by their bytes, not only by their URL', () => {
  assert.equal(looksLikePdfUrl('https://example.com/docs/report.PDF'), true);
  assert.equal(looksLikePdfUrl('https://example.com/report.pdf?v=2'), true);
  assert.equal(looksLikePdfUrl('https://example.com/report'), false);
  assert.equal(looksLikePdfUrl('not a url'), false);

  assert.equal(isPdfBytes(Buffer.from('%PDF-1.7\nstuff')), true);
  assert.equal(isPdfBytes(Buffer.from('\n  %PDF-1.4')), true);
  assert.equal(isPdfBytes(Buffer.from('<html><body>no</body></html>')), false);
});

test('lines become paragraphs, headings and links', async () => {
  const doc = await readPdf(makePdf([[
    { text: 'The Shape of Things', y: 730, size: 20 },
    ...column([
      'Sometimes a paragraph runs on for a while and wraps onto a',
      'second line that continues the same sentence properly.',
    ], { top: 700 }),
    { text: 'A Second Heading', y: 660, size: 16 },
    ...column([
      'It mentions https://example.com/x and a hyphen-',
      'ated word, plus an English-',
      'to-German compound.',
    ], { top: 636 }),
  ]], { title: 'The Shape of Things', author: 'A Writer', date: 'D:20240115090000Z' }));

  assert.equal(doc.title, 'The Shape of Things');
  assert.equal(doc.byline, 'A Writer');
  assert.equal(doc.publishedAt, '2024-01-15T09:00:00.000Z');
  assert.equal(doc.pageCount, 1);

  // the title is the document's, so it is not repeated as the body's first line
  assert.ok(!doc.html.includes('<p>The Shape of Things'));
  assert.match(doc.html, /<h3>A Second Heading<\/h3>/);
  // wrapped lines rejoin into one paragraph
  assert.match(doc.html, /wraps onto a second line that continues/);
  // a word broken by the line break loses its hyphen; a real compound keeps it
  assert.match(doc.html, /hyphenated word/);
  assert.match(doc.html, /English-to-German compound/);
  assert.match(doc.html, /<a href="https:\/\/example\.com\/x">https:\/\/example\.com\/x<\/a>/);
});

test('a two-column page is read one column at a time', async () => {
  const ordinals = ['one', 'two', 'three', 'four', 'five', 'six'];
  // Both columns sit on the same baselines, which is exactly the case that
  // reads as nonsense if the columns are found after the lines are.
  const doc = await readPdf(makePdf([[
    { text: 'A Paper Set In Two Columns Across The Page', y: 740, size: 18, x: 72 },
    ...column(ordinals.map(n => `Left side line ${n} of the column.`), { top: 700, x: 72 }),
    ...column(ordinals.map(n => `Right side line ${n} of the column.`), { top: 700, x: 330 }),
  ]]));

  const order = [...doc.text.matchAll(/(Left|Right) side line (\w+)/g)].map(m => `${m[1]} ${m[2]}`);
  assert.deepEqual(order, [
    ...ordinals.map(n => `Left ${n}`),
    ...ordinals.map(n => `Right ${n}`),
  ]);
  // the spanning line above the columns is the document's title, not a column line
  assert.equal(doc.title, 'A Paper Set In Two Columns Across The Page');
});

test('running heads and page numbers are dropped, not read aloud mid-sentence', async () => {
  const page = n => [
    { text: 'Journal of Things', y: 770, size: 9 },
    ...column([`Body sentence on page ${n} runs here.`, `And a second body line ${n}.`], { top: 700 }),
    { text: String(n), y: 40, size: 9 },
  ];
  const doc = await readPdf(makePdf([page(1), page(2), page(3)]));

  assert.ok(!doc.text.includes('Journal of Things'), doc.text);
  assert.doesNotMatch(doc.text, /^\s*[123]\s*$/m);
  assert.match(doc.text, /Body sentence on page 2/);
});

test('a PDF with no text layer says so instead of saving an empty article', async () => {
  const restore = stubFetch(async () => pdfResponse(makePdf([[]])));
  try {
    await assert.rejects(extractArticle('https://example.com/scan.pdf'), /no text layer/);
  } finally {
    restore();
  }
});

test('a PDF URL becomes an article through the ordinary extract path', async () => {
  const bytes = makePdf([[
    { text: 'Quarterly Notes', y: 740, size: 18 },
    ...column([
      'The first quarter went about as well as anyone could reasonably have',
      'expected it to go, which is to say that it went fine and no more.',
      'Nothing else of any note happened in the whole of the quarter.',
    ], { top: 700 }),
  ]], { title: 'Quarterly Notes' });

  // announced as a plain download: the bytes still identify it
  const restore = stubFetch(async () => pdfResponse(bytes, 'application/octet-stream'));
  try {
    const article = await extractArticle('https://example.com/notes');
    assert.equal(article.title, 'Quarterly Notes');
    assert.equal(article.fetch_method, 'direct (pdf)');
    assert.equal(article.site_name, 'example.com');
    assert.equal(article.lead_image, null);
    assert.ok(article.word_count > 30, `word_count ${article.word_count}`);
    assert.match(article.content_html, /<p>The first quarter went about as well/);
    assert.equal(article.canonical_url, 'https://example.com/notes');
  } finally {
    restore();
  }
});
