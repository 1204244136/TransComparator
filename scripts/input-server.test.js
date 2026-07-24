const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  createServer,
  host,
  mapCommandProgress,
  parseProgressMessage,
  saveUploadedInput,
} = require("./input-server");

function uploadPayload(role, name, text, comparisonMode = "bilingual") {
  return {
    role,
    comparisonMode,
    file: {
      name,
      type: "text/plain",
      data: Buffer.from(text, "utf8").toString("base64"),
    },
  };
}

test("role upload stores a supported file in the local import workspace", () => {
  const result = saveUploadedInput(uploadPayload("jp", "source.txt", "source paragraph"));
  try {
    assert.equal(result.comparisonMode, "bilingual");
    assert.equal(result.file.name, "source.txt");
    assert.equal(result.file.ext, "txt");
    assert.equal(fs.readFileSync(result.file.path, "utf8"), "source paragraph");
  } finally {
    fs.rmSync(path.dirname(result.file.path), { recursive: true, force: true });
  }
});

test("bilingual upload rejects a third role", () => {
  assert.throws(
    () => saveUploadedInput(uploadPayload("tw", "third.txt", "third")),
    /双语模式不接受非原文 C 文件/,
  );
});

test("role upload rejects unsupported extensions", () => {
  assert.throws(
    () => saveUploadedInput(uploadPayload("jp", "source.exe", "not text")),
    /不支持的文件类型/,
  );
});

test("machine progress messages are parsed and clamped", () => {
  const message = parseProgressMessage(
    '@@transcomparator-progress@@{"percent":125,"label":"编码原文向量","current":256,"total":1000}',
  );
  assert.deepEqual(message, {
    percent: 100,
    label: "编码原文向量",
    current: 256,
    total: 1000,
  });
  assert.equal(parseProgressMessage("ordinary command output"), null);
  assert.equal(parseProgressMessage("@@transcomparator-progress@@not-json"), null);
});

test("command progress maps local work into its global pipeline range", () => {
  assert.deepEqual(
    mapCommandProgress({ percent: 50, label: "编码原文向量", current: 512, total: 1024 }, "align:jp", { start: 2, end: 84 }),
    {
      current: 512,
      total: 1024,
      percent: 43,
      step: "align:jp",
      detail: "编码原文向量",
    },
  );
});

test("status exposes the project API version and completed project slot", async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  try {
    const address = server.address();
    const response = await fetch(`http://${host}:${address.port}/api/status`);
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.apiVersion, 2);
    assert.ok(Array.isArray(data.projects));
    assert.ok(Object.hasOwn(data.pipeline, "completedProject"));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
