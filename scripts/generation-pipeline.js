const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");
const {
  createProjectStaging,
  discardStaging,
  getActiveProject,
  publishProject,
} = require("./project-store");
const { rootDir } = require("./storage-layout");

const progressPrefix = "@@transcomparator-progress@@";

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

function parseProgressMessage(line) {
  const text = String(line || "").trim();
  if (!text.startsWith(progressPrefix)) return null;
  try {
    const message = JSON.parse(text.slice(progressPrefix.length));
    const percent = Number(message.percent);
    if (!Number.isFinite(percent)) return null;
    return {
      ...message,
      percent: Math.max(0, Math.min(100, percent)),
    };
  } catch {
    return null;
  }
}

function mapCommandProgress(message, step, range = {}) {
  const start = Number(range.start) || 0;
  const end = Number.isFinite(Number(range.end)) ? Number(range.end) : 100;
  const percent = start + ((end - start) * message.percent / 100);
  return {
    current: Number(message.current) || 0,
    total: Number(message.total) || 0,
    percent: Math.round(percent * 10) / 10,
    step,
    detail: String(message.label || "").trim(),
  };
}

function createLineConsumer(onLine) {
  let buffered = "";
  return {
    write(text) {
      buffered += String(text || "").replace(/\r\n?/g, "\n");
      const lines = buffered.split("\n");
      buffered = lines.pop() || "";
      for (const line of lines) onLine(line);
    },
    end(text = "") {
      this.write(text);
      if (buffered) onLine(buffered);
      buffered = "";
    },
  };
}

function makeWindowsCommand(command, args) {
  return ["call", quoteWindowsCommandArg(command), ...args.map(quoteWindowsCommandArg)].join(" ");
}

function quoteWindowsCommandArg(value) {
  const text = String(value);
  if (!/[()\s^&|<>"]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

class GenerationPipeline {
  constructor(options = {}) {
    this.rootDir = options.rootDir || rootDir;
    this.npmCommand = options.npmCommand || resolveNpmCommand();
    this.state = {
      running: false,
      step: "idle",
      progress: { current: 0, total: 2, percent: 0, step: "idle" },
      code: null,
      error: "",
      startedAt: null,
      finishedAt: null,
      completedProject: null,
      logs: [],
    };
  }

  get running() {
    return this.state.running;
  }

  pushLog(line) {
    const text = String(line || "").replace(/\r\n?/g, "\n");
    for (const part of text.split("\n")) {
      if (part) this.state.logs.push(part);
    }
    if (this.state.logs.length > 500) {
      this.state.logs.splice(0, this.state.logs.length - 500);
    }
  }

  runCommand(command, args, step, progressRange, environment = {}) {
    return new Promise((resolve, reject) => {
      this.state.step = step;
      if (progressRange) {
        this.state.progress = {
          current: 0,
          total: 0,
          percent: progressRange.start,
          step,
          detail: progressRange.label || "",
        };
      }
      this.pushLog(`> ${[command, ...args].join(" ")}`);
      const spawnOptions = {
        cwd: this.rootDir,
        shell: false,
        env: {
          ...process.env,
          PYTHONIOENCODING: process.env.PYTHONIOENCODING || "utf-8",
          PYTHONUTF8: process.env.PYTHONUTF8 || "1",
          TRANS_COMPARATOR_MACHINE_PROGRESS: "1",
          ...environment,
        },
      };
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      const child = process.platform === "win32"
        ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/c", makeWindowsCommand(command, args)], spawnOptions)
        : spawn(command, args, spawnOptions);

      const consumeLine = (line) => {
        const message = parseProgressMessage(line);
        if (message && progressRange) {
          this.state.progress = mapCommandProgress(message, step, progressRange);
          return;
        }
        this.pushLog(line);
      };
      const stdoutConsumer = createLineConsumer(consumeLine);
      const stderrConsumer = createLineConsumer(consumeLine);
      child.stdout.on("data", (chunk) => stdoutConsumer.write(stdoutDecoder.write(chunk)));
      child.stderr.on("data", (chunk) => stderrConsumer.write(stderrDecoder.write(chunk)));
      child.on("error", reject);
      child.on("close", (code) => {
        stdoutConsumer.end(stdoutDecoder.end());
        stderrConsumer.end(stderrDecoder.end());
        if (code === 0) resolve();
        else reject(new Error(`${step} failed with exit code ${code}.`));
      });
    });
  }

  async run(selection) {
    this.state.running = true;
    this.state.step = "starting";
    this.state.progress = { current: 0, total: 2, percent: 0, step: "starting" };
    this.state.code = null;
    this.state.error = "";
    this.state.startedAt = new Date().toISOString();
    this.state.finishedAt = null;
    this.state.completedProject = null;
    this.state.logs = [];
    let staging = null;
    try {
      staging = createProjectStaging(selection);
      const buildEnvironment = {
        TRANSCOMPARATOR_OUTPUT_DIR: staging.dir,
        TRANSCOMPARATOR_SELECTION_FILE: path.join(staging.dir, "input-selection.json"),
      };
      await this.runCommand(this.npmCommand, ["run", "align:jp"], "align:jp", {
        start: 2,
        end: 84,
        label: "检查运行环境",
      }, buildEnvironment);
      await this.runCommand(this.npmCommand, ["run", "build"], "build", {
        start: 84,
        end: 98,
        label: "加载对齐结果",
      }, buildEnvironment);
      this.state.progress = { current: 0, total: 0, percent: 99, step: "archive", detail: "发布项目快照" };
      const project = publishProject(staging.dir);
      staging = null;
      this.state.completedProject = project;
      this.state.step = "done";
      this.state.progress = { current: 2, total: 2, percent: 100, step: "done" };
      this.state.code = 0;
      this.pushLog(`Project published: ${project.name}`);
      this.pushLog(`Done. Output: ${project.outputUrl}`);
    } catch (error) {
      this.state.step = "failed";
      this.state.progress = { ...this.state.progress, step: "failed" };
      this.state.code = 1;
      this.state.error = error.message || String(error);
      this.pushLog(this.state.error);
    } finally {
      if (staging?.dir) discardStaging(staging.dir);
      this.state.running = false;
      this.state.finishedAt = new Date().toISOString();
    }
  }

  status() {
    const activeProject = getActiveProject();
    return {
      ...this.state,
      outputExists: Boolean(activeProject),
      outputUrl: activeProject?.outputUrl || "",
    };
  }

  markProjectReady(project) {
    this.state.step = "ready";
    this.state.progress = { current: 2, total: 2, percent: 100, step: "ready" };
    this.state.code = 0;
    this.state.error = "";
    this.state.startedAt = null;
    this.state.finishedAt = new Date().toISOString();
    this.state.completedProject = null;
    this.state.logs = [`已切换项目：${project.name}`];
  }
}

module.exports = {
  GenerationPipeline,
  mapCommandProgress,
  parseProgressMessage,
};
