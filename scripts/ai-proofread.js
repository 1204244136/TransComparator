const fs = require("fs");
const { diffWordsWithSpace } = require("diff");
const OpenCC = require("opencc-js");
const { classifyPrefilter } = require("./ai-prefilter");
const { rowSignature, sameProjectSnapshot } = require("./project-context");
const { resolveProjectArtifact } = require("./project-store");
const toCn = OpenCC.Converter({ from: "tw", to: "cn" });
const toTw = OpenCC.Converter({ from: "cn", to: "tw" });

const providerDefaults = {
  compatible: {
    name: "第三方兼容服务",
    baseUrl: "",
    model: "",
    apiKeyPlaceholder: "按第三方服务要求填写",
    note: "第三方兼容服务需要填写服务商提供的 Base URL 和模型名。",
  },
  local: {
    name: "本地默认",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen2.5:14b-instruct",
    apiKeyPlaceholder: "本地兼容服务通常可留空",
    note: "本地默认使用本机 OpenAI-compatible /v1 接口；如端口或模型不同，请按实际服务修改。",
  },
};

const knownModelFallbacks = [
  {
    pattern: /(?:^|\.)xiaomimimo\.com(?:\/|$)|(?:^|\/\/)token-plan-cn\.xiaomimimo\.com(?:\/|$)/i,
    models: [
      { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro", provider: "compatible", fallback: true },
      { id: "mimo-v2.5", name: "MiMo V2.5", provider: "compatible", fallback: true },
    ],
  },
];

const proofreadOutputSchema = {
  semanticSame: "boolean",
  needsEdit: "boolean（目标列是否需要修改；与 semanticSame 分开判断）",
  needsContext: "boolean",
  better: "target | counterpart | neither | unclear（三语模式中 counterpart 表示另一非原文更好；双语模式中原文不是候选译文，需要修改时通常使用 neither）",
  severity: "none | minor | major | critical（仅 needsEdit=true 且能够明确判断时使用 minor、major 或 critical；否则必须为 none）",
  summary: "分析为什么需要或不需要修改；需要上下文时说明缺少哪类上下文；不要留空",
  revisedText: "需要修改时，输出目标列修改后的完整句子或完整段落；三语模式 better=counterpart 时须在目标列原文上做局部替换；不需要修改或需要上下文则留空",
};

const sharedProofreadInstructions = [
  "你是严谨的翻译校对助手，目标是辅助人工校对，不替代人工最终判断。",
  "semanticSame 与 needsEdit 必须分别判断；语义相同但表达生硬、翻译腔、遗漏语气或存在其他明确问题时，可以 semanticSame=true、needsEdit=true。",
  "需要修改时，revisedText 必须是目标列修改后的完整句子或段落，可直接整体替换，并保留目标列的语言、字形和文体习惯；不能只描述改法。",
  "仅凭当前行不足以判断时（如代词、承接关系、省略主语、术语延续、上文伏笔或下文指代影响判断）返回 needsContext=true；有足够依据就给出明确判断，不要为保险而索要上下文。",
  "不要猜测需要多少上下文，也不要说明上下文请求范围；程序会在 needsContext=true 时逐轮补充相邻行。",
  "严重程度采用 MQM 风格分级：minor（轻微）指不改变意义、不影响使用的局部流畅度、语法、标点或文体问题；major（严重）指影响准确性、完整性或可用性的误译、漏译、增译、关键术语、语气或逻辑关系问题；critical（致命）指颠倒或严重歪曲核心意义、破坏关键人名/数值/否定/指令，或可能造成安全、法律、声誉等高风险后果的问题。critical 应谨慎使用。",
  "仅当 needsEdit=true、needsContext=false 且判断明确时，severity 才能为 minor、major 或 critical；无需修改或待人工确认时 severity 必须为 none。",
  "summary 必须与 semanticSame、needsEdit、better、revisedText 完全一致。",
  "只返回 JSON，不要返回 Markdown 或额外解释；必须使用 outputSchema 中的英文键名，不要省略 summary，需要修改时不要省略 severity 和 revisedText。",
];

const proofreadPrompts = {
  bilingual: {
    system: [
      ...sharedProofreadInstructions,
      "当前是双语校对：A 是原文和语义依据，B 是唯一译文与唯一修改列。",
      "semanticSame 表示 B 是否完整、准确地传达 A 的核心语义；needsEdit 表示 B 是否存在误译、漏译、增译、语气偏差、术语问题或不自然表达。",
      "A 不是候选译文，不得把 A 直接复制进 B。不要假设存在另一份译文，也不要比较不存在的 counterpartText。",
      "B 无需修改时 better=target；B 需要修改时通常 better=neither，并基于 A 对 B 做最小且完整的修订。",
    ].join("\n"),
    outputSchema: proofreadOutputSchema,
  },
  trilingual: {
    system: [
      ...sharedProofreadInstructions,
      "当前是三语校对：A 是原文和准入边界，B、C 是同级非原文材料，不要默认任何一方更权威。",
      "只修改用户选择的目标列；semanticSame 表示目标列与另一非原文列的核心语义是否相同，needsEdit 表示目标列结合 A 判断后是否需要修改。",
      "若两份非原文不同但目标列更准确或更贴合 A，返回 semanticSame=false、needsEdit=false、better=target，不要建议修改目标列。",
      "better=counterpart 表示另一非原文列更好：在目标列原文上做最小化局部替换，只融入更优片段并调整为目标列的字形和用词，保留目标列已正确通顺的部分；禁止抛开现有译文重新翻译整句。",
    ].join("\n"),
    outputSchema: proofreadOutputSchema,
  },
};

function proofreadPromptFor(mode) {
  return mode === "bilingual" ? proofreadPrompts.bilingual : proofreadPrompts.trilingual;
}

const proofreadPrompt = proofreadPrompts.trilingual;

const contextBudget = {
  maxRounds: 6,
  maxRows: 12,
  maxChars: 6000,
};

const status = {
  running: false,
  stopRequested: false,
  runId: "",
  startedAt: null,
  finishedAt: null,
  target: "cn",
  proofreadMode: "bilingual",
  provider: "local",
  model: "",
  projectKey: "",
  rowsSignature: "",
  monitorEnabled: false,
  total: 0,
  queued: 0,
  processed: 0,
  handled: 0,
  prefiltered: 0,
  rulePrefiltered: 0,
  similarityPrefiltered: 0,
  structuredConflicts: 0,
  skippedDone: 0,
  modelProcessed: 0,
  modelHandled: 0,
  suggested: 0,
  errors: 0,
  active: [],
  activeRequests: [],
  recentRequests: [],
  error: "",
  logs: [],
  results: new Map(),
  resultChanges: [],
  resultRevision: 0,
};

let controllers = new Set();

function pushLog(line) {
  const text = String(line || "").replace(/\r\n?/g, "\n");
  for (const part of text.split("\n")) {
    if (!part) continue;
    status.logs.push(part);
  }
  if (status.logs.length > 300) {
    status.logs.splice(0, status.logs.length - 300);
  }
}

function clientStatus(options = {}) {
  const sameRun = Boolean(options.runId) && options.runId === status.runId;
  const afterRevision = sameRun ? clampInteger(options.afterRevision, 0, Number.MAX_SAFE_INTEGER, 0) : 0;
  const resultLimit = clampInteger(options.resultLimit, 0, 500, 0);
  const knownRequestIds = new Set(Array.isArray(options.knownRequestIds) ? options.knownRequestIds : []);
  const incrementalResults = status.resultChanges.slice(afterRevision, resultLimit ? afterRevision + resultLimit : undefined);
  const results = options.includeResults === false
    ? []
    : (resultLimit || afterRevision
      ? incrementalResults
      : Array.from(status.results.values()).sort((a, b) => a.index - b.index));
  const deliveredRevision = options.includeResults === false
    ? afterRevision
    : (resultLimit || afterRevision
      ? (results.length ? results.at(-1).resultRevision : afterRevision)
      : status.resultRevision);
  return {
    running: status.running,
    stopRequested: status.stopRequested,
    runId: status.runId,
    startedAt: status.startedAt,
    finishedAt: status.finishedAt,
    target: status.target,
    proofreadMode: status.proofreadMode,
    provider: status.provider,
    model: status.model,
    projectKey: status.projectKey,
    rowsSignature: status.rowsSignature,
    monitorEnabled: status.monitorEnabled,
    total: status.total,
    queued: status.queued,
    processed: status.processed,
    handled: status.handled,
    prefiltered: status.prefiltered,
    rulePrefiltered: status.rulePrefiltered,
    similarityPrefiltered: status.similarityPrefiltered,
    structuredConflicts: status.structuredConflicts,
    skippedDone: status.skippedDone,
    modelProcessed: status.modelProcessed,
    modelHandled: status.modelHandled,
    suggested: status.suggested,
    errors: status.errors,
    active: status.active,
    activeRequests: withElapsed(status.activeRequests).map((request) => requestForClient(request, knownRequestIds)),
    recentRequests: status.recentRequests.map((request) => requestForClient(request, knownRequestIds)),
    error: status.error,
    logs: options.includeLogs === false ? [] : status.logs,
    results,
    resultRevision: deliveredRevision,
    latestResultRevision: status.resultRevision,
    hasMoreResults: deliveredRevision < status.resultRevision,
    providerDefaults,
    proofreadPrompt: proofreadPromptFor(status.proofreadMode),
  };
}

function withElapsed(requests) {
  const now = Date.now();
  return requests.map((request) => ({
    ...request,
    elapsedMs: Math.max(0, now - Date.parse(request.startedAt || new Date())),
  }));
}

function readRows(inputProject = {}) {
  const compareJsonFile = resolveProjectArtifact(inputProject.projectKey, "translation-compare.json", {
    rowsSignature: inputProject.rowsSignature,
  });
  const data = JSON.parse(fs.readFileSync(compareJsonFile, "utf8"));
  return {
    project: data.project || null,
    rows: data.rows || [],
    labels: data.labels || {},
  };
}

function requireMatchingProjectSnapshot(inputProject, currentProject) {
  if (!inputProject?.projectKey || !inputProject?.rowsSignature) {
    throw new Error("AI 校对请求缺少项目上下文，请从当前工作台重新启动。");
  }
  if (!currentProject?.projectKey || !currentProject?.rowsSignature) {
    throw new Error("当前工作台缺少项目上下文，请重新生成工作台。");
  }
  if (!sameProjectSnapshot(inputProject, currentProject)) {
    throw new Error("AI 校对请求不属于当前项目快照，请重新生成并打开工作台。");
  }
}

function cleanConfig(input = {}) {
  const provider = providerDefaults[input.provider] ? input.provider : "local";
  const defaults = providerDefaults[provider];
  const target = input.target === "tw" ? "tw" : "cn";
  const proofreadMode = input.proofreadMode === "trilingual" ? "trilingual" : "bilingual";
  const concurrency = clampInteger(input.concurrency, 1, 12, 3);
  const similarityThreshold = clampNumber(input.similarityThreshold, 0.5, 1, 0.92);
  return {
    provider,
    target,
    proofreadMode,
    concurrency,
    similarityThreshold,
    projectKey: String(input.projectKey || "").trim(),
    rowsSignature: String(input.rowsSignature || "").trim(),
    baseUrl: String(input.baseUrl || defaults.baseUrl).trim().replace(/\/+$/, ""),
    model: String(input.model || defaults.model).trim(),
    apiKey: String(input.apiKey || "").trim(),
    systemPrompt: String(input.systemPrompt || "").trim() || proofreadPromptFor(proofreadMode).system,
    completedIndexes: normalizeIndexSet(input.completedIndexes),
    monitorEnabled: Boolean(input.monitorEnabled),
  };
}

function normalizeIndexSet(value) {
  const source = Array.isArray(value) ? value : [];
  const indexes = source
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0);
  return new Set(indexes);
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function resetStatus(config, rowsLength) {
  status.running = true;
  status.stopRequested = false;
  status.runId = new Date().toISOString();
  status.startedAt = status.runId;
  status.finishedAt = null;
  status.target = config.target;
  status.proofreadMode = config.proofreadMode;
  status.provider = config.provider;
  status.model = config.model;
  status.projectKey = config.projectKey;
  status.rowsSignature = config.rowsSignature;
  status.monitorEnabled = config.monitorEnabled;
  status.total = rowsLength;
  status.queued = 0;
  status.processed = 0;
  status.handled = 0;
  status.prefiltered = 0;
  status.rulePrefiltered = 0;
  status.similarityPrefiltered = 0;
  status.structuredConflicts = 0;
  status.skippedDone = 0;
  status.modelProcessed = 0;
  status.modelHandled = 0;
  status.suggested = 0;
  status.errors = 0;
  status.active = [];
  status.activeRequests = [];
  status.recentRequests = [];
  status.error = "";
  status.logs = [];
  status.results = new Map();
  status.resultChanges = [];
  status.resultRevision = 0;
  controllers = new Set();
}

function makePrefilterResult(row, labels, classification, comparisonMode = "trilingual") {
  const sourceLabel = labels.jp || "原文 A";
  const leftLabel = comparisonMode === "bilingual" ? sourceLabel : (labels.cn || "非原文 B");
  const rightLabel = comparisonMode === "bilingual" ? (labels.cn || "译文 B") : (labels.tw || "非原文 C");
  const isConflict = classification.kind === "structured-conflict";
  const isSimilarity = classification.kind === "similarity";
  const marker = isSimilarity ? "[相似度预筛]" : "[规则预筛]";
  const analysis = isSimilarity
    ? `${leftLabel} 与 ${rightLabel} 的受保护正文相似度为 ${Math.round(classification.similarity * 100)}%。`
    : classification.reason;
  return {
    runId: status.runId,
    index: row.index,
    signature: rowSignature(row),
    status: isConflict ? "rule-conflict" : (isSimilarity ? "similarity-prefilter" : "rule-prefilter"),
    done: !isConflict,
    note: [
      marker,
      `语义是否相同：${isConflict ? "待人工确认" : "相同"}`,
      `是否需要修改：${isConflict ? "待人工确认" : "否"}`,
      `分析：${analysis}${row.jp ? ` 参照列：${sourceLabel}。` : ""}`,
    ].filter(Boolean).join("\n"),
  };
}

function requestForClient(request, knownRequestIds) {
  if (!knownRequestIds.has(request.id)) return request;
  const { messages, ...summary } = request;
  return summary;
}

function addResult(result, { prefilterKind = "" } = {}) {
  status.resultRevision += 1;
  const storedResult = { ...result, resultRevision: status.resultRevision };
  status.results.set(result.index, storedResult);
  status.resultChanges.push(storedResult);
  status.processed += 1;
  if (result.done) status.handled += 1;
  if (prefilterKind) {
    status.prefiltered += 1;
    if (prefilterKind === "rule") status.rulePrefiltered += 1;
    if (prefilterKind === "similarity") status.similarityPrefiltered += 1;
    if (prefilterKind === "structured-conflict") status.structuredConflicts += 1;
  } else {
    status.modelProcessed += 1;
    if (result.done) status.modelHandled += 1;
  }
  if (result.status === "suggestion") status.suggested += 1;
  if (result.status === "error") status.errors += 1;
}

async function startProofread(input) {
  if (status.running) {
    const error = new Error("AI 校对正在运行。");
    error.code = "RUNNING";
    throw error;
  }

  const config = cleanConfig(input);
  if (!config.model) throw new Error("请输入模型名称。");
  if (!config.baseUrl) throw new Error("请输入接口地址。");

  const { project, rows } = readRows(config);
  requireMatchingProjectSnapshot(config, project);
  config.proofreadMode = project.comparisonMode === "bilingual" ? "bilingual" : "trilingual";
  if (!String(input.systemPrompt || "").trim()) {
    config.systemPrompt = proofreadPromptFor(config.proofreadMode).system;
  }
  if (config.proofreadMode === "bilingual") config.target = "cn";
  resetStatus(config, rows.length);
  const labels = {
    jp: "原文 A",
    cn: "非原文 B",
    tw: "非原文 C",
    ...(input.labels || {}),
  };
  const queue = [];

  for (const row of rows) {
    if (config.completedIndexes.has(Number(row.index))) {
      status.skippedDone += 1;
      continue;
    }
    const left = config.proofreadMode === "bilingual" ? (row.jp || "") : (row.cn || "");
    const right = config.proofreadMode === "bilingual" ? (row.cn || "") : (row.twCn || toCn(row.tw || ""));
    const classification = classifyPrefilter({
      source: row.jp || "",
      left,
      right,
      score: row.score,
    }, config.similarityThreshold);
    if (classification) {
      const prefilterKind = classification.kind === "similarity"
        ? "similarity"
        : (classification.kind === "structured-conflict" ? "structured-conflict" : "rule");
      addResult(makePrefilterResult(row, labels, classification, config.proofreadMode), { prefilterKind });
      continue;
    }
    queue.push(row);
  }

  status.queued = queue.length;
  pushLog(`${config.proofreadMode === "bilingual" ? "双语版本校对" : "三语语境校对"}：人工确认跳过 ${status.skippedDone} 行，规则跳过 ${status.rulePrefiltered} 行，结构化冲突 ${status.structuredConflicts} 行，相似度跳过 ${status.similarityPrefiltered} 行，剩余 ${queue.length} 行进入 AI 校对。`);
  runQueue(queue, rows, config, labels).catch((error) => {
    status.error = error.message || String(error);
    pushLog(status.error);
    finish();
  });
  return clientStatus({ includeResults: false });
}

async function listModels(input = {}) {
  const config = cleanConfig({ ...input, model: input.model || "placeholder" });
  if (!config.baseUrl) throw new Error("请输入接口地址。");

  try {
    const headers = { "content-type": "application/json" };
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    const candidates = buildModelUrlCandidates(config.baseUrl);
    const errors = [];
    for (const url of candidates) {
      try {
        const data = await fetchJson(url, {
          method: "GET",
          headers,
        }, { track: false, timeoutMs: 20000 });
        return { models: normalizeModelList(data.data || data.models || [], config.provider), source: "remote", candidates };
      } catch (error) {
        errors.push(`${url}: ${error.message || String(error)}`);
      }
    }
    throw new Error(errors.join(" | "));
  } catch (error) {
    const fallback = modelFallbackForBaseUrl(config.baseUrl);
    if (fallback.length) {
      return {
        models: fallback,
        source: "fallback",
        candidates: buildModelUrlCandidates(config.baseUrl),
        warning: `模型列表接口不可用，已使用内置供应商模型列表。原始错误：${error.message || String(error)}`,
      };
    }
    throw error;
  }
}

function normalizeModelList(items, provider) {
  const seen = new Set();
  const models = [];
  for (const item of items) {
    const id = String(item.id || item.name || item.model || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      name: String(item.name || item.id || item.model || id),
      provider,
    });
  }
  models.sort((a, b) => a.id.localeCompare(b.id, "en"));
  return models;
}

function buildModelUrlCandidates(baseUrl) {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return [];
  const candidates = [];
  if (/\/v\d+$/i.test(trimmed)) {
    candidates.push(`${trimmed}/models`);
    if (!/\/v1$/i.test(trimmed)) candidates.push(`${trimmed}/v1/models`);
  } else {
    candidates.push(`${trimmed}/v1/models`);
  }
  return [...new Set(candidates)];
}

function modelFallbackForBaseUrl(baseUrl) {
  const value = String(baseUrl || "");
  const fallback = knownModelFallbacks.find((item) => item.pattern.test(value));
  return fallback ? fallback.models : [];
}

function stopProofread() {
  if (!status.running) return clientStatus({ includeResults: false });
  status.stopRequested = true;
  pushLog("收到终止请求，正在停止新的 AI 调用。");
  for (const controller of controllers) controller.abort();
  return clientStatus({ includeResults: false });
}

function clearProofreadCache() {
  if (status.running) {
    const error = new Error("AI 校对正在运行，请先停止任务再清除缓存。");
    error.code = "RUNNING";
    throw error;
  }
  status.stopRequested = false;
  status.runId = "";
  status.startedAt = null;
  status.finishedAt = null;
  status.projectKey = "";
  status.rowsSignature = "";
  status.monitorEnabled = false;
  status.total = 0;
  status.queued = 0;
  status.processed = 0;
  status.handled = 0;
  status.prefiltered = 0;
  status.rulePrefiltered = 0;
  status.similarityPrefiltered = 0;
  status.structuredConflicts = 0;
  status.skippedDone = 0;
  status.modelProcessed = 0;
  status.modelHandled = 0;
  status.suggested = 0;
  status.errors = 0;
  status.active = [];
  status.activeRequests = [];
  status.recentRequests = [];
  status.error = "";
  status.logs = [];
  status.results = new Map();
  status.resultChanges = [];
  status.resultRevision = 0;
  controllers = new Set();
  return clientStatus();
}

async function runQueue(queue, allRows, config, labels) {
  let next = 0;
  async function worker() {
    while (!status.stopRequested) {
      const offset = next;
      next += 1;
      if (offset >= queue.length) return;
      const row = queue[offset];
      status.active.push(row.index);
      try {
        const result = await proofreadRow(row, allRows, config, labels);
        addResult(result);
      } catch (error) {
        addResult({
          runId: status.runId,
          index: row.index,
          signature: rowSignature(row),
          status: status.stopRequested ? "stopped" : "error",
          done: false,
          note: `[AI校对]\n${status.stopRequested ? "校对已终止。" : `调用失败：${error.message || String(error)}`}`,
        });
      } finally {
        status.active = status.active.filter((index) => index !== row.index);
      }
    }
  }

  await Promise.all(Array.from({ length: config.concurrency }, worker));
  finish();
}

function finish() {
  if (!status.running) return;
  status.running = false;
  status.finishedAt = new Date().toISOString();
  if (status.stopRequested) {
    pushLog("AI 校对已终止。");
  } else {
    pushLog("AI 校对完成。");
  }
}

async function proofreadRow(row, allRows, config, labels) {
  const bilingual = config.proofreadMode === "bilingual";
  const targetKey = bilingual ? "cn" : config.target;
  const counterpartKey = bilingual ? "jp" : (targetKey === "cn" ? "tw" : "cn");
  const targetLabel = targetKey === "cn" ? (labels.cn || "非原文 B") : (labels.tw || "非原文 C");
  const counterpartLabel = counterpartKey === "jp"
    ? (labels.jp || "原文 A")
    : (counterpartKey === "cn" ? (labels.cn || "非原文 B") : (labels.tw || "非原文 C"));
  const targetText = textForKey(row, targetKey);
  const counterpartText = textForKey(row, counterpartKey);
  const diffHelper = bilingual
    ? "双语模式不生成跨语言词级差异；请依据原文 A 与译文 B 的语义对应判断。"
    : diffSummary(row.cn || "", row.twCn || row.tw || "", labels);
  const basePayload = {
    row,
    targetLabel,
    counterpartLabel,
    targetText,
    counterpartText,
    diffHelper,
    context: [],
    contextMode: "none",
  };
  const contextState = createContextState(row.index, allRows, targetKey, counterpartKey);
  let decision = null;
  for (let round = 0; round <= contextBudget.maxRounds; round += 1) {
    const hasContext = contextState.items.length > 0;
    const messages = buildMessages({
      ...basePayload,
      context: contextState.items,
      contextMode: hasContext ? "requested" : "none",
    }, config);
    const stage = round === 0 ? "base" : `context-${round}`;
    const stageLabel = round === 0 ? "当前行判断" : `扩展上下文 ${round}`;
    const content = await trackedCallModel(row, stage, stageLabel, messages, config);
    decision = parseDecision(content);
    if (!shouldRetryWithContext(decision)) break;
    if (round >= contextBudget.maxRounds) break;
    const added = expandContextRing(contextState);
    if (!added.length) break;
  }
  decision = ensureRevisedText(decision, targetKey, targetText, counterpartText, config.proofreadMode);
  return decisionToResult(row, decision, targetLabel, counterpartLabel);
}

async function trackedCallModel(row, stage, stageLabel, messages, config) {
  if (!config.monitorEnabled) {
    pushLog(`第 ${row.index} 行：${stageLabel}，等待模型返回。`);
    return callModel(messages, config);
  }
  const requestId = `${status.runId}:${row.index}:${stage}:${Date.now()}`;
  const startedAt = new Date().toISOString();
  const request = {
    id: requestId,
    rowIndex: row.index,
    stage,
    stageLabel,
    provider: config.provider,
    model: config.model,
    startedAt,
    state: "waiting",
    messages: summarizeMessages(messages),
  };
  status.activeRequests.push(request);
  pushLog(`第 ${row.index} 行：${stageLabel}，等待模型返回。`);
  try {
    const content = await callModel(messages, config);
    finishRequest(requestId, {
      state: "done",
      finishedAt: new Date().toISOString(),
      responsePreview: previewText(content),
    });
    return content;
  } catch (error) {
    finishRequest(requestId, {
      state: status.stopRequested ? "stopped" : "error",
      finishedAt: new Date().toISOString(),
      error: error.message || String(error),
    });
    throw error;
  }
}

function finishRequest(requestId, patch) {
  const index = status.activeRequests.findIndex((request) => request.id === requestId);
  if (index < 0) return;
  const [request] = status.activeRequests.splice(index, 1);
  const finished = {
    ...request,
    ...patch,
  };
  finished.elapsedMs = Math.max(0, Date.parse(finished.finishedAt || new Date()) - Date.parse(finished.startedAt || new Date()));
  status.recentRequests.unshift(finished);
  if (status.recentRequests.length > 8) {
    status.recentRequests.splice(8);
  }
}

function summarizeMessages(messages) {
  return messages.map((message) => ({
    role: message.role,
    content: previewText(message.content, 10000),
  }));
}

function previewText(value, maxLength = 1200) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...（已截断，完整内容已发送给模型）`;
}

function shouldRetryWithContext(decision) {
  return Boolean(decision.needsContext) || decision.better === "unclear";
}

function createContextState(rowIndex, rows, targetKey, counterpartKey) {
  const position = rows.findIndex((item) => Number(item.index) === Number(rowIndex));
  return {
    rowIndex,
    rows,
    position,
    targetKey,
    counterpartKey,
    included: new Set([String(rowIndex)]),
    items: [],
    radius: 0,
    chars: 0,
  };
}

function expandContextRing(state) {
  if (state.position < 0) return [];
  state.radius += 1;
  const candidates = [];
  const before = state.rows[state.position - state.radius];
  const after = state.rows[state.position + state.radius];
  if (before) candidates.push({ row: before, relative: -state.radius });
  if (after) candidates.push({ row: after, relative: state.radius });

  const added = [];
  for (const candidate of candidates) {
    if (state.items.length >= contextBudget.maxRows) break;
    const id = String(candidate.row.index);
    if (state.included.has(id)) continue;
    const item = contextRow(candidate.row, candidate.relative, state.targetKey, state.counterpartKey);
    const nextChars = state.chars + contextItemChars(item);
    if (nextChars > contextBudget.maxChars && added.length) break;
    state.included.add(id);
    state.items.push(item);
    state.chars = nextChars;
    added.push(item);
  }
  state.items.sort((a, b) => a.index - b.index);
  return added;
}

function contextRow(row, relative, targetKey, counterpartKey) {
  return {
    index: row.index,
    relative,
    position: relative < 0 ? `前 ${Math.abs(relative)} 行` : `后 ${relative} 行`,
    source: row.jp || "",
    target: textForKey(row, targetKey),
    counterpart: textForKey(row, counterpartKey),
  };
}

function textForKey(row, key) {
  if (key === "jp") return row.jp || "";
  if (key === "tw") return row.tw || "";
  return row.cn || "";
}

function contextItemChars(item) {
  return [item.source, item.target, item.counterpart]
    .reduce((sum, value) => sum + String(value || "").length, 0);
}

function ensureRevisedText(decision, targetKey, targetText, counterpartText, proofreadMode = "trilingual") {
  if (!decision.needsEdit || decision.better === "target" || decision.better === "unclear") return decision;
  if (decision.revisedText) return decision;

  const fallback = proofreadMode !== "bilingual" && decision.better === "counterpart"
    ? convertToTargetScript(counterpartText, targetKey)
    : "";
  return {
    ...decision,
    revisedText: fallback,
    summary: [decision.summary, fallback ? "模型未给出 revisedText，已使用另一版本转换为目标列字形作为完整修改结果。" : ""]
      .filter(Boolean)
      .join(" "),
  };
}

function convertToTargetScript(text, targetKey) {
  const value = String(text || "").trim();
  if (!value) return "";
  if (targetKey === "cn") return toCn(value);
  if (targetKey === "tw") return toTw(value);
  return value;
}

function diffSummary(fromText, toText, labels) {
  const parts = diffWordsWithSpace(fromText, toText);
  const changes = [];
  for (const part of parts) {
    const value = String(part.value || "").trim();
    if (!value) continue;
    if (part.removed) changes.push(`- ${value}`);
    if (part.added) changes.push(`+ ${value}`);
    if (changes.length >= 24) break;
  }
  const left = labels.cn || "非原文 B";
  const right = labels.tw || "非原文 C";
  return changes.length
    ? `${left} -> ${right}简体化\n${changes.join("\n")}`
    : "差异辅助未发现明显词级差异。";
}

function buildMessages(payload, config = {}) {
  const bilingualMode = config.proofreadMode === "bilingual";
  const user = {
    task: `${bilingualMode ? "双语版本校对" : "三语语境校对"}；校对目标列：${payload.targetLabel}`,
    comparisonMode: bilingualMode ? "bilingual" : "trilingual",
    modePolicy: bilingualMode
      ? "以原文 A 与译文 B 的语义对应为主要判断对象；只能修改 B，原文 A 用于确认语义边界、遗漏和误译。"
      : "同时参考原文、目标列和另一非原文列，判断目标列是否准确、通顺并符合原文语义；两份非原文仍是同级材料。",
    contextPolicy: payload.contextMode === "auto"
      ? "已提供自动补充的相邻上下文，请结合上下文给出最终判断。"
      : payload.contextMode === "requested"
        ? "已按固定策略补充当前行前后文。若仍不足，请返回 needsContext=true；若足够，请给出最终判断。"
        : "当前只提供目标行。若当前行不足以判断，请返回 needsContext=true；不要猜测，也不要为保险索要上下文。",
    contextBudget: {
      maxRounds: contextBudget.maxRounds,
      maxRows: contextBudget.maxRows,
      maxChars: contextBudget.maxChars,
    },
    outputSchema: proofreadPromptFor(bilingualMode ? "bilingual" : "trilingual").outputSchema,
    row: {
      index: payload.row.index,
      source: payload.row.jp || "",
      targetLabel: payload.targetLabel,
      targetText: payload.targetText || "",
      counterpartLabel: payload.counterpartLabel,
      counterpartText: payload.counterpartText || "",
      diffHelper: payload.diffHelper,
    },
    contextExpansion: {
      rounds: payload.context?.length ? Math.ceil(payload.context.length / 2) : 0,
      strategy: "每轮补充当前行前一行和后一行，最多 6 轮。",
    },
    nearbyRows: payload.context,
  };
  const modeSystem = bilingualMode
    ? "当前是双语校对：A 是原文，B 是唯一修改列。只能修改 B，并以 A 为语义依据；A 不是可直接复制进 B 的候选译文。需要修改时必须输出符合 B 语言和文体的完整 revisedText。"
    : "当前是三语校对：A 是原文，B、C 是同级非原文。只修改用户选择的目标列，并同时参考 A 与另一个非原文列。";
  return [
    { role: "system", content: `${config.systemPrompt || proofreadPromptFor(bilingualMode ? "bilingual" : "trilingual").system}\n${modeSystem}` },
    { role: "user", content: JSON.stringify(user, null, 2) },
  ];
}

async function callModel(messages, config) {
  return callOpenAiCompatible(messages, config);
}

async function callOpenAiCompatible(messages, config) {
  const headers = { "content-type": "application/json" };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  const data = await fetchJson(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0.1,
      stream: false,
    }),
  });
  return data.choices?.[0]?.message?.content || "";
}

async function fetchJson(url, options, fetchOptions = {}) {
  const controller = new AbortController();
  const track = fetchOptions.track !== false;
  if (track) controllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), fetchOptions.timeoutMs || 90000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timeout);
    if (track) controllers.delete(controller);
  }
}

function parseDecision(content) {
  const text = String(content || "").trim();
  const jsonText = text.startsWith("{") ? text : (text.match(/\{[\s\S]*\}/) || ["{}"])[0];
  const data = JSON.parse(jsonText);
  const summary = firstString(data.summary, data.analysis, data.reason, data.explanation, data["分析"], data["分析过程"]);
  const revisedText = firstString(
    data.revisedText,
    data.revision,
    data.result,
    data.modifiedText,
    data.correctedText,
    data.replacement,
    data["修改结果"],
    data["修改后文本"],
    data["完整修改结果"]
  );
  const semanticSame = parseBoolean(data.semanticSame, false);
  const better = normalizeBetter(data.better);
  const needsEdit = parseNeedsEdit(data.needsEdit, semanticSame, better);
  return normalizeDecision({
    semanticSame,
    needsEdit,
    needsContext: parseBoolean(data.needsContext, false),
    better,
    severity: normalizeSeverity(
      firstString(data.severity, data.issueSeverity, data["严重程度"], data["严重性"]),
      needsEdit,
    ),
    summary,
    suggestion: String(data.suggestion || "").trim(),
    replacement: String(data.replacement || "").trim(),
    revisedText,
  });
}

function firstString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (["true", "1", "yes", "y", "是", "需要", "相同"].includes(text)) return true;
  if (["false", "0", "no", "n", "否", "不需要", "不同"].includes(text)) return false;
  return fallback;
}

function normalizeBetter(value) {
  const text = String(value || "").trim().toLowerCase();
  if (["target", "目标", "目标列", "当前列", "本列", "原目标"].includes(text)) return "target";
  if (["counterpart", "other", "另一列", "对照列", "对方", "另一版本", "参考列"].includes(text)) return "counterpart";
  if (["neither", "none", "都不", "都不好", "两者都不", "均不"].includes(text)) return "neither";
  if (["unclear", "unknown", "不确定", "无法判断", "待确认"].includes(text)) return "unclear";
  return ["target", "counterpart", "neither", "unclear"].includes(text) ? text : "unclear";
}

function parseNeedsEdit(value, semanticSame, better) {
  if (value !== undefined && value !== null && String(value).trim() !== "") {
    return parseBoolean(value, false);
  }
  if (better === "counterpart" || better === "neither") return true;
  if (semanticSame || better === "target") return false;
  return false;
}

function normalizeSeverity(value, needsEdit = true) {
  if (!needsEdit) return "none";
  const text = String(value || "").trim().toLowerCase();
  if (["critical", "致命", "高", "high"].includes(text)) return "critical";
  if (["major", "严重", "重大", "主要", "中", "medium"].includes(text)) return "major";
  if (["minor", "轻微", "次要", "低", "low"].includes(text)) return "minor";
  return "major";
}

function normalizeDecision(decision) {
  const intent = summaryIntent(decision.summary);
  let next = { ...decision };
  if (intent === "no-edit" && next.needsEdit) {
    next = {
      ...next,
      needsEdit: false,
      better: next.semanticSame ? "neither" : "target",
      revisedText: "",
      suggestion: "",
    };
  } else if (intent === "edit" && !next.needsEdit) {
    next = {
      ...next,
      needsEdit: true,
      better: next.better === "target" ? "unclear" : next.better,
    };
  }
  if (!next.needsEdit && next.revisedText) {
    next = { ...next, revisedText: "" };
  }
  next.severity = next.needsEdit && !next.needsContext && next.better !== "unclear"
    ? normalizeSeverity(next.severity, true)
    : "none";
  return next;
}

function summaryIntent(summary) {
  const text = String(summary || "").replace(/\s+/g, "");
  if (!text) return "";
  if (/(无需|无须|不需|不需要|不用|不必)(修改|改写|修订|调整|优化)|无需改|不用改|保持目标列|目标列更(准确|自然|合适|好)|目标列已经/.test(text)) {
    return "no-edit";
  }
  if (/(需要|需|应|应该|建议)(修改|改写|修订|调整|优化|润色)|改为|修正为|以.+为基准|参考.+修订|进行局部优化|局部优化|作为修改结果|修改结果/.test(text)) {
    return "edit";
  }
  return "";
}

function decisionToResult(row, decision, targetLabel, counterpartLabel) {
  if (decision.needsContext || decision.better === "unclear") {
    return {
      runId: status.runId,
      index: row.index,
      signature: rowSignature(row),
      status: "suggestion",
      done: false,
      note: [
        "[AI校对]",
        `语义是否相同：${decision.semanticSame ? "相同" : "不同"}`,
        "是否需要修改：待人工确认",
        analysisLine(decision),
      ].filter(Boolean).join("\n"),
    };
  }

  if (!decision.needsEdit) {
    return {
      runId: status.runId,
      index: row.index,
      signature: rowSignature(row),
      status: decision.semanticSame ? "same" : "target-better",
      done: true,
      note: [
        "[AI校对]",
        `语义是否相同：${decision.semanticSame ? "相同" : "不同"}`,
        "是否需要修改：否",
        analysisLine(decision),
      ].filter(Boolean).join("\n"),
    };
  }

  const lines = ["[AI校对]"];
  lines.push(`语义是否相同：${decision.semanticSame ? "相同" : "不同"}`);
  if (decision.better === "counterpart") {
    lines.push("是否需要修改：是");
    lines.push(severityLine(decision));
    lines.push(analysisLine(decision, decision.revisedText ? "" : decision.suggestion || `参考${counterpartLabel}修订${targetLabel}。`));
    if (decision.revisedText) lines.push(`修改结果：${decision.revisedText}`);
  } else if (decision.better === "neither") {
    lines.push("是否需要修改：是");
    lines.push(severityLine(decision));
    lines.push(analysisLine(decision, decision.revisedText ? "" : decision.suggestion || "按原文重新整理译文。"));
    if (decision.revisedText) lines.push(`修改结果：${decision.revisedText}`);
  } else {
    lines.push("是否需要修改：待人工确认");
    lines.push(analysisLine(decision));
  }

  return {
    runId: status.runId,
    index: row.index,
    signature: rowSignature(row),
    status: "suggestion",
    done: false,
    note: lines.join("\n"),
  };
}

function severityLine(decision) {
  const labels = { minor: "轻微", major: "严重", critical: "致命" };
  return `严重程度：${labels[normalizeSeverity(decision.severity, true)] || "严重"}`;
}

function analysisLine(decision, fallback = "") {
  const text = [decision.summary, fallback].filter(Boolean).join(" ");
  return text ? `分析：${text}` : "";
}

module.exports = {
  buildMessages,
  clearProofreadCache,
  clientStatus,
  decisionToResult,
  listModels,
  normalizeSeverity,
  parseDecision,
  providerDefaults,
  proofreadPrompt,
  proofreadPromptFor,
  proofreadPrompts,
  startProofread,
  stopProofread,
};
