const assert = require("node:assert/strict");
const test = require("node:test");

const { makeHtml, toCsv } = require("./build-compare");

test("bilingual workbench fixes AI target to B and omits C", () => {
  const rows = [{
    index: 1,
    chapter: "正文",
    relation: "原文-译文 1:1",
    score: 0.8,
    jpAlignScore: 0.8,
    jp: "source",
    cn: "target",
    tw: "",
    twCn: "",
    jpChars: 6,
    cnChars: 6,
    twChars: 0,
  }];
  const selection = {
    comparisonMode: "bilingual",
    files: { jp: "A.txt", cn: "B.txt", tw: "" },
    labels: { jp: "A 原文", cn: "B 译文", tw: "C 版本" },
  };
  const projectContext = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    projectKey: "project",
    rowsSignature: "rows",
    notesStorage: { key: "notes" },
  };

  const html = makeHtml(rows, selection, projectContext, "<pgr:powergrep/>");
  assert.match(html, /双语翻译对比校对工作台/);
  assert.match(html, /id="aiTarget" disabled/);
  assert.match(html, /<option value="cn">B 译文<\/option>/);
  assert.doesNotMatch(html, /<option value="tw">/);
  assert.match(html, /目标固定为译文 B，参考原文 A/);
  assert.match(html, /\.ai-secondary\s*\{[^}]*align-items: start;/);

  const script = html.split("<script>")[1].split("</script>")[0];
  assert.doesNotThrow(() => new Function(script));
});

test("trilingual workbench lets AI target either B or C", () => {
  const rows = [{
    index: 1,
    chapter: "正文",
    relation: "B-C 1:1 / A-B 1:1",
    score: 0.8,
    jpAlignScore: 0.8,
    jp: "source",
    cn: "version b",
    tw: "version c",
    twCn: "version c",
    jpChars: 6,
    cnChars: 9,
    twChars: 9,
  }];
  const selection = {
    comparisonMode: "trilingual",
    files: { jp: "A.txt", cn: "B.txt", tw: "C.txt" },
    labels: { jp: "A 原文", cn: "B 版本", tw: "C 版本" },
  };
  const projectContext = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    projectKey: "project",
    rowsSignature: "rows",
    notesStorage: { key: "notes" },
  };

  const html = makeHtml(rows, selection, projectContext, "<pgr:powergrep/>");
  assert.match(html, /三语翻译对比校对工作台/);
  assert.match(html, /<option value="cn">B 版本<\/option>/);
  assert.match(html, /<option value="tw">C 版本<\/option>/);
  assert.match(html, /目标可选非原文 B 或 C/);

  const script = html.split("<script>")[1].split("</script>")[0];
  assert.doesNotThrow(() => new Function(script));
});

test("bilingual CSV contains only source A and target B text columns", () => {
  const csv = toCsv([{ index: 1, jp: "source", cn: "target", tw: "unused" }], "bilingual");
  const [header] = csv.split("\n");
  assert.equal(header, "index,chapter,relation,score,jpAlignScore,jp,cn");
});
