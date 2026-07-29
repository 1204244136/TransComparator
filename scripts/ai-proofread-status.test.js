const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-ai-status-"));
const previousDataDir = process.env.TRANSCOMPARATOR_DATA_DIR;
process.env.TRANSCOMPARATOR_DATA_DIR = dataDir;

const { clearProofreadCache, clientStatus, startProofread } = require("./ai-proofread");
const { createProjectContext } = require("./project-context");
const {
  createProjectStaging,
  projectArtifacts,
  publishProject,
} = require("./project-store");

test.after(() => {
  if (previousDataDir === undefined) delete process.env.TRANSCOMPARATOR_DATA_DIR;
  else process.env.TRANSCOMPARATOR_DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("AI results are consumed through a bounded revision cursor without gaps", async () => {
  const selection = {
    comparisonMode: "bilingual",
    inputMode: "txt",
    files: {
      jp: path.join(dataDir, "source.txt"),
      cn: path.join(dataDir, "translation.txt"),
      tw: "",
    },
    labels: { jp: "原文 A", cn: "非原文 B", tw: "非原文 C" },
  };
  const rows = Array.from({ length: 150 }, (_, offset) => {
    const text = "相同的规则预筛文本 " + (offset + 1);
    return { index: offset + 1, jp: text, cn: text, tw: "", twCn: "", score: 1 };
  });
  const project = createProjectContext(selection, rows);
  const staging = createProjectStaging(selection, { dataDir });
  fs.writeFileSync(path.join(staging.dir, "translation-compare.json"), JSON.stringify({
    project,
    rowsSignature: project.rowsSignature,
    rows,
  }), "utf8");
  for (const name of projectArtifacts) {
    const file = path.join(staging.dir, name);
    if (fs.existsSync(file)) continue;
    fs.writeFileSync(file, name.endsWith(".json") ? "{}" : "", "utf8");
  }
  publishProject(staging.dir, { dataDir });

  const started = await startProofread({
    provider: "compatible",
    baseUrl: "http://127.0.0.1:1",
    model: "unused",
    proofreadMode: "bilingual",
    projectKey: project.projectKey,
    rowsSignature: project.rowsSignature,
  });
  assert.deepEqual(started.results, []);
  assert.equal(started.resultRevision, 0);
  assert.equal(started.latestResultRevision, 150);
  assert.equal(started.hasMoreResults, true);

  const pages = [];
  let cursor = 0;
  do {
    const page = clientStatus({
      runId: started.runId,
      afterRevision: cursor,
      resultLimit: 64,
      includeLogs: false,
    });
    pages.push(page);
    cursor = page.resultRevision;
  } while (pages.at(-1).hasMoreResults);

  assert.deepEqual(pages.map((page) => page.results.length), [64, 64, 22]);
  assert.equal(cursor, 150);
  assert.deepEqual(
    pages.flatMap((page) => page.results.map((result) => result.resultRevision)),
    Array.from({ length: 150 }, (_, offset) => offset + 1),
  );
  const full = clientStatus();
  assert.equal(full.results.length, 150);
  assert.equal(full.resultRevision, 150);
  assert.equal(full.hasMoreResults, false);
});

test("AI queue stops after a fatal authentication response", async () => {
  clearProofreadCache();
  const selection = {
    comparisonMode: "bilingual",
    inputMode: "txt",
    files: {
      jp: path.join(dataDir, "fatal-source.txt"),
      cn: path.join(dataDir, "fatal-translation.txt"),
      tw: "",
    },
    labels: { jp: "原文 A", cn: "非原文 B", tw: "非原文 C" },
  };
  const rows = Array.from({ length: 20 }, (_, offset) => ({
    index: offset + 1,
    jp: `source paragraph ${offset + 1} with unique content`,
    cn: `完全不同的译文段落 ${offset + 1}，需要模型判断`,
    tw: "",
    twCn: "",
    score: 0,
  }));
  const project = createProjectContext(selection, rows);
  const staging = createProjectStaging(selection, { dataDir });
  fs.writeFileSync(path.join(staging.dir, "translation-compare.json"), JSON.stringify({
    project,
    rowsSignature: project.rowsSignature,
    rows,
  }), "utf8");
  for (const name of projectArtifacts) {
    const file = path.join(staging.dir, name);
    if (fs.existsSync(file)) continue;
    fs.writeFileSync(file, name.endsWith(".json") ? "{}" : "", "utf8");
  }
  publishProject(staging.dir, { dataDir });

  let requestCount = 0;
  const server = http.createServer((request, response) => {
    requestCount += 1;
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "USER_INACTIVE", message: "User account is not active" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    await startProofread({
      provider: "compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "test-model",
      proofreadMode: "bilingual",
      concurrency: 4,
      projectKey: project.projectKey,
      rowsSignature: project.rowsSignature,
    });

    const deadline = Date.now() + 3000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const finished = clientStatus();
    assert.equal(finished.running, false);
    assert.equal(finished.stopRequested, true);
    assert.equal(finished.errors, 1);
    assert.match(finished.error, /HTTP 401.*USER_INACTIVE/);
    assert.equal(requestCount <= 4, true);
    assert.equal(finished.processed <= 4, true);
    assert.match(finished.results.find((result) => result.status === "error").note, /User account is not active/);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
});

test("AI queue stops after the endpoint returns an HTML page instead of JSON", async () => {
  clearProofreadCache();
  const selection = {
    comparisonMode: "bilingual",
    inputMode: "txt",
    files: {
      jp: path.join(dataDir, "html-source.txt"),
      cn: path.join(dataDir, "html-translation.txt"),
      tw: "",
    },
    labels: { jp: "原文 A", cn: "非原文 B", tw: "非原文 C" },
  };
  const rows = Array.from({ length: 20 }, (_, offset) => ({
    index: offset + 1,
    jp: `source paragraph ${offset + 1} with unique content`,
    cn: `需要模型判断的译文段落 ${offset + 1}`,
    tw: "",
    twCn: "",
    score: 0,
  }));
  const project = createProjectContext(selection, rows);
  const staging = createProjectStaging(selection, { dataDir });
  fs.writeFileSync(path.join(staging.dir, "translation-compare.json"), JSON.stringify({
    project,
    rowsSignature: project.rowsSignature,
    rows,
  }), "utf8");
  for (const name of projectArtifacts) {
    const file = path.join(staging.dir, name);
    if (fs.existsSync(file)) continue;
    fs.writeFileSync(file, name.endsWith(".json") ? "{}" : "", "utf8");
  }
  publishProject(staging.dir, { dataDir });

  let requestCount = 0;
  const server = http.createServer((request, response) => {
    requestCount += 1;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>API home</title>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    await startProofread({
      provider: "compatible",
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: "test-model",
      proofreadMode: "bilingual",
      concurrency: 4,
      projectKey: project.projectKey,
      rowsSignature: project.rowsSignature,
    });

    const deadline = Date.now() + 3000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const finished = clientStatus();
    assert.equal(finished.running, false);
    assert.equal(finished.stopRequested, true);
    assert.equal(finished.errors, 1);
    assert.match(finished.error, /配置或响应异常.*非 JSON 响应.*text\/html/);
    assert.equal(requestCount <= 4, true);
    assert.equal(finished.processed <= 4, true);
    assert.match(finished.results.find((result) => result.status === "error").note, /\/v1\/chat\/completions.*非 JSON 响应/);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
});

test("AI queue trips when the recent error rate reaches the circuit-breaker threshold", async () => {
  clearProofreadCache();
  const selection = {
    comparisonMode: "bilingual",
    inputMode: "txt",
    files: {
      jp: path.join(dataDir, "circuit-source.txt"),
      cn: path.join(dataDir, "circuit-translation.txt"),
      tw: "",
    },
    labels: { jp: "原文 A", cn: "非原文 B", tw: "非原文 C" },
  };
  const rows = Array.from({ length: 60 }, (_, offset) => ({
    index: offset + 1,
    jp: `source paragraph ${offset + 1} with unique content`,
    cn: `需要模型判断的不同译文段落 ${offset + 1}`,
    tw: "",
    twCn: "",
    score: 0,
  }));
  const project = createProjectContext(selection, rows);
  const staging = createProjectStaging(selection, { dataDir });
  fs.writeFileSync(path.join(staging.dir, "translation-compare.json"), JSON.stringify({
    project,
    rowsSignature: project.rowsSignature,
    rows,
  }), "utf8");
  for (const name of projectArtifacts) {
    const file = path.join(staging.dir, name);
    if (fs.existsSync(file)) continue;
    fs.writeFileSync(file, name.endsWith(".json") ? "{}" : "", "utf8");
  }
  publishProject(staging.dir, { dataDir });

  let requestCount = 0;
  const successfulDecision = JSON.stringify({
    semanticSame: true,
    needsEdit: false,
    needsContext: false,
    better: "target",
    summary: "译文准确。",
  });
  const server = http.createServer((request, response) => {
    requestCount += 1;
    response.setHeader("content-type", "application/json");
    if (requestCount % 2 === 1) {
      response.statusCode = 500;
      response.end(JSON.stringify({ message: "temporary upstream failure" }));
      return;
    }
    response.end(JSON.stringify({ choices: [{ message: { content: successfulDecision } }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    await startProofread({
      provider: "compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "test-model",
      proofreadMode: "bilingual",
      concurrency: 2,
      projectKey: project.projectKey,
      rowsSignature: project.rowsSignature,
    });

    const deadline = Date.now() + 3000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const finished = clientStatus();
    assert.equal(finished.running, false);
    assert.equal(finished.stopRequested, true);
    assert.equal(finished.errors, 5);
    assert.match(finished.error, /错误率熔断：最近 10 次处理中有 5 次失败（50%）/);
    assert.equal(requestCount <= 12, true);
    assert.equal(finished.processed < rows.length, true);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
});
