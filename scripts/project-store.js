const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { projectSignature } = require("./project-context");
const { storageLayout } = require("./storage-layout");

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

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}-${crypto.randomBytes(5).toString("hex")}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    if (!fs.existsSync(file)) throw error;
    fs.rmSync(file, { force: true });
    fs.renameSync(temp, file);
  }
}

function renameDirectoryWithRetry(sourceDir, targetDir, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 8);
  const retryableCodes = new Set(["EBUSY", "EACCES", "EPERM"]);
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      fs.renameSync(sourceDir, targetDir);
      return;
    } catch (error) {
      if (!retryableCodes.has(error.code) || attempt === attempts) throw error;
      Atomics.wait(waitBuffer, 0, 0, 50 * attempt);
    }
  }
}

function safeProjectKey(value) {
  const key = String(value || "").trim();
  if (!key || !/^[a-z0-9_-]+$/i.test(key)) throw new Error("项目标识无效。");
  return key;
}

function safeSnapshotId(value) {
  const id = String(value || "").trim();
  if (!id || !/^[a-z0-9_-]+$/i.test(id)) throw new Error("项目快照标识无效。");
  return id;
}

function projectDirectory(layout, projectKey) {
  return path.join(layout.projectsDir, safeProjectKey(projectKey));
}

function snapshotsDirectory(layout, projectKey) {
  return path.join(projectDirectory(layout, projectKey), "snapshots");
}

function snapshotDirectory(layout, projectKey, snapshotId) {
  return path.join(snapshotsDirectory(layout, projectKey), safeSnapshotId(snapshotId));
}

function displayFiles(selection = {}) {
  const roles = selection.comparisonMode === "bilingual" ? ["jp", "cn"] : ["jp", "cn", "tw"];
  return Object.fromEntries(roles.map((role) => {
    const file = selection.files?.[role] || "";
    return [role, { name: path.basename(file), path: file }];
  }));
}

function projectName(files) {
  return Object.values(files).map((file) => file.name).filter(Boolean).join(" / ");
}

function readActivePointer(layout) {
  if (!fs.existsSync(layout.activeProjectFile)) return null;
  try {
    const pointer = readJson(layout.activeProjectFile);
    return {
      projectKey: safeProjectKey(pointer.projectKey),
      snapshotId: safeSnapshotId(pointer.snapshotId),
    };
  } catch {
    return null;
  }
}

function snapshotDescriptors(layout, projectKey) {
  const snapshotsDir = snapshotsDirectory(layout, projectKey);
  if (!fs.existsSync(snapshotsDir)) return [];
  return fs.readdirSync(snapshotsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const dir = path.join(snapshotsDir, entry.name);
      const manifestFile = path.join(dir, "project.json");
      try {
        const manifest = readJson(manifestFile);
        return [{ dir, manifest }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => String(b.manifest.generatedAt).localeCompare(String(a.manifest.generatedAt)));
}

function findSnapshot(layout, projectKey, options = {}) {
  const descriptors = snapshotDescriptors(layout, projectKey);
  if (options.snapshotId) {
    return descriptors.find(({ manifest }) => manifest.snapshotId === options.snapshotId) || null;
  }
  if (options.rowsSignature) {
    return descriptors.find(({ manifest }) => manifest.rowsSignature === options.rowsSignature) || null;
  }
  return descriptors[0] || null;
}

function publicProject(manifest, activePointer = null) {
  const active = Boolean(
    activePointer
    && activePointer.projectKey === manifest.id
    && activePointer.snapshotId === manifest.snapshotId
  );
  return {
    id: manifest.id,
    snapshotId: manifest.snapshotId,
    name: manifest.name,
    generatedAt: manifest.generatedAt,
    comparisonMode: manifest.comparisonMode,
    inputMode: manifest.inputMode,
    files: manifest.files,
    rowCount: manifest.rowCount,
    active,
    outputUrl: `/output/${manifest.id}/translation-compare.html`,
  };
}

function createProjectStaging(selection, options = {}) {
  const layout = storageLayout(options.dataDir);
  const projectKey = projectSignature(selection);
  const runId = `${projectKey}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
  const dir = path.join(layout.stagingDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "input-selection.json"), JSON.stringify(selection, null, 2), "utf8");
  return { dir, projectKey, runId };
}

function buildManifest(stagingDir) {
  const compare = readJson(path.join(stagingDir, "translation-compare.json"));
  const selection = readJson(path.join(stagingDir, "input-selection.json"));
  const projectKey = safeProjectKey(compare.project?.projectKey);
  const files = displayFiles(selection);
  const generatedAt = compare.project?.generatedAt || new Date().toISOString();
  const timestamp = generatedAt.replace(/\D/g, "").slice(0, 17) || String(Date.now());
  const signature = String(compare.project?.rowsSignature || compare.rowsSignature || "rows").replace(/[^a-z0-9_-]/gi, "");
  const snapshotId = safeSnapshotId(`${timestamp}-${signature || "rows"}-${crypto.randomBytes(3).toString("hex")}`);
  return {
    schemaVersion: 2,
    id: projectKey,
    snapshotId,
    rowsSignature: compare.project?.rowsSignature || compare.rowsSignature || "",
    name: projectName(files) || projectKey,
    generatedAt,
    comparisonMode: selection.comparisonMode || compare.project?.comparisonMode || "trilingual",
    inputMode: selection.inputMode || compare.project?.inputMode || "",
    files,
    rowCount: Array.isArray(compare.rows) ? compare.rows.length : 0,
  };
}

function publishProject(stagingDir, options = {}) {
  const layout = storageLayout(options.dataDir);
  const sourceDir = path.resolve(stagingDir);
  const missing = projectArtifacts.filter((name) => !fs.existsSync(path.join(sourceDir, name)));
  if (missing.length) throw new Error(`待发布项目缺少文件：${missing.join("、")}`);

  const manifest = buildManifest(sourceDir);
  fs.writeFileSync(path.join(sourceDir, "project.json"), JSON.stringify(manifest, null, 2), "utf8");
  const targetDir = snapshotDirectory(layout, manifest.id, manifest.snapshotId);
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  renameDirectoryWithRetry(sourceDir, targetDir);
  writeJsonAtomic(layout.activeProjectFile, {
    schemaVersion: 1,
    projectKey: manifest.id,
    snapshotId: manifest.snapshotId,
    updatedAt: new Date().toISOString(),
  });
  pruneProjectSnapshots(manifest.id, { dataDir: layout.root, keep: 2 });
  return publicProject(manifest, readActivePointer(layout));
}

function pruneProjectSnapshots(projectKey, options = {}) {
  const layout = storageLayout(options.dataDir);
  const keep = Math.max(1, Number(options.keep) || 2);
  const active = readActivePointer(layout);
  const descriptors = snapshotDescriptors(layout, projectKey);
  const retained = new Set(descriptors.slice(0, keep).map(({ manifest }) => manifest.snapshotId));
  if (active?.projectKey === projectKey) retained.add(active.snapshotId);
  for (const { dir, manifest } of descriptors) {
    if (!retained.has(manifest.snapshotId)) fs.rmSync(dir, { recursive: true, force: true });
  }
}

function listProjects(options = {}) {
  const layout = storageLayout(options.dataDir);
  const activePointer = readActivePointer(layout);
  if (!fs.existsSync(layout.projectsDir)) {
    return { activeProjectKey: activePointer?.projectKey || "", projects: [] };
  }
  const projects = fs.readdirSync(layout.projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const descriptor = findSnapshot(layout, entry.name);
      return descriptor ? [publicProject(descriptor.manifest, activePointer)] : [];
    })
    .sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
  return { activeProjectKey: activePointer?.projectKey || "", projects };
}

function activateProject(projectKey, options = {}) {
  const layout = storageLayout(options.dataDir);
  const key = safeProjectKey(projectKey);
  const descriptor = findSnapshot(layout, key);
  if (!descriptor) throw new Error("项目不存在或快照不完整。");
  writeJsonAtomic(layout.activeProjectFile, {
    schemaVersion: 1,
    projectKey: key,
    snapshotId: descriptor.manifest.snapshotId,
    updatedAt: new Date().toISOString(),
  });
  return publicProject(descriptor.manifest, readActivePointer(layout));
}

function getActiveProject(options = {}) {
  const layout = storageLayout(options.dataDir);
  const pointer = readActivePointer(layout);
  if (!pointer) return null;
  const descriptor = findSnapshot(layout, pointer.projectKey, { snapshotId: pointer.snapshotId });
  return descriptor ? publicProject(descriptor.manifest, pointer) : null;
}

function resolveProjectArtifact(projectKey, artifactName, options = {}) {
  if (!projectArtifacts.includes(artifactName)) throw new Error("项目文件类型无效。");
  const layout = storageLayout(options.dataDir);
  const descriptor = findSnapshot(layout, safeProjectKey(projectKey), options);
  if (!descriptor) throw new Error("项目不存在或对应快照已不可用。");
  const file = path.join(descriptor.dir, artifactName);
  if (!fs.existsSync(file)) throw new Error(`项目快照缺少文件：${artifactName}`);
  return file;
}

function readProjectSelection(projectKey, options = {}) {
  return readJson(resolveProjectArtifact(projectKey, "input-selection.json", options));
}

function discardStaging(stagingDir, options = {}) {
  if (!stagingDir) return;
  const layout = storageLayout(options.dataDir);
  const resolved = path.resolve(stagingDir);
  const stagingRoot = `${path.resolve(layout.stagingDir)}${path.sep}`;
  if (!resolved.startsWith(stagingRoot)) throw new Error("拒绝清理 staging 目录之外的路径。");
  fs.rmSync(resolved, { recursive: true, force: true });
}

module.exports = {
  activateProject,
  createProjectStaging,
  discardStaging,
  getActiveProject,
  listProjects,
  projectArtifacts,
  publishProject,
  readProjectSelection,
  resolveProjectArtifact,
  safeProjectKey,
};
