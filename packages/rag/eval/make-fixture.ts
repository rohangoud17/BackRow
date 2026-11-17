/**
 * Regenerate the eval fixture PDF from its page text.
 *
 *   npm run eval:fixture
 *
 * The page text in `fixtures/algorithms-lecture.pages.json` is the source of
 * truth; the PDF is checked in next to it so the eval can be run without a
 * build step, and so everyone evaluates against byte-identical input. Edit the
 * JSON, rerun this, and commit both.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makePdf } from "../src/testing/make-pdf";

const dir = join(process.cwd(), "packages", "rag", "eval", "fixtures");
const source = JSON.parse(readFileSync(join(dir, "algorithms-lecture.pages.json"), "utf8")) as {
  pages: string[];
};

for (const [i, page] of source.pages.entries()) {
  // makePdf computes byte offsets from string length, which only holds for ASCII.
  // eslint-disable-next-line no-control-regex
  const bad = page.match(/[^\x00-\x7f]/);
  if (bad) throw new Error(`page ${i + 1} contains a non-ASCII character: ${JSON.stringify(bad[0])}`);
}

const out = join(dir, "algorithms-lecture.pdf");
writeFileSync(out, makePdf(source.pages));
console.log(`wrote ${out} (${source.pages.length} pages)`);
