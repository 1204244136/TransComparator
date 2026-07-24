const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..");
const defaultOutputDir = path.join(rootDir, "out");
const projectArtifacts = [
  "paragraphs.json",
  "jp-align.json",
  "translation-compare.html",
  "translation-compare.csv",
  "translation-compare.json",
  "input-selection.json",
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function safeProjectKey(value) {
  const key = String(value || "").trim();
  if (!key || !/^[a-z0-9_-]+$/i.test(key)) {
    throw new Error("项目标识无效。");
  }
  return key;
}

function projectDirectory(outputDir, projectKey) {
  return path.join(outputDir, "projects", safeProjectKey(projectKey));
}

function displayFiles(selection = {}) {
  const roles = selection.comparisonMode === "bilingual" ? ["jp", "cn"] : ["jp", "cn", "tw"];
  return Object.fromEntries(roles.map((role) => {
    const file = selection.files?.[role] || "";
    return [role, { name: path.basename(file), path: file }];
  }));
}

function projectName(files) {
  return Object.values(files)
    .map((file) => file.name)
    .filter(Boolean)
    .join(" / ");
}

function publicProject(manifest, activeProjectKey = "") {
  return {
    id: manifest.id,
    name: manifest.name,
    generatedAt: manifest.generatedAt,
    comparisonMode: manifest.comparisonMode,
    inputMode: manifest.inputMode,
    files: manifest.files,
    rowCount: manifest.rowCount,
    active: manifest.id === activeProjectKey,
    outputUrl: manifest.id === activeProjectKey ? "/output/translation-compare.html" : "",
  };
}

function currentProjectKey(outputDir) {
  const compareJsonFile = path.join(outputDir, "translation-compare.json");
  if (!fs.existsSync(compareJsonFile)) return "";
  try {
    return String(readJson(compareJsonFile).project?.projectKey || "");
  } catch {
    return "";
  }
}

function archiveCurrentProject(options = {}) {
  const outputDir = options.outputDir || defaultOutputDir;
  const compareJsonFile = path.join(outputDir, "translation-compare.json");
  const selectionFile = path.join(outputDir, "input-selection.json");
  if (!fs.existsSync(compareJsonFile) || !fs.existsSync(selectionFile)) return null;

  const compare = readJson(compareJsonFile);
  const selection = readJson(selectionFile);
  const projectKey = safeProjectKey(compare.project?.projectKey);
  const missing = projectArtifacts.filter((name) => !fs.existsSync(path.join(outputDir, name)));
  if (missing.length) {
    throw new Error(`当前工作台缺少项目文件：${missing.join("、")}`);
  }

  const targetDir = projectDirectory(outputDir, projectKey);
  fs.mkdirSync(targetDir, { recursive: true });
  for (const name of projectArtifacts) {
    fs.copyFileSync(path.join(outputDir, name), path.join(targetDir, name));
  }

  const files = displayFiles(selection);
  const manifest = {
    schemaVersion: 1,
    id: projectKey,
    name: projectName(files) || projectKey,
    generatedAt: compare.project?.generatedAt || new Date().toISOString(),
    comparisonMode: selection.comparisonMode || compare.project?.comparisonMode || "trilingual",
    inputMode: selection.inputMode || compare.project?.inputMode || "",
    files,
    rowCount: Array.isArray(compare.rows) ? compare.rows.length : 0,
  };
  fs.writeFileSync(path.join(targetDir, "project.json"), JSON.stringify(manifest, null, 2), "utf8");
  return publicProject(manifest, projectKey);
}

function adoptCurrentProject(outputDir) {
  const compareJsonFile = path.join(outputDir, "translation-compare.json");
  if (!fs.existsSync(compareJsonFile)) return;
  const compare = readJson(compareJsonFile);
  const projectKey = compare.project?.projectKey;
  if (!projectKey) return;
  const manifestFile = path.join(projectDirectory(outputDir, projectKey), "project.json");
  if (!fs.existsSync(manifestFile)) {
    archiveCurrentProject({ outputDir });
    return;
  }
  const manifest = readJson(manifestFile);
  if (manifest.generatedAt !== compare.project?.generatedAt) {
    archiveCurrentProject({ outputDir });
  }
}

function listProjects(options = {}) {
  const outputDir = options.outputDir || defaultOutputDir;
  if (options.adoptCurrent !== false) {
    try {
      adoptCurrentProject(outputDir);
    } catch {
      // A partial or legacy output should not make the console unavailable.
    }
  }
  const projectsDir = path.join(outputDir, "projects");
  const activeProjectKey = currentProjectKey(outputDir);
  if (!fs.existsSync(projectsDir)) return { activeProjectKey, projects: [] };

  const projects = fs.readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(projectsDir, entry.name, "project.json"))
    .filter((file) => fs.existsSync(file))
    .flatMap((file) => {
      try {
        return [publicProject(readJson(file), activeProjectKey)];
      } catch {
        return [];
      }
    })
    .sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
  return { activeProjectKey, projects };
}

function activateProject(projectKey, options = {}) {
  const outputDir = options.outputDir || defaultOutputDir;
  const key = safeProjectKey(projectKey);
  const sourceDir = projectDirectory(outputDir, key);
  const manifestFile = path.join(sourceDir, "project.json");
  if (!fs.existsSync(manifestFile)) throw new Error("项目不存在或快照不完整。");

  const missing = projectArtifacts.filter((name) => !fs.existsSync(path.join(sourceDir, name)));
  if (missing.length) throw new Error(`项目快照缺少文件：${missing.join("、")}`);
  fs.mkdirSync(outputDir, { recursive: true });
  for (const name of projectArtifacts) {
    fs.copyFileSync(path.join(sourceDir, name), path.join(outputDir, name));
  }

  return publicProject(readJson(manifestFile), key);
}

module.exports = {
  activateProject,
  archiveCurrentProject,
  listProjects,
  projectArtifacts,
  safeProjectKey,
};
