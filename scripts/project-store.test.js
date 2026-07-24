const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  activateProject,
  createProjectStaging,
  getActiveProject,
  listProjects,
  projectArtifacts,
  publishProject,
  resolveProjectArtifact,
} = require("./project-store");

function selection(dataDir, sourceName) {
  return {
    comparisonMode: "bilingual",
    inputMode: "txt",
    files: {
      jp: path.join(dataDir, `${sourceName}-source.txt`),
      cn: path.join(dataDir, `${sourceName}-translation.txt`),
      tw: "",
    },
    labels: { jp: "原文", cn: "译文", tw: "版本 C" },
  };
}

function prepareStaging(dataDir, sourceName, generatedAt) {
  const selected = selection(dataDir, sourceName);
  const staging = createProjectStaging(selected, { dataDir });
  const rowsSignature = `${sourceName}-rows`;
  fs.writeFileSync(path.join(staging.dir, "translation-compare.json"), JSON.stringify({
    project: {
      projectKey: staging.projectKey,
      generatedAt,
      rowsSignature,
      comparisonMode: "bilingual",
    },
    rowsSignature,
    rows: [{ index: 1, jp: sourceName }],
  }), "utf8");
  for (const name of projectArtifacts) {
    const file = path.join(staging.dir, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, `${sourceName}:${name}`, "utf8");
  }
  return staging;
}

test("publishes immutable snapshots and switches projects by pointer", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-projects-"));
  try {
    const first = publishProject(
      prepareStaging(dataDir, "first", "2026-07-20T10:00:00.000Z").dir,
      { dataDir },
    );
    const second = publishProject(
      prepareStaging(dataDir, "second", "2026-07-21T10:00:00.000Z").dir,
      { dataDir },
    );

    assert.equal(getActiveProject({ dataDir }).id, second.id);
    assert.equal(fs.existsSync(path.join(dataDir, "translation-compare.html")), false);
    assert.equal(fs.existsSync(resolveProjectArtifact(first.id, "translation-compare.html", { dataDir })), true);
    assert.deepEqual(listProjects({ dataDir }).projects.map((project) => project.id), [second.id, first.id]);

    const activated = activateProject(first.id, { dataDir });
    assert.equal(activated.active, true);
    assert.equal(getActiveProject({ dataDir }).id, first.id);
    assert.equal(fs.existsSync(path.join(dataDir, "paragraphs.json")), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("failed publication leaves the previously published project intact", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-projects-"));
  try {
    const published = publishProject(
      prepareStaging(dataDir, "stable", "2026-07-20T10:00:00.000Z").dir,
      { dataDir },
    );
    const incomplete = createProjectStaging(selection(dataDir, "broken"), { dataDir });
    assert.throws(() => publishProject(incomplete.dir, { dataDir }), /待发布项目缺少文件/);
    assert.equal(getActiveProject({ dataDir }).id, published.id);
    assert.equal(fs.existsSync(incomplete.dir), true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("retains only two latest snapshots for the same project", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-projects-"));
  try {
    const generated = ["20", "21", "22"].map((day) => publishProject(
      prepareStaging(dataDir, "same", `2026-07-${day}T10:00:00.000Z`).dir,
      { dataDir },
    ));
    const snapshotsDir = path.join(dataDir, "projects", generated[0].id, "snapshots");
    assert.equal(fs.readdirSync(snapshotsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length, 2);
    assert.equal(getActiveProject({ dataDir }).snapshotId, generated.at(-1).snapshotId);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("rejects project keys that can escape the project directory", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-projects-"));
  try {
    assert.throws(() => activateProject("../outside", { dataDir }), /项目标识无效/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
