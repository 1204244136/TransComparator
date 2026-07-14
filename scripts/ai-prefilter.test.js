const test = require("node:test");
const assert = require("node:assert/strict");
const {
  canUseSimilarityPrefilter,
  canonicalText,
  classifyPrefilter,
} = require("./ai-prefilter");

test("canonicalText normalizes width, whitespace, and invisible characters", () => {
  assert.equal(canonicalText("\uFEFF ３\u200B "), "3");
});

test("full-width and half-width numeric rows are deterministically equivalent", () => {
  assert.deepEqual(
    classifyPrefilter({ source: "３", left: "3", right: "３", score: 0.28 }, 0.92)?.kind,
    "rule-equivalent",
  );
});

test("structured content that disagrees with the source is routed to manual review", () => {
  assert.equal(
    classifyPrefilter({ source: "4", left: "３", right: "3", score: 1 }, 0.92)?.kind,
    "structured-conflict",
  );
});

test("different structured values never enter AI proofreading", () => {
  assert.equal(
    classifyPrefilter({ source: "4", left: "3", right: "4", score: 0 }, 0.92)?.kind,
    "structured-conflict",
  );
});

test("empty non-source cells are skipped without an AI call", () => {
  assert.equal(
    classifyPrefilter({ source: "本文", left: "", right: "", score: 0 }, 0.92)?.kind,
    "rule-empty",
  );
});

test("short punctuation differences are not treated as deterministic equality", () => {
  assert.equal(classifyPrefilter({ left: "哇！", right: "哇。", score: 1 }, 0.92), null);
});

test("similarity prefilter rejects changed numeric tokens", () => {
  const left = "这是用于校验第3章节编号是否一致的一段较长正文内容";
  const right = "这是用于校验第4章节编号是否一致的一段较长正文内容";
  assert.equal(canUseSimilarityPrefilter(left, right), false);
  assert.equal(classifyPrefilter({ left, right, score: 1 }, 0.92), null);
});

test("guarded long prose can still use the configured similarity threshold", () => {
  const left = "天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜甲";
  const right = "天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜乙";
  assert.equal(canUseSimilarityPrefilter(left, right), true);
  assert.equal(classifyPrefilter({ left, right, score: 0.96 }, 0.92)?.kind, "similarity");
});
