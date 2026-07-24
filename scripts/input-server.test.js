const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { saveUploadedInput } = require("./input-server");

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
