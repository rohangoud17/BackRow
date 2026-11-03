/**
 * Build a small, valid, text-based PDF in memory — test fixtures only.
 *
 * Generated rather than checked in so a test states exactly what each page says
 * (and which pages are blank, which is how the scanned-PDF check is exercised),
 * and so no binary file has to be reviewed. Each entry in `pages` becomes one
 * page; each `\n` within it starts a new line, and long lines are wrapped. An empty string makes a page
 * with no text layer at all — what a scanned page looks like to an extractor.
 */
export function makePdf(pages: string[]): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length; // 1-based object number
  };

  const catalog = add(""); // patched below once the pages tree exists
  const pagesTree = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  const pageRefs: number[] = [];
  for (const text of pages) {
    // Wrapped like real typeset text: an over-long line would run off the
    // page, and extractors only return what is on it.
    const lines = text.split("\n").flatMap(wrap).map(escapePdfString);
    const content = lines.length && text
      ? `BT /F1 11 Tf 14 TL 50 760 Td ${lines.map((l) => `(${l}) Tj T*`).join(" ")} ET`
      : "";
    const stream = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    pageRefs.push(
      add(
        `<< /Type /Page /Parent ${pagesTree} 0 R /MediaBox [0 0 612 792] ` +
          `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`
      )
    );
  }

  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesTree} 0 R >>`;
  objects[pagesTree - 1] =
    `<< /Type /Pages /Kids [${pageRefs.map((r) => `${r} 0 R`).join(" ")}] ` +
    `/Count ${pageRefs.length} >>`;

  // Byte offsets must be exact for the xref table; everything here is ASCII,
  // so string length equals byte length.
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\n`;
  out += `startxref\n${xrefAt}\n%%EOF\n`;

  return new TextEncoder().encode(out);
}

const WRAP_AT = 90;

function wrap(line: string): string[] {
  const out: string[] = [];
  let rest = line;
  while (rest.length > WRAP_AT) {
    const cut = rest.lastIndexOf(" ", WRAP_AT);
    const at = cut > 0 ? cut : WRAP_AT;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  out.push(rest);
  return out;
}

function escapePdfString(s: string): string {
  return s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, "?");
}
