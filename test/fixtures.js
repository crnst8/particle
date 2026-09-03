/* PDF fixtures. A PDF is glyphs at coordinates, so the fixtures are written
   that way too: each run is a string placed at an (x, y) in points, at a point
   size. `makeScanPdf` goes one further and throws the glyphs away, leaving a
   picture of them — which is all a scanned page ever is. */

const esc = value => String(value).replace(/([\\()])/g, '\\$1');

export function makePdf(pages, meta = {}) {
  return assemble((add, pageList, shared) => pages.map((runs) => {
    const ops = runs.map(run =>
      `BT /F1 ${run.size ?? 11} Tf ${run.x ?? 72} ${run.y} Td (${esc(run.text)}) Tj ET`).join('\n');
    const content = add(`<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`);
    return add(`<< /Type /Page /Parent ${pageList} 0 R /MediaBox [0 0 612 792]`
      + ` /Resources << /Font << /F1 ${shared.font} 0 R >> >> /Contents ${content} 0 R >>`);
  }), meta, add => ({ font: add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>') }));
}

/** A page holding nothing but a picture: a JPEG drawn into `box` points. */
export function makeScanPdf(jpeg, { width, height, box, page = [612, 792] }, meta = {}) {
  const bytes = Buffer.from(jpeg).toString('latin1');
  return assemble((add, pageList) => {
    const image = add(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height}`
      + ` /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`
      + ` /Length ${bytes.length} >>\nstream\n${bytes}\nendstream`);
    const ops = `q ${box.width} 0 0 ${box.height} ${box.x} ${box.y} cm /Im0 Do Q`;
    const content = add(`<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`);
    return [add(`<< /Type /Page /Parent ${pageList} 0 R /MediaBox [0 0 ${page[0]} ${page[1]}]`
      + ` /Resources << /XObject << /Im0 ${image} 0 R >> >> /Contents ${content} 0 R >>`)];
  }, meta);
}

function assemble(buildPages, meta, buildShared) {
  const objects = [];
  const add = body => objects.push(body);

  const catalog = add(null);
  const pageList = add(null);
  const shared = buildShared ? buildShared(add) : {};
  const kids = buildPages(add, pageList, shared);

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

/** A body paragraph, laid out line by line down the page. */
export const column = (lines, { top = 700, size = 11, x = 72, leading = 14 } = {}) =>
  lines.map((text, i) => ({ text, x, y: top - i * leading, size }));
