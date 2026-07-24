const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline/promises");
const { formatForFile } = require("./pandoc-utils");

const outputDir = path.join(__dirname, "..", "out");
const selectionFile = path.join(outputDir, "input-selection.json");
const langs = ["jp", "cn", "tw"];
const labels = {
  jp: "原文 A",
  cn: "非原文 B",
  tw: "非原文 C",
};
const defaultDisplayLabels = {
  jp: "日文",
  cn: "简中",
  tw: "台版",
};
const defaultInlineMarkup = {
  ruby: true,
  bold: true,
};

function normalizePath(value) {
  if (!value) return "";
  const expanded = String(value).trim().replace(/^["']|["']$/g, "");
  if (!expanded) return "";
  if (expanded === "~") return os.homedir();
  if (expanded.startsWith(`~${path.sep}`) || expanded.startsWith("~/")) {
    return path.join(os.homedir(), expanded.slice(2));
  }
  return path.resolve(expanded);
}

function isSupportedInput(file) {
  if (!file) return false;
  if (/\.txt$/i.test(file)) return true;
  return Boolean(formatForFile(file));
}

function inferInputMode(files) {
  const extensions = Object.values(files).filter(Boolean).map((file) => path.extname(file).toLowerCase());
  if (extensions.every((ext) => ext === ".txt")) return "txt";
  if (extensions.every((ext) => ext === ".epub")) return "epub";
  return "document";
}

function normalizeComparisonMode(value) {
  return value === "bilingual" ? "bilingual" : "trilingual";
}

function validateSelection(selection) {
  if (!selection?.files) throw new Error("Input selection is missing files.");
  const comparisonMode = normalizeComparisonMode(selection.comparisonMode);
  const requiredLangs = comparisonMode === "bilingual" ? ["jp", "cn"] : langs;
  for (const lang of requiredLangs) {
    const file = selection.files[lang];
    if (!file) throw new Error(`Missing ${lang} input file.`);
    if (!fs.existsSync(file)) throw new Error(`Input file does not exist: ${file}`);
    if (!isSupportedInput(file)) throw new Error(`Unsupported input file type: ${file}`);
  }
  return {
    comparisonMode,
    inputMode: selection.inputMode || inferInputMode(selection.files),
    files: Object.fromEntries(langs.map((lang) => [
      lang,
      comparisonMode === "bilingual" && lang === "tw"
        ? ""
        : (selection.files[lang] ? path.resolve(selection.files[lang]) : ""),
    ])),
    labels: {
      ...defaultDisplayLabels,
      ...Object.fromEntries(
        Object.entries(selection.labels || {})
          .map(([lang, label]) => [lang, String(label || "").trim()])
          .filter(([lang, label]) => langs.includes(lang) && label),
      ),
    },
    startMarkers: selection.startMarkers || {},
    inlineMarkup: normalizeInlineMarkup(selection.inlineMarkup),
  };
}

function normalizeInlineMarkup(value = {}) {
  return {
    ruby: value.ruby !== false,
    bold: value.bold !== false,
  };
}

function loadSavedSelection() {
  if (!fs.existsSync(selectionFile)) return null;
  return validateSelection(JSON.parse(fs.readFileSync(selectionFile, "utf8")));
}

function saveSelection(selection) {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(selectionFile, JSON.stringify(validateSelection(selection), null, 2), "utf8");
}

function parseArgs(argv = process.argv.slice(2)) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

function selectionFromExplicitFiles(source) {
  const comparisonMode = normalizeComparisonMode(source.comparisonMode || source["comparison-mode"] || process.env.TRANSCOMPARATOR_COMPARISON_MODE);
  const files = {
    jp: normalizePath(source.jp || source["jp-file"] || process.env.TRANSCOMPARATOR_JP_FILE),
    cn: normalizePath(source.cn || source["cn-file"] || process.env.TRANSCOMPARATOR_CN_FILE),
    tw: normalizePath(source.tw || source["tw-file"] || process.env.TRANSCOMPARATOR_TW_FILE),
  };
  const requiredLangs = comparisonMode === "bilingual" ? ["jp", "cn"] : langs;
  if (!requiredLangs.every((lang) => files[lang])) return null;
  return validateSelection({
    files,
    comparisonMode,
    inputMode: source.mode || process.env.TRANSCOMPARATOR_INPUT_MODE || inferInputMode(files),
    startMarkers: startMarkersFromSource(source),
  });
}

function startMarkersFromSource(source) {
  return Object.fromEntries(
    langs
      .map((lang) => [
        lang,
        source[`${lang}-start`] || process.env[`TRANSCOMPARATOR_${lang.toUpperCase()}_START_MARKER`] || "",
      ])
      .filter(([, marker]) => marker),
  );
}

function supportedFilesInDirectory(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dir, entry.name))
    .filter(isSupportedInput)
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

function guessLangOrder(files, comparisonMode = "trilingual") {
  const unused = new Set(files);
  const take = (predicate) => {
    for (const file of unused) {
      if (predicate(path.basename(file))) {
        unused.delete(file);
        return file;
      }
    }
    return null;
  };
  const result = {
    jp: take((name) => /[ぁ-んァ-ヶー]/.test(name)),
    cn: take((name) => /[简简中汉栖这学园诡诈骗权译]/.test(name) || /\bcn\b/i.test(name)),
    tw: comparisonMode === "bilingual" ? null : take((name) => /[繁台臺這學園詐騙權譯鎌馬]/.test(name) || /\btw\b/i.test(name)),
  };
  const activeLangs = comparisonMode === "bilingual" ? ["jp", "cn"] : langs;
  for (const lang of activeLangs) {
    if (!result[lang]) {
      const [file] = unused;
      result[lang] = file;
      unused.delete(file);
    }
  }
  return result;
}

function selectionFromDirectory(dir, source = {}) {
  const inputDir = normalizePath(dir);
  const comparisonMode = normalizeComparisonMode(source.comparisonMode || source["comparison-mode"] || process.env.TRANSCOMPARATOR_COMPARISON_MODE);
  if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
    throw new Error(`Input directory does not exist: ${inputDir}`);
  }
  const files = supportedFilesInDirectory(inputDir);
  const minimumFiles = comparisonMode === "bilingual" ? 2 : 3;
  if (files.length < minimumFiles) {
    throw new Error(`Need at least ${minimumFiles} supported files in ${inputDir}; found ${files.length}.`);
  }
  return validateSelection({
    comparisonMode,
    files: guessLangOrder(files, comparisonMode),
    inputMode: source.mode || process.env.TRANSCOMPARATOR_INPUT_MODE || inferInputMode(guessLangOrder(files, comparisonMode)),
    startMarkers: startMarkersFromSource(source),
  });
}

function selectionFromArgsOrEnv() {
  const args = parseArgs();
  const explicit = selectionFromExplicitFiles(args);
  if (explicit) return explicit;

  const inputDir = args["input-dir"] || args.dir || process.env.TRANSCOMPARATOR_INPUT_DIR;
  if (inputDir) return selectionFromDirectory(inputDir, args);

  return null;
}

function describeSelection(selection) {
  return langs
    .filter((lang) => selection.files[lang])
    .map((lang) => `${labels[lang]}(${lang}): ${selection.files[lang]}`)
    .join("\n");
}

async function ask(rl, question, defaultValue = "") {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || defaultValue;
}

async function askYesNo(rl, question, defaultValue = true) {
  const hint = defaultValue ? "Y/n" : "y/N";
  const answer = (await rl.question(`${question} (${hint}): `)).trim().toLowerCase();
  if (!answer) return defaultValue;
  return ["y", "yes", "是", "好"].includes(answer);
}

async function chooseFile(rl, files, lang, defaultFile, chosen) {
  const defaultIndex = files.findIndex((file) => file === defaultFile) + 1;
  while (true) {
    const answer = await ask(rl, `选择${labels[lang]}(${lang})文件编号`, String(defaultIndex || ""));
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= files.length) {
      const file = files[index - 1];
      if (!chosen.has(file)) {
        chosen.add(file);
        return file;
      }
      console.log("这个文件已经选过了，请选择另一份。");
    } else {
      console.log("请输入列表中的数字编号。");
    }
  }
}

async function promptSelection(savedSelection = null) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (savedSelection) {
      console.log("当前保存的输入选择：");
      console.log(describeSelection(savedSelection));
      if (await askYesNo(rl, "继续使用这组选项", true)) return savedSelection;
    }

    const defaultDir = savedSelection ? path.dirname(savedSelection.files.jp) : "";
    const inputDir = normalizePath(await ask(rl, "输入源文件目录", defaultDir));
    const files = supportedFilesInDirectory(inputDir);
    if (files.length < 3) {
      throw new Error(`Need at least 3 supported files in ${inputDir}; found ${files.length}.`);
    }

    console.log("可选文件：");
    files.forEach((file, index) => {
      console.log(`${index + 1}. ${path.basename(file)}`);
    });

    const guessed = guessLangOrder(files);
    const chosen = new Set();
    const selectedFiles = {};
    for (const lang of langs) {
      selectedFiles[lang] = await chooseFile(rl, files, lang, guessed[lang], chosen);
    }

    const startMarkers = {};
    if (await askYesNo(rl, "需要手动输入正文起始短语来跳过封面、目录或制作信息吗", false)) {
      for (const lang of langs) {
        const marker = await ask(rl, `${labels[lang]}(${lang})正文起始短语，可留空`);
        if (marker) startMarkers[lang] = marker;
      }
    }

    return validateSelection({
      files: selectedFiles,
      inputMode: inferInputMode(selectedFiles),
      startMarkers,
    });
  } finally {
    rl.close();
  }
}

async function resolveInputSelection(options = {}) {
  const envSelection = selectionFromArgsOrEnv();
  if (envSelection) return envSelection;

  const savedSelection = loadSavedSelection();
  const canPrompt = options.allowPrompt !== false && process.stdin.isTTY && process.stdout.isTTY;
  if (canPrompt && (options.promptIfSaved || !savedSelection)) {
    return promptSelection(savedSelection);
  }
  if (savedSelection) return savedSelection;

  throw new Error(
    [
      "No input files selected.",
      "Run this script in an interactive terminal, or pass --input-dir <dir>,",
      "or set TRANSCOMPARATOR_JP_FILE, TRANSCOMPARATOR_CN_FILE, and TRANSCOMPARATOR_TW_FILE.",
    ].join(" "),
  );
}

module.exports = {
  guessLangOrder,
  inferInputMode,
  isSupportedInput,
  normalizePath,
  selectionFile,
  resolveInputSelection,
  saveSelection,
  describeSelection,
  defaultDisplayLabels,
  defaultInlineMarkup,
  normalizeComparisonMode,
  supportedFilesInDirectory,
  validateSelection,
};
