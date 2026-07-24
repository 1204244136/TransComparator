const assert = require("node:assert/strict");
const test = require("node:test");

const { buildMessages } = require("./ai-proofread");

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
