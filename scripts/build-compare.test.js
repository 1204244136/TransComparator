const assert = require("node:assert/strict");
const test = require("node:test");

const {
  makeHtml,
  restorableModelOptions,
  resolveModelOptions,
  toCsv,
} = require("./build-compare");

test("model refresh replaces models from the previous API base URL", () => {
  const result = resolveModelOptions([
    { id: "new-model-1" },
    { id: "new-model-2" },
  ], "old-model");

  assert.deepEqual(result.models, ["new-model-1", "new-model-2"]);
  assert.deepEqual(result.options, ["new-model-1", "new-model-2", "custom"]);
  assert.equal(result.selected, "new-model-1");
});

test("model refresh preserves the selection only when the new API still provides it", () => {
  const result = resolveModelOptions([
    "shared-model",
    "new-model",
    "shared-model",
  ], "shared-model");

  assert.deepEqual(result.models, ["shared-model", "new-model"]);
  assert.equal(result.selected, "shared-model");
});

test("model option cache is restored only for the API base URL that produced it", () => {
  const cached = {
    baseUrl: "https://new.example/v1/",
    modelOptionsBaseUrl: "https://new.example/v1",
    modelOptions: ["new-model"],
  };

  assert.deepEqual(restorableModelOptions(cached), ["new-model"]);
  assert.deepEqual(restorableModelOptions({ ...cached, baseUrl: "https://other.example/v1" }), []);
  assert.deepEqual(restorableModelOptions({ ...cached, modelOptionsBaseUrl: undefined }), []);
});

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
  assert.match(html, /\.ai-config-band\s*\{[^}]*grid-template-columns: 88px minmax\(0, 1fr\);/);
  assert.match(html, /id="aiServiceLabel" class="ai-config-label">AI 服务/);
  assert.match(html, /id="aiProofreadLabel" class="ai-config-label">校对设置/);
  assert.match(html, /class="ai-runbar"/);
  assert.doesNotMatch(html, /id="aiProofreadModeHint"/);
  assert.match(html, /translation-compare-ai-prompt-v1:/);
  assert.match(html, /pageMeta\.projectKey \|\| "unscoped"/);
  assert.match(html, /data-issue-severity="critical"/);
  assert.match(html, /严重程度/);
  assert.match(html, /issueSeverityFilter/);
  assert.match(html, /id="aiReasoningField" class="ai-field" hidden/);
  assert.match(html, /<option value="xhigh">极高 \(xhigh\)<\/option>/);

  const script = html.split("<script>")[1].split("</script>")[0];
  const globalConfigWriter = script.match(/function saveAiConfig\(\)[\s\S]*?function saveAiPrompt/)[0];
  assert.doesNotMatch(globalConfigWriter, /systemPrompt: aiIds\.prompt\.value/);
  assert.match(script, /localStorage\.setItem\(aiPromptStorageKey/);
  assert.match(script, /afterRevision/);
  assert.match(script, /knownRequestId/);
  assert.match(script, /aiRequestCache/);
  assert.match(script, /aiStatusRefreshInFlight/);
  assert.match(script, /pendingResults\.length[\s\S]*?saveNotes\(\)[\s\S]*?updateDoneCount\(\)/);
  assert.match(script, /function writeNote\([^)]*\{ deferCommit = false \}/);
  assert.match(script, /resultLimit: "64"/);
  assert.match(script, /requestIdleCallback\(commit, \{ timeout: 2000 \}\)/);
  assert.match(script, /window\.addEventListener\("pagehide", flushNotes\)/);
  assert.match(script, /selectedRevisionIds\.clear\(\);[\s\S]*?applyFilters\(\{ reset: false \}\);[\s\S]*?tableFrame\.scrollTop = 0;/);
  assert.match(script, /function visibleRevisionCheckboxes\(\)[\s\S]*?getClientRects\(\)\.length > 0/);
  assert.match(script, /function focusRevisionTarget\(target\)[\s\S]*?Math\.floor\(target\.filteredIndex \/ size\) \+ 1[\s\S]*?renderVisibleRows\(\)/);
  assert.match(script, /function focusAdjacentRevision\(direction, currentCheckbox = null\)[\s\S]*?targets\[targetIndex \+ direction\]/);
  assert.match(script, /input:not\(\[type="checkbox"\]\), textarea, select/);
  assert.match(script, /event\.key === "ArrowDown" \? 1 : -1/);
  assert.match(script, /scrollIntoView\(\{ block: "nearest", inline: "nearest" \}\)/);
  assert.match(script, /reasoningEffort: aiIds\.reasoningEffort\.value/);
  assert.match(script, /function updateReasoningEffortVisibility\(\)/);
  assert.doesNotMatch(html, /backdrop-filter/);
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
  assert.match(html, /AI 问题严重程度/);

  const script = html.split("<script>")[1].split("</script>")[0];
  assert.doesNotThrow(() => new Function(script));
});

test("bilingual CSV contains only source A and target B text columns", () => {
  const csv = toCsv([{ index: 1, jp: "source", cn: "target", tw: "unused" }], "bilingual");
  const [header] = csv.split("\n");
  assert.equal(header, "index,chapter,relation,score,jpAlignScore,jp,cn");
});
