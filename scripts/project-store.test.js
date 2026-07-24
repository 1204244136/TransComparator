const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  activateProject,
  archiveCurrentProject,
  listProjects,
  projectArtifacts,
} = require("./project-store");

function writeWorkspace(outputDir, id, generatedAt, sourceName) {
  fs.mkdirSync(outputDir, { recursive: true });
  const selection = {
    comparisonMode: "bilingual",
    inputMode: "txt",
    files: {
      jp: path.join(outputDir, sourceName),
      cn: path.join(outputDir, `${id}-translation.txt`),
      tw: "",
    },
  };
  fs.writeFileSync(path.join(outputDir, "input-selection.json"), JSON.stringify(selection), "utf8");
  fs.writeFileSync(path.join(outputDir, "translation-compare.json"), JSON.stringify({
    project: { projectKey: id, generatedAt, comparisonMode: "bilingual" },
    rows: [{ index: 1, jp: id }],
  }), "utf8");
  for (const name of projectArtifacts) {
    const file = path.join(outputDir, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, `${id}:${name}`, "utf8");
  }
}

test("archives generated workbenches and restores the selected project", () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-projects-"));
  try {
    writeWorkspace(outputDir, "first", "2026-07-20T10:00:00.000Z", "first-source.txt");
    const first = archiveCurrentProject({ outputDir });
    assert.equal(first.id, "first");
    assert.equal(first.active, true);
    assert.match(first.name, /first-source\.txt/);

    writeWorkspace(outputDir, "second", "2026-07-21T10:00:00.000Z", "second-source.txt");
    fs.writeFileSync(path.join(outputDir, "translation-compare.html"), "second workbench", "utf8");
    archiveCurrentProject({ outputDir });

    const listed = listProjects({ outputDir, adoptCurrent: false });
    assert.equal(listed.activeProjectKey, "second");
    assert.deepEqual(listed.projects.map((project) => project.id), ["second", "first"]);

    const activated = activateProject("first", { outputDir });
    assert.equal(activated.id, "first");
    assert.equal(activated.active, true);
    assert.equal(readProjectKey(outputDir), "first");
    assert.notEqual(fs.readFileSync(path.join(outputDir, "translation-compare.html"), "utf8"), "second workbench");
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test("rejects project keys that can escape the project directory", () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-projects-"));
  try {
    assert.throws(() => activateProject("../outside", { outputDir }), /项目标识无效/);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

function readProjectKey(outputDir) {
  return JSON.parse(fs.readFileSync(path.join(outputDir, "translation-compare.json"), "utf8")).project.projectKey;
}
