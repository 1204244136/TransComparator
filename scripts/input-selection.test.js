const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  guessLangOrder,
  inferInputMode,
  validateSelection,
} = require("./input-selection");
const { loadParagraphs } = require("./text-utils");

function withTextFiles(count, callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-selection-"));
  try {
    const files = Array.from({ length: count }, (_, index) => {
      const file = path.join(dir, `text-${index + 1}.txt`);
      fs.writeFileSync(file, `paragraph ${index + 1}`, "utf8");
      return file;
    });
    callback(files);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("bilingual selection accepts source A and target B without a C file", () => {
  withTextFiles(2, ([jp, cn]) => {
    const selection = validateSelection({
      comparisonMode: "bilingual",
      files: { jp, cn, tw: "" },
    });
    assert.equal(selection.comparisonMode, "bilingual");
    assert.equal(selection.files.tw, "");
    assert.equal(selection.inputMode, "txt");
  });
});

test("trilingual selection still requires three files", () => {
  withTextFiles(2, ([jp, cn]) => {
    assert.throws(
      () => validateSelection({ comparisonMode: "trilingual", files: { jp, cn, tw: "" } }),
      /Missing tw input file/,
    );
  });
});

test("bilingual file guessing leaves the third role empty", () => {
  withTextFiles(2, (files) => {
    const guessed = guessLangOrder(files, "bilingual");
    assert.ok(guessed.jp);
    assert.ok(guessed.cn);
    assert.equal(guessed.tw, null);
    assert.equal(inferInputMode(guessed), "txt");
  });
});

test("bilingual paragraph export does not read a third file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-paragraphs-"));
  const jp = path.join(dir, "a.txt");
  const cn = path.join(dir, "b.txt");
  fs.writeFileSync(jp, "source paragraph", "utf8");
  fs.writeFileSync(cn, "target paragraph", "utf8");
  try {
    const paragraphs = await loadParagraphs({
      comparisonMode: "bilingual",
      inputMode: "txt",
      files: { jp, cn, tw: "" },
    });
    assert.ok(paragraphs.jp.length > 0);
    assert.ok(paragraphs.cn.length > 0);
    assert.deepEqual(paragraphs.tw, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
