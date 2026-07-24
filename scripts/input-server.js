const fs = require("fs");
const { spawn } = require("child_process");
const crypto = require("crypto");
const http = require("http");
const path = require("path");
const { StringDecoder } = require("string_decoder");
const { URL } = require("url");
const {
  guessLangOrder,
  inferInputMode,
  normalizeComparisonMode,
  normalizePath,
  saveSelection,
  selectionFile,
  defaultDisplayLabels,
  defaultInlineMarkup,
  isSupportedInput,
  supportedFilesInDirectory,
  validateSelection,
} = require("./input-selection");
const {
  clearProofreadCache,
  clientStatus: aiProofreadStatus,
  listModels,
  startProofread,
  stopProofread,
} = require("./ai-proofread");

const rootDir = path.join(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const defaultPort = Number(process.env.TRANSCOMPARATOR_SETUP_PORT || 4317);
const host = "127.0.0.1";
const compareHtmlFile = path.join(rootDir, "out", "translation-compare.html");
const importedInputsDir = path.join(rootDir, "out", "imported-inputs");
const maxUploadBytes = 80 * 1024 * 1024;

function resolveNpmCommand() {
  if (process.env.TRANSCOMPARATOR_NPM_CMD) return process.env.TRANSCOMPARATOR_NPM_CMD;
  if (process.platform !== "win32") return "npm";
  const candidates = [
    "C:\\PROGRA~1\\nodejs\\npm.cmd",
    "C:\\PROGRA~2\\nodejs\\npm.cmd",
    path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "npm.cmd"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "nodejs", "npm.cmd"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "npm.cmd";
}

const npmCommand = resolveNpmCommand();

const pipeline = {
  running: false,
  step: "idle",
  progress: { current: 0, total: 2, percent: 0, step: "idle" },
  code: null,
  error: "",
  startedAt: null,
  finishedAt: null,
  logs: [],
};

function pushLog(line) {
  const text = String(line || "").replace(/\r\n?/g, "\n");
  for (const part of text.split("\n")) {
    if (!part) continue;
    pipeline.logs.push(part);
  }
  if (pipeline.logs.length > 500) {
    pipeline.logs.splice(0, pipeline.logs.length - 500);
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendError(res, status, error) {
  sendJson(res, status, { ok: false, error: error.message || String(error) });
}

function readJson(req, maxBytes = 128 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    req.on("data", (chunk) => {
      chunks.push(chunk);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(new Error("Request body is not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function filePayload(file) {
  const stat = fs.statSync(file);
  return {
    path: file,
    name: path.basename(file),
    ext: path.extname(file).slice(1).toLowerCase(),
    size: stat.size,
  };
}

function sanitizeUploadedFilename(name) {
  const basename = path.basename(String(name || "").replace(/\\/g, "/"));
  return basename.replace(/[<>:"|?*\u0000-\u001f]/g, "_").trim();
}

function saveUploadedInput(payload) {
  const role = ["jp", "cn", "tw"].includes(payload?.role) ? payload.role : "";
  const mode = normalizeComparisonMode(payload?.comparisonMode);
  if (!role) throw new Error("上传文件缺少有效角色。");
  if (mode === "bilingual" && role === "tw") throw new Error("双语模式不接受非原文 C 文件。");

  const uploaded = payload?.file || {};
  const name = sanitizeUploadedFilename(uploaded.name);
  if (!name || !isSupportedInput(name)) {
    throw new Error("不支持的文件类型。请选择 TXT、EPUB、DOCX、HTML、ODT、Markdown 或 RTF 文件。");
  }
  const encoded = String(uploaded.data || "").replace(/^data:[^;]+;base64,/, "");
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error("上传文件数据无效。");
  }

  const buffer = Buffer.from(encoded, "base64");
  if (!buffer.length) throw new Error("上传文件为空。");
  if (buffer.length > maxUploadBytes) throw new Error("单个文件不能超过 80 MB。");

  const uploadDir = path.join(importedInputsDir, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`);
  fs.mkdirSync(uploadDir, { recursive: true });
  const target = path.join(uploadDir, `${role}-${name}`);
  fs.writeFileSync(target, buffer);
  const file = { ...filePayload(target), name };
  return {
    comparisonMode: mode,
    file,
    inputMode: inferInputMode({ [role]: target }),
  };
}

function savedFilePayloads(saved) {
  if (!saved?.files) return {};
  return Object.fromEntries(
    ["jp", "cn", "tw"]
      .map((role) => [role, saved.files[role]])
      .filter(([, file]) => file && fs.existsSync(file))
      .map(([role, file]) => [role, filePayload(file)]),
  );
}

function scanDirectory(dir, comparisonMode = "trilingual") {
  const inputDir = normalizePath(dir);
  const mode = normalizeComparisonMode(comparisonMode);
  if (!inputDir) throw new Error("请输入源文件目录。");
  if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
    throw new Error(`目录不存在：${inputDir}`);
  }

  const files = supportedFilesInDirectory(inputDir);
  const minimumFiles = mode === "bilingual" ? 2 : 3;
  if (files.length < minimumFiles) {
    throw new Error(`至少需要 ${minimumFiles} 个支持的源文件；当前找到 ${files.length} 个。`);
  }

  const guessed = guessLangOrder(files, mode);
  return {
    comparisonMode: mode,
    inputDir,
    files: files.map(filePayload),
    guessed,
    inputMode: inferInputMode(guessed),
  };
}

function saveInputSelection(payload) {
  const files = {
    jp: normalizePath(payload.files?.jp),
    cn: normalizePath(payload.files?.cn),
    tw: normalizePath(payload.files?.tw),
  };
  const startMarkers = Object.fromEntries(
    Object.entries(payload.startMarkers || {})
      .map(([lang, value]) => [lang, String(value || "").trim()])
      .filter(([, value]) => value),
  );
  const selection = validateSelection({
    files,
    comparisonMode: payload.comparisonMode,
    inputMode: payload.inputMode || inferInputMode(files),
    labels: payload.labels || defaultDisplayLabels,
    startMarkers,
    inlineMarkup: {
      ...defaultInlineMarkup,
      ...(payload.inlineMarkup || {}),
    },
  });
  saveSelection(selection);
  return { selection, selectionFile };
}

function runCommand(command, args, step, progress) {
  return new Promise((resolve, reject) => {
    pipeline.step = step;
    if (progress) pipeline.progress = { ...progress, step };
    pushLog(`> ${[command, ...args].join(" ")}`);
    const spawnOptions = {
      cwd: rootDir,
      shell: false,
      env: {
        ...process.env,
        PYTHONIOENCODING: process.env.PYTHONIOENCODING || "utf-8",
        PYTHONUTF8: process.env.PYTHONUTF8 || "1",
      },
    };
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const child = process.platform === "win32"
      ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/c", makeWindowsCommand(command, args)], spawnOptions)
      : spawn(command, args, spawnOptions);

    child.stdout.on("data", (chunk) => pushLog(stdoutDecoder.write(chunk)));
    child.stderr.on("data", (chunk) => pushLog(stderrDecoder.write(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      pushLog(stdoutDecoder.end());
      pushLog(stderrDecoder.end());
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${step} failed with exit code ${code}.`));
    });
  });
}

function makeWindowsCommand(command, args) {
  return ["call", quoteWindowsCommandArg(command), ...args.map(quoteWindowsCommandArg)].join(" ");
}

function quoteWindowsCommandArg(value) {
  const text = String(value);
  if (!/[()\s^&|<>"]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

async function runPipeline() {
  pipeline.running = true;
  pipeline.step = "starting";
  pipeline.progress = { current: 0, total: 2, percent: 0, step: "starting" };
  pipeline.code = null;
  pipeline.error = "";
  pipeline.startedAt = new Date().toISOString();
  pipeline.finishedAt = null;
  pipeline.logs = [];
  try {
    await runCommand(npmCommand, ["run", "align:jp"], "align:jp", { current: 0, total: 2, percent: 10 });
    pipeline.progress = { current: 1, total: 2, percent: 50, step: "build" };
    await runCommand(npmCommand, ["run", "build"], "build", { current: 1, total: 2, percent: 60 });
    pipeline.step = "done";
    pipeline.progress = { current: 2, total: 2, percent: 100, step: "done" };
    pipeline.code = 0;
    pushLog(`Done. Output: ${compareHtmlFile}`);
  } catch (error) {
    pipeline.step = "failed";
    pipeline.progress = { ...pipeline.progress, step: "failed" };
    pipeline.code = 1;
    pipeline.error = error.message || String(error);
    pushLog(pipeline.error);
  } finally {
    pipeline.running = false;
    pipeline.finishedAt = new Date().toISOString();
  }
}

function pipelineStatus() {
  return {
    running: pipeline.running,
    step: pipeline.step,
    progress: pipeline.progress,
    code: pipeline.code,
    error: pipeline.error,
    startedAt: pipeline.startedAt,
    finishedAt: pipeline.finishedAt,
    logs: pipeline.logs,
    outputExists: fs.existsSync(compareHtmlFile),
    outputUrl: fs.existsSync(compareHtmlFile) ? "/output/translation-compare.html" : "",
  };
}

function serveStatic(req, res, pathname) {
  const target = pathname === "/" ? path.join(publicDir, "setup.html") : path.join(publicDir, pathname);
  const resolved = path.resolve(target);
  if (resolved !== publicDir && !resolved.startsWith(`${publicDir}${path.sep}`)) {
    sendError(res, 403, new Error("Forbidden."));
    return;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    sendError(res, 404, new Error("Not found."));
    return;
  }
  const ext = path.extname(resolved).toLowerCase();
  const type = ext === ".html" ? "text/html; charset=utf-8"
    : ext === ".css" ? "text/css; charset=utf-8"
      : ext === ".js" ? "text/javascript; charset=utf-8"
        : "application/octet-stream";
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  fs.createReadStream(resolved).pipe(res);
}

function serveOutput(res, pathname) {
  if (pathname !== "/output/translation-compare.html") {
    sendError(res, 404, new Error("Output not found."));
    return;
  }
  if (!fs.existsSync(compareHtmlFile)) {
    sendError(res, 404, new Error("工作台尚未生成。"));
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  fs.createReadStream(compareHtmlFile).pipe(res);
}

async function handleApi(req, res, pathname, searchParams) {
  try {
    if (req.method === "GET" && pathname === "/api/status") {
      const saved = fs.existsSync(selectionFile)
        ? JSON.parse(fs.readFileSync(selectionFile, "utf8"))
        : null;
      sendJson(res, 200, { ok: true, selectionFile, saved, savedFiles: savedFilePayloads(saved), pipeline: pipelineStatus() });
      return;
    }

    if (req.method === "GET" && pathname === "/api/scan") {
      sendJson(res, 200, { ok: true, ...scanDirectory(searchParams.get("dir"), searchParams.get("mode")) });
      return;
    }

    if (req.method === "POST" && pathname === "/api/selection") {
      const payload = await readJson(req);
      sendJson(res, 200, { ok: true, ...saveInputSelection(payload) });
      return;
    }

    if (req.method === "POST" && pathname === "/api/upload") {
      const payload = await readJson(req);
      sendJson(res, 200, { ok: true, ...saveUploadedInput(payload) });
      return;
    }

    if (req.method === "POST" && pathname === "/api/run") {
      if (pipeline.running) {
        sendJson(res, 409, { ok: false, error: "生成流程正在运行。", pipeline: pipelineStatus() });
        return;
      }
      if (aiProofreadStatus().running) {
        sendJson(res, 409, { ok: false, error: "AI 校对正在运行，请先停止后再生成新的工作台。", pipeline: pipelineStatus(), ai: aiProofreadStatus() });
        return;
      }
      if (!fs.existsSync(selectionFile)) {
        sendJson(res, 400, { ok: false, error: "请先保存输入选择。", pipeline: pipelineStatus() });
        return;
      }
      clearProofreadCache();
      runPipeline();
      sendJson(res, 202, { ok: true, pipeline: pipelineStatus() });
      return;
    }

    if (req.method === "GET" && pathname === "/api/ai-proofread/status") {
      sendJson(res, 200, { ok: true, ai: aiProofreadStatus() });
      return;
    }

    if (req.method === "POST" && pathname === "/api/ai-proofread/models") {
      const payload = await readJson(req);
      sendJson(res, 200, { ok: true, models: await listModels(payload) });
      return;
    }

    if (req.method === "POST" && pathname === "/api/ai-proofread/start") {
      const payload = await readJson(req);
      try {
        sendJson(res, 202, { ok: true, ai: await startProofread(payload) });
      } catch (error) {
        sendJson(res, error.code === "RUNNING" ? 409 : 400, { ok: false, error: error.message, ai: aiProofreadStatus() });
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/ai-proofread/stop") {
      sendJson(res, 200, { ok: true, ai: stopProofread() });
      return;
    }

    if (req.method === "POST" && pathname === "/api/ai-proofread/cache/clear") {
      try {
        sendJson(res, 200, { ok: true, ai: clearProofreadCache() });
      } catch (error) {
        sendJson(res, error.code === "RUNNING" ? 409 : 400, { ok: false, error: error.message, ai: aiProofreadStatus() });
      }
      return;
    }

    sendError(res, 404, new Error(`Unknown local API endpoint: ${pathname}`));
  } catch (error) {
    sendError(res, 400, error);
  }
}

function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://${host}:${defaultPort}`);
    if (url.pathname.startsWith("/api/")) {
      handleApi(req, res, url.pathname, url.searchParams);
      return;
    }
    if (url.pathname.startsWith("/output/")) {
      serveOutput(res, url.pathname);
      return;
    }
    serveStatic(req, res, decodeURIComponent(url.pathname));
  });
}

const server = createServer();

if (require.main === module) {
  server.listen(defaultPort, host, () => {
    const url = `http://${host}:${defaultPort}/`;
    console.log(`TransComparator console: ${url}`);
    console.log("Press Ctrl+C to stop.");
  });
}

module.exports = {
  createServer,
  host,
  saveUploadedInput,
};
