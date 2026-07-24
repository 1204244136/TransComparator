const test = require("node:test");
const assert = require("node:assert/strict");

const {
  sliceMainDocument,
  splitParagraphs,
} = require("./text-utils");

test("recognizes Japanese and Chinese episode headings in combined works", () => {
  const jp = splitParagraphs("第一話\n\n本文です。\n\n第二話 別の事件\n\n続きです。", "jp");
  assert.deepEqual(jp.map((paragraph) => paragraph.chapter), ["第一話", "第二話 別の事件"]);

  const cn = splitParagraphs("第一话\n\n这是正文。\n\n第2话 后续\n\n这是后续。", "cn");
  assert.deepEqual(cn.map((paragraph) => paragraph.chapter), ["第一话", "第2话 后续"]);
});

test("does not truncate a later work after an intermediate afterword", () => {
  const source = [
    "第一章",
    "\n\n第一部正文内容足够长，可以被正文检测逻辑识别。",
    "\n\nあとがき",
    "\n\n第一部后记。",
    "\n\n第二話",
    "\n\n第二部正文内容足够长，可以被正文检测逻辑识别。",
    "\n\nあとがき",
    "\n\n最终后记。",
  ].join("");

  const sliced = sliceMainDocument(source, "jp");
  assert.match(sliced, /第二部正文/);
  assert.doesNotMatch(sliced, /最终后记/);
});
