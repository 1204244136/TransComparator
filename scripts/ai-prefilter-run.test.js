const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-prefilter-"));
const previousDataDir = process.env.TRANSCOMPARATOR_DATA_DIR;
process.env.TRANSCOMPARATOR_DATA_DIR = dataDir;

const { clearProofreadCache, clientStatus, startPrefilter } = require("./ai-proofread");
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

function publishRows(rows, selection) {
  const project = createProjectContext(selection, rows);
  const staging = createProjectStaging(selection, { dataDir });
  fs.writeFileSync(
    path.join(staging.dir, "translation-compare.json"),
    JSON.stringify({ project, rowsSignature: project.rowsSignature, rows }),
    "utf8",
  );
  for (const name of projectArtifacts) {
    const file = path.join(staging.dir, name);
    if (fs.existsSync(file)) continue;
    fs.writeFileSync(file, name.endsWith(".json") ? "{}" : "", "utf8");
  }
  publishProject(staging.dir, { dataDir });
  return project;
}

test("startPrefilter marks rule-equivalent rows without a model or base URL", async () => {
  clearProofreadCache();
  const selection = {
    comparisonMode: "bilingual",
    inputMode: "txt",
    files: { jp: path.join(dataDir, "source.txt"), cn: path.join(dataDir, "translation.txt"), tw: "" },
    labels: { jp: "原文 A", cn: "非原文 B", tw: "非原文 C" },
  };
  const rows = Array.from({ length: 10 }, (_, offset) => {
    const text = "完全相同的规则预筛文本 " + (offset + 1);
    return { index: offset + 1, jp: text, cn: text, tw: "", twCn: "", score: 1 };
  });
  const project = publishRows(rows, selection);

  const started = await startPrefilter({
    similarityThreshold: 0.92,
    projectKey: project.projectKey,
    rowsSignature: project.rowsSignature,
  });
  assert.equal(started.kind, "prefilter");
  assert.equal(started.running, false);
  assert.equal(started.total, 10);
  assert.equal(started.rulePrefiltered, 10);
  assert.equal(started.prefiltered, 10);
  assert.equal(started.queued, 0);
  assert.equal(started.modelProcessed, 0);

  const full = clientStatus();
  assert.equal(full.kind, "prefilter");
  assert.equal(full.results.length, 10);
  const first = full.results[0];
  assert.match(first.note, /^\[规则预筛\]/);
  assert.equal(first.done, true);
});
