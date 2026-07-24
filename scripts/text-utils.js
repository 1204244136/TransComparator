const fs = require("fs");
const path = require("path");
const OpenCC = require("opencc-js");
const { readEpubText } = require("./epub-utils");
const { formatForFile, readWithPandoc } = require("./pandoc-utils");
const { resolveBuildOutputDir } = require("./storage-layout");

const outputDir = resolveBuildOutputDir();

const startMarkers = {
  tw: "",
  cn: "",
  jp: "",
};

const endMarkers = {
  tw: ["第一卷 後記", "\n後記\n", "\n後記\r\n"],
  cn: "后记",
  jp: "あとがき",
};

const chapterPatterns = {
  tw: /^(第[一二三四五六七八九十0-9０-９]+卷\s+)?(序\s*章(?:\s+.*)?|行間\s*[一二三四五六七八九十0-9０-９]+|第[一二三四五六七八九十0-9０-９]+(?:章|話)(?:\s+.*)?|終章(?:\s+.*)?)\s*$/,
  cn: /^(序\s*章(?:\s+.*)?|行间\s*[一二三四五六七八九十0-9０-９]+|第[一二三四五六七八九十0-9０-９]+(?:章|话)(?:\s+.*)?|终章(?:\s+.*)?)\s*$/,
  jp: /^(序\s*章(?:\s+.*)?|行間\s*[一二三四五六七八九十0-9０-９]+|第[一二三四五六七八九十0-9０-９]+(?:章|話)(?:\s+.*)?|終章(?:\s+.*)?)\s*$/,
};

const toCn = OpenCC.Converter({ from: "tw", to: "cn" });

function readText(file) {
  return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

async function readInputText(file) {
  if (/\.epub$/i.test(file)) return readEpubText(file);
  if (formatForFile(file)) return readWithPandoc(file);
  return readText(file);
}

async function readSelectedInputText(file, selection = {}) {
  if (/\.epub$/i.test(file)) return readEpubText(file, { inlineMarkup: selection.inlineMarkup });
  return readInputText(file);
}

function blockStartPattern(markers) {
  return new RegExp(
    `(?:^|\\n\\s*\\n)\\s*(?:${markers.map((marker) => marker.source || marker).join("|")})(?:\\s|$|[：:])`,
    "i",
  );
}

const documentEndPatterns = {
  tw: blockStartPattern([
    "第一卷\\s*後記",
    "後記",
    "電子書特典",
    "特典",
    "版權頁",
    "版權",
    "版权",
    "colophon",
    "copyright",
  ]),
  cn: blockStartPattern([
    "后记",
    "後記",
    "特典",
    "版权页",
    "版权",
    "版權",
    "译注",
    "譯注",
    "colophon",
    "copyright",
  ]),
  jp: blockStartPattern([
    "あとがき",
    "後書き",
    "特典",
    "奥付",
    "発行",
    "発行者",
    "colophon",
    "copyright",
  ]),
};

function sliceMain(text, startMarker, endMarker, options = {}) {
  const { requireStart = true, trimEnd = true } = options;
  const start = text.indexOf(startMarker);
  if (start === -1) {
    if (requireStart) throw new Error(`Cannot find start marker: ${startMarker}`);
    return text;
  }
  if (!trimEnd) return text.slice(start);

  const markers = Array.isArray(endMarker) ? endMarker : [endMarker];
  const end = markers
    .map((marker) => text.indexOf(marker, start))
    .filter((index) => index !== -1)
    .sort((a, b) => a - b)[0] ?? -1;
  return text.slice(start, end === -1 ? text.length : end);
}

function normalizeBlock(block) {
  return String(block || "").replace(/\s+/g, " ").trim();
}

function textLength(text) {
  return Array.from(String(text || "").replace(/\s+/g, "")).length;
}

function blockRanges(text) {
  const ranges = [];
  const pattern = /\n\s*\n+/g;
  let start = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    ranges.push({ start, end: match.index, text: text.slice(start, match.index) });
    start = pattern.lastIndex;
  }
  ranges.push({ start, end: text.length, text: text.slice(start) });
  return ranges;
}

function isFrontMatterBlock(block, lang) {
  const normalized = normalizeBlock(block);
  if (!normalized) return true;
  if (isMediaOnlyBlock(normalized)) return true;
  if (normalizeTitle(normalized, lang)) return true;
  if (/^(contents|目錄|目录|ＣＯＮＴＥＮＴＳ|navigation)$/i.test(normalized)) return true;
  if (/^(制作信息|製作信息|网翻|翻译|翻譯|校对|校對|美工|录入|錄入|简介|簡介)(?:\s|：|:|$)/i.test(normalized)) return true;
  if (/^(暗部共生少女|某暗部的少女共栖|とある暗部の少女共棲)\s*\d*$/i.test(normalized)) return true;
  if (/^(鎌池和馬|镰池和马|鎌池和馬かまちかずま)$/.test(normalized)) return true;
  if (/本電子書籍|本电子书籍|リーディングシステム|再ダウンロード|ePub3|Reasily|图书观看|內容由|内容由|试看学习交流|商業用途|商业用途|转载时请保留|如有任何问题请联系|汉化组|漢化組/i.test(normalized)) return true;
  return false;
}

function isLikelyBodyBlock(block, lang) {
  const normalized = normalizeBlock(block);
  if (isFrontMatterBlock(normalized, lang)) return false;
  if (textLength(normalized) < 18) return false;
  const sentenceMarks = (normalized.match(/[。．.!！？?」』”’）)]/g) || []).length;
  return sentenceMarks > 0 || textLength(normalized) >= 80;
}

function findBodyStart(text, lang, markers = {}) {
  const startMarker = markers[lang] ?? startMarkers[lang];
  if (startMarker) {
    const start = text.indexOf(startMarker);
    if (start !== -1) return start;
  }

  let inSynopsis = false;
  for (const range of blockRanges(text)) {
    const normalized = normalizeBlock(range.text);
    if (/^(简介|簡介)(?:\s|：|:|$)/i.test(normalized)) {
      inSynopsis = true;
      continue;
    }
    if (inSynopsis) {
      if (isMediaOnlyBlock(normalized)) {
        inSynopsis = false;
        continue;
      }
      if (normalizeTitle(normalized, lang)) inSynopsis = false;
      else continue;
    }
    if (isLikelyBodyBlock(range.text, lang)) return range.start;
  }
  return -1;
}

function sliceMainDocument(text, lang, markers = {}) {
  const start = findBodyStart(text, lang, markers);
  const body = start === -1 ? text : text.slice(start);
  if (start === -1) return body;
  const pattern = documentEndPatterns[lang];
  if (!pattern) return body;

  // A combined EPUB can contain an intermediate afterword followed by another
  // work. Only trim a back-matter marker when no later chapter heading appears
  // before the next marker; otherwise keep scanning for the terminal marker.
  const matcher = new RegExp(pattern.source, `${pattern.flags.replace(/g/g, "")}g`);
  let match;
  while ((match = matcher.exec(body)) !== null) {
    const remainder = body.slice(match.index + match[0].length);
    const nextMarker = remainder.search(pattern);
    const section = nextMarker === -1 ? remainder : remainder.slice(0, nextMarker);
    const hasLaterChapter = blockRanges(section).some((range) => Boolean(normalizeTitle(range.text, lang)));
    if (!hasLaterChapter) return body.slice(0, match.index);
  }
  return body;
}

function sliceMainForInput(text, lang, inputMode = "document", markers = {}) {
  if (inputMode !== "txt") return sliceMainDocument(text, lang, markers);

  const startMarker = markers[lang] ?? startMarkers[lang];
  if (!startMarker) return sliceMainDocument(text, lang, markers);

  return sliceMain(text, startMarker, endMarkers[lang], {
    requireStart: Boolean(startMarker),
    trimEnd: true,
  });
}

function normalizeTitle(line, lang) {
  const trimmed = line.trim();
  if (!trimmed) return "";
  const match = trimmed.match(chapterPatterns[lang]);
  return match ? trimmed : "";
}

function isMediaOnlyBlock(block) {
  const trimmed = block.trim();
  return /^(?:\[\s*(?:图片|圖片|图像|圖像|插图|插圖|image|img|p\d{1,5})?\s*\]\s*)+$/i.test(trimmed);
}

function splitParagraphs(text, lang) {
  const blocks = text
    .split(/\n\s*\n+/)
    .map((block) => block.replace(/\n+/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((block) => !/^[\-─－—＊*☆★\s]+$/.test(block))
    .filter((block) => !isMediaOnlyBlock(block));

  let currentChapter = "正文";
  const paragraphs = [];

  for (const block of blocks) {
    const title = normalizeTitle(block, lang);
    if (title) {
      currentChapter = title;
      continue;
    }

    paragraphs.push({
      sourceIndex: paragraphs.length,
      lang,
      chapter: currentChapter,
      text: block,
      cnText: lang === "tw" ? toCn(block) : block,
      chars: Array.from(block).length,
    });
  }

  return paragraphs;
}

async function loadParagraphs(selection) {
  const files = selection?.files;
  if (!files) throw new Error("loadParagraphs requires an input selection.");
  const inputMode = selection.inputMode || "document";
  const comparisonMode = selection.comparisonMode === "bilingual" ? "bilingual" : "trilingual";
  const markers = selection.startMarkers || {};
  const tw = comparisonMode === "bilingual"
    ? []
    : splitParagraphs(sliceMainForInput(await readSelectedInputText(files.tw, selection), "tw", inputMode, markers), "tw");
  return {
    tw,
    cn: splitParagraphs(sliceMainForInput(await readSelectedInputText(files.cn, selection), "cn", inputMode, markers), "cn"),
    jp: splitParagraphs(sliceMainForInput(await readSelectedInputText(files.jp, selection), "jp", inputMode, markers), "jp"),
  };
}

module.exports = {
  outputDir,
  toCn,
  readText,
  readInputText,
  sliceMain,
  sliceMainDocument,
  sliceMainForInput,
  splitParagraphs,
  loadParagraphs,
};
