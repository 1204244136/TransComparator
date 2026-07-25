const assert = require("node:assert/strict");
const test = require("node:test");

const {
  epubHtmlToText,
  extractNoterefMarkup,
  restorePandocNoterefMarkup,
} = require("./epub-utils");

const originalNoteref = '<a class="nodeco" epub:type="noteref" href="S4_03-Note.xhtml#note6"><sup>㊟</sup></a>';

test("EPUB conversion preserves complete noteref markup by default", () => {
  const text = epubHtmlToText(`<p>before ${originalNoteref} after</p>`);

  assert.equal(text, `before ${originalNoteref} after`);
});

test("EPUB conversion removes ordinary anchor markup", () => {
  const text = epubHtmlToText('<p>before <a href="chapter.xhtml">link</a> after</p>');

  assert.equal(text, "before link after");
});

test("EPUB conversion can remove noteref markup while retaining its visible symbol", () => {
  const text = epubHtmlToText(`<p>before ${originalNoteref} after</p>`, { inlineMarkup: { noteref: false } });

  assert.equal(text, "before ㊟ after");
});

test("Pandoc noteref markup is replaced with the original EPUB markup", () => {
  const pandoc = '<p>text<a href="#S4_03-Note.xhtml_note6" class="nodeco noteref"><sup>㊟</sup></a></p>';
  const restored = restorePandocNoterefMarkup(pandoc, extractNoterefMarkup(originalNoteref));

  assert.equal(restored, `<p>text${originalNoteref}</p>`);
});
