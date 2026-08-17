const path = require("path");
const { execFile } = require("child_process");

const pandocFormats = {
  ".csv": "csv",
  ".docbook": "docbook",
  ".docx": "docx",
  ".epub": "epub",
  ".html": "html",
  ".htm": "html",
  ".json": "json",
  ".md": "markdown",
  ".markdown": "markdown",
  ".odt": "odt",
  ".rst": "rst",
  ".rtf": "rtf",
  ".tsv": "tsv",
};

function normalizeDocumentText(text) {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatForFile(file) {
  return pandocFormats[path.extname(file).toLowerCase()] || null;
}

function textLength(text) {
  return Array.from(String(text || "").replace(/\s+/g, "")).length;
}

function readWithPandoc(file, options = {}) {
  const pandocBin = process.env.PANDOC_BIN || "pandoc";
  const from = options.from || formatForFile(file);
  const to = options.to || "plain";
  if (!from) {
    throw new Error(`Pandoc input format is not configured for ${path.extname(file) || "extensionless file"}`);
  }

  const args = [file, "-f", from, "-t", to, "--wrap=none"];

  return new Promise((resolve, reject) => {
    execFile(pandocBin, args, { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(normalizeDocumentText(stdout));
    });
  });
}

module.exports = {
  formatForFile,
  normalizeDocumentText,
  readWithPandoc,
  textLength,
};
