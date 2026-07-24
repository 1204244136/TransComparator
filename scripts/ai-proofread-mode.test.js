const assert = require("node:assert/strict");
const test = require("node:test");

const { buildMessages, decisionToResult, parseDecision, proofreadPromptFor } = require("./ai-proofread");

function payload() {
  return {
    row: { index: 1, jp: "原文", cn: "译文", tw: "另一译文" },
    targetLabel: "B 译文",
    targetText: "译文",
    counterpartLabel: "A 原文",
    counterpartText: "原文",
    diffHelper: "不生成跨语言词级差异",
    context: [],
    contextMode: "none",
  };
}

test("bilingual AI prompt treats A as source and B as the only editable target", () => {
  const messages = buildMessages(payload(), { proofreadMode: "bilingual", systemPrompt: "base" });
  const user = JSON.parse(messages[1].content);
  assert.match(messages[0].content, /A 是原文，B 是唯一修改列/);
  assert.match(messages[0].content, /A 不是可直接复制进 B 的候选译文/);
  assert.equal(user.comparisonMode, "bilingual");
  assert.match(user.modePolicy, /只能修改 B/);
  assert.equal(user.row.targetLabel, "B 译文");
  assert.equal(user.row.counterpartLabel, "A 原文");
});

test("trilingual AI prompt keeps B and C peer-level and edits only the selected target", () => {
  const messages = buildMessages(payload(), { proofreadMode: "trilingual", systemPrompt: "base" });
  const user = JSON.parse(messages[1].content);
  assert.match(messages[0].content, /B、C 是同级非原文/);
  assert.match(messages[0].content, /只修改用户选择的目标列/);
  assert.equal(user.comparisonMode, "trilingual");
});

test("bilingual and trilingual workbenches use different default prompts", () => {
  const bilingual = proofreadPromptFor("bilingual").system;
  const trilingual = proofreadPromptFor("trilingual").system;
  assert.notEqual(bilingual, trilingual);
  assert.match(bilingual, /B 是唯一译文与唯一修改列/);
  assert.match(bilingual, /不要假设存在另一份译文/);
  assert.match(trilingual, /B、C 是同级非原文材料/);
  assert.match(trilingual, /better=counterpart/);
  assert.match(trilingual, /MQM 风格分级/);
  assert.equal(proofreadPromptFor("bilingual").outputSchema.severity.includes("critical"), true);
});

test("AI decisions normalize MQM-style severity only for definite edits", () => {
  assert.equal(parseDecision(JSON.stringify({
    semanticSame: false,
    needsEdit: true,
    needsContext: false,
    better: "neither",
    severity: "critical",
    summary: "关键数值误译，需要修改。",
    revisedText: "修订文本",
  })).severity, "critical");

  assert.equal(parseDecision(JSON.stringify({
    semanticSame: true,
    needsEdit: false,
    needsContext: false,
    better: "target",
    severity: "major",
    summary: "无需修改。",
    revisedText: "",
  })).severity, "none");

  assert.equal(parseDecision(JSON.stringify({
    semanticSame: false,
    needsEdit: true,
    needsContext: false,
    better: "neither",
    summary: "存在明确误译，需要修改。",
    revisedText: "修订文本",
  })).severity, "major");

  assert.equal(parseDecision(JSON.stringify({
    semanticSame: false,
    needsEdit: true,
    needsContext: false,
    better: "neither",
    severity: "none",
    summary: "存在明确误译，需要修改。",
    revisedText: "修订文本",
  })).severity, "major");
});

test("AI result notes include severity only for definite edits", () => {
  const edited = parseDecision(JSON.stringify({
    semanticSame: false,
    needsEdit: true,
    needsContext: false,
    better: "neither",
    severity: "critical",
    summary: "关键数值误译，需要修改。",
    revisedText: "修订文本",
  }));
  const unchanged = parseDecision(JSON.stringify({
    semanticSame: true,
    needsEdit: false,
    needsContext: false,
    better: "target",
    severity: "critical",
    summary: "无需修改。",
    revisedText: "",
  }));

  assert.match(decisionToResult({ index: 1 }, edited, "译文", "对照译文").note, /严重程度：致命/);
  assert.doesNotMatch(decisionToResult({ index: 2 }, unchanged, "译文", "对照译文").note, /严重程度：/);
});
