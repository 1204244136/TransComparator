const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-ai-status-"));
const previousDataDir = process.env.TRANSCOMPARATOR_DATA_DIR;
process.env.TRANSCOMPARATOR_DATA_DIR = dataDir;

const { clientStatus, startProofread } = require("./ai-proofread");
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
