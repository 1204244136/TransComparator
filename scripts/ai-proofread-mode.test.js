const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const {
  buildApiUrl,
  buildChatCompletionBody,
  buildClaudeMessageBody,
  buildMessages,
  buildProviderHeaders,
  callModel,
  decisionToResult,
  extractClaudeText,
  isGptModel,
  listModels,
  normalizeNonGptTemperature,
  normalizeReasoningEffort,
  parseDecision,
  proofreadPromptFor,
} = require("./ai-proofread");

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
  assert.match(bilingual, /EPUB 注释标记/);
  assert.match(trilingual, /B、C 是同级非原文材料/);
  assert.match(trilingual, /better=counterpart/);
  assert.match(trilingual, /MQM 风格分级/);
  assert.equal(proofreadPromptFor("bilingual").outputSchema.severity.includes("critical"), true);
  assert.match(proofreadPromptFor("bilingual").outputSchema.revisedText, /原样保留目标列的 EPUB 注释标记/);
});

test("custom AI prompts still receive the mandatory noteref preservation rule", () => {
  const messages = buildMessages(payload(), { proofreadMode: "bilingual", systemPrompt: "custom" });

  assert.match(messages[0].content, /硬性格式约束/);
  assert.match(messages[0].content, /noteref 注释标记必须.*逐字、原位保留/);
});

test("GPT Chat Completions requests include the selected reasoning effort", () => {
  const messages = [{ role: "user", content: "proofread" }];
  const body = buildChatCompletionBody(messages, {
    model: "gpt-5.6",
    reasoningEffort: "high",
  });

  assert.deepEqual(body, {
    model: "gpt-5.6",
    messages,
    stream: false,
    reasoning_effort: "high",
  });
  assert.equal(isGptModel("openai/gpt-5.6-terra"), true);
  assert.equal(normalizeReasoningEffort(" XHIGH ", "openai/gpt-5.6-terra"), "xhigh");
});

test("non-GPT requests use the selected inference value as sampling temperature", () => {
  const body = buildChatCompletionBody([], {
    model: "qwen2.5:14b-instruct",
    reasoningEffort: "0.8",
  });

  assert.deepEqual(body, {
    model: "qwen2.5:14b-instruct",
    messages: [],
    stream: false,
    temperature: 0.8,
  });
  assert.equal(normalizeReasoningEffort("unsupported", "gpt-5.6"), "");
});

test("non-GPT temperature accepts values from 0.0 to 1.0", () => {
  assert.equal(normalizeNonGptTemperature("0"), 0);
  assert.equal(normalizeNonGptTemperature("0.74"), 0.7);
  assert.equal(normalizeNonGptTemperature("1.1"), null);
});

test("non-GPT requests omit temperature by default", () => {
  const missing = buildChatCompletionBody([], { model: "qwen" });
  const selected = buildChatCompletionBody([], { model: "qwen", reasoningEffort: "" });
  assert.equal(Object.hasOwn(missing, "temperature"), false);
  assert.equal(Object.hasOwn(selected, "temperature"), false);
  assert.equal(normalizeNonGptTemperature(""), null);
});

test("Claude API URLs accept base URLs with or without /v1", () => {
  assert.equal(buildApiUrl("https://api.anthropic.com", "/v1/messages"), "https://api.anthropic.com/v1/messages");
  assert.equal(buildApiUrl("https://api.anthropic.com/v1/", "/v1/messages"), "https://api.anthropic.com/v1/messages");
  assert.equal(buildApiUrl("https://proxy.example/anthropic/v1", "/v1/models"), "https://proxy.example/anthropic/v1/models");
  assert.equal(buildApiUrl("https://proxy.example/v2", "/v1/messages"), "https://proxy.example/v2/messages");
  assert.equal(buildApiUrl("https://api.anthropic.com/v1/messages", "/v1/messages"), "https://api.anthropic.com/v1/messages");
  assert.equal(buildApiUrl("https://api.anthropic.com/v1/messages", "/v1/models"), "https://api.anthropic.com/v1/models");
  assert.equal(buildApiUrl("https://proxy.example/anthropic/messages", "/v1/models"), "https://proxy.example/anthropic/models");
  assert.equal(buildApiUrl("https://proxy.example/v1/chat/completions", "/v1/models"), "https://proxy.example/v1/models");
  assert.equal(buildApiUrl("https://proxy.example/chat/completions", "/v1/chat/completions"), "https://proxy.example/chat/completions");
});

test("provider URLs accept full endpoints, bare hosts, and version roots", () => {
  const cases = [
    {
      input: "https://api.evomap.ai/v1/chat/completions",
      chat: "https://api.evomap.ai/v1/chat/completions",
      models: "https://api.evomap.ai/v1/models",
    },
    {
      input: "https://ctmoai.com",
      chat: "https://ctmoai.com/v1/chat/completions",
      models: "https://ctmoai.com/v1/models",
    },
    {
      input: "https://api.hostcentral.cc/v1",
      chat: "https://api.hostcentral.cc/v1/chat/completions",
      models: "https://api.hostcentral.cc/v1/models",
    },
  ];

  for (const item of cases) {
    assert.equal(buildApiUrl(item.input, "/v1/chat/completions"), item.chat);
    assert.equal(buildApiUrl(item.input, "/v1/models"), item.models);
  }
});

test("Claude Messages requests use native headers and body shape", () => {
  const messages = [
    { role: "system", content: "proofread carefully" },
    { role: "user", content: "text" },
  ];
  assert.deepEqual(buildProviderHeaders({ provider: "claude", apiKey: "secret" }), {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "x-api-key": "secret",
  });
  assert.deepEqual(buildClaudeMessageBody(messages, { model: "claude-sonnet-5", reasoningEffort: "0.2" }), {
    model: "claude-sonnet-5",
    max_tokens: 4096,
    messages: [{ role: "user", content: "text" }],
    system: "proofread carefully",
    temperature: 0.2,
  });
  assert.equal(extractClaudeText({
    content: [
      { type: "thinking", thinking: "hidden" },
      { type: "text", text: "{\"needsEdit\":false}" },
    ],
  }), "{\"needsEdit\":false}");
});

test("Claude provider calls /v1/messages when the configured address omits /v1", async () => {
  let received = null;
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received = {
        url: request.url,
        headers: request.headers,
        body: JSON.parse(body),
      };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        content: [{ type: "text", text: "{\"needsEdit\":false}" }],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    const result = await callModel([
      { role: "system", content: "system prompt" },
      { role: "user", content: "proofread" },
    ], {
      provider: "claude",
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: "claude-sonnet-5",
      apiKey: "test-key",
    });

    assert.equal(result, "{\"needsEdit\":false}");
    assert.equal(received.url, "/v1/messages");
    assert.equal(received.headers["x-api-key"], "test-key");
    assert.equal(received.headers["anthropic-version"], "2023-06-01");
    assert.equal(received.headers.authorization, undefined);
    assert.equal(received.body.system, "system prompt");
    assert.deepEqual(received.body.messages, [{ role: "user", content: "proofread" }]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("OpenAI-compatible provider adds /v1 when the configured address omits it", async () => {
  let receivedUrl = "";
  const server = http.createServer((request, response) => {
    receivedUrl = request.url;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    const result = await callModel([{ role: "user", content: "proofread" }], {
      provider: "compatible",
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: "gpt-test",
    });

    assert.equal(receivedUrl, "/v1/chat/completions");
    assert.equal(result, "ok");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Claude model discovery calls /v1/models with native authentication", async () => {
  let received = null;
  const server = http.createServer((request, response) => {
    received = { url: request.url, headers: request.headers };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }],
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    const result = await listModels({
      provider: "claude",
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "test-key",
    });

    assert.equal(received.url, "/v1/models");
    assert.equal(received.headers["x-api-key"], "test-key");
    assert.equal(received.headers["anthropic-version"], "2023-06-01");
    assert.deepEqual(result.models.map((model) => model.id), ["claude-sonnet-5"]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
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
