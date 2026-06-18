const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");
const { XMLParser } = require("fast-xml-parser");
const { compile } = require("html-to-text");
const { readWithPandoc } = require("./pandoc-utils");

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
});

const htmlToTextWithInlineMarkup = compile({
  wordwrap: false,
  decodeEntities: true,
  selectors: [
    { selector: "head", format: "skip" },
    { selector: "script", format: "skip" },
    { selector: "style", format: "skip" },
    { selector: "img", format: "skip" },
    { selector: "a", options: { ignoreHref: true } },
    { selector: "ruby", format: "inlineTag" },
    { selector: "rt", format: "inlineTag" },
    { selector: "b", format: "inlineTag" },
    { selector: "strong", format: "inlineSurround", options: { prefix: "<b>", suffix: "</b>" } },
    { selector: "h1", options: { uppercase: false, leadingLineBreaks: 2, trailingLineBreaks: 2 } },
    { selector: "h2", options: { uppercase: false, leadingLineBreaks: 2, trailingLineBreaks: 2 } },
    { selector: "h3", options: { uppercase: false, leadingLineBreaks: 2, trailingLineBreaks: 2 } },
    { selector: "h4", options: { uppercase: false, leadingLineBreaks: 2, trailingLineBreaks: 2 } },
    { selector: "h5", options: { uppercase: false, leadingLineBreaks: 2, trailingLineBreaks: 2 } },
    { selector: "h6", options: { uppercase: false, leadingLineBreaks: 2, trailingLineBreaks: 2 } },
    { selector: "p", options: { leadingLineBreaks: 2, trailingLineBreaks: 2 } },
    { selector: "div", options: { leadingLineBreaks: 2, trailingLineBreaks: 2 } },
    { selector: "br", options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
  ],
  limits: {
    maxInputLength: undefined,
  },
});

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeEpubText(text) {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeInlineMarkupOptions(options = {}) {
  const inlineMarkup = options.inlineMarkup || options;
  return {
    ruby: inlineMarkup.ruby !== false,
    bold: inlineMarkup.bold !== false,
  };
}

function normalizePreservedInlineMarkup(text, options = {}) {
  const keep = normalizeInlineMarkupOptions(options);
  return String(text || "")
    .replace(/<\s*(ruby|rt|b)\b[^>]*>/gi, (match, tag) => {
      const normalized = tag.toLowerCase();
      if ((normalized === "ruby" || normalized === "rt") && keep.ruby) return `<${normalized}>`;
      if (normalized === "b" && keep.bold) return "<b>";
      return "";
    })
    .replace(/<\s*\/\s*(ruby|rt|b)\s*>/gi, (match, tag) => {
      const normalized = tag.toLowerCase();
      if ((normalized === "ruby" || normalized === "rt") && keep.ruby) return `</${normalized}>`;
      if (normalized === "b" && keep.bold) return "</b>";
      return "";
    })
    .replace(/<(?!\/?(?:ruby|rt|b)>)[^>]+>/gi, "");
}

function epubHtmlToText(html, options = {}) {
  return normalizePreservedInlineMarkup(htmlToTextWithInlineMarkup(html), options);
}

function epubPathJoin(base, href) {
  const normalizedBase = base.replace(/\\/g, "/");
  const normalizedHref = href.replace(/\\/g, "/");
  const dir = normalizedBase.includes("/") ? normalizedBase.slice(0, normalizedBase.lastIndexOf("/") + 1) : "";
  const parts = `${dir}${normalizedHref}`.split("/");
  const out = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function stripFragment(href) {
  return String(href || "").split("#")[0];
}

function normalizeHrefPath(href) {
  return stripFragment(href).replace(/\\/g, "/").toLowerCase();
}

function textContent(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textContent).join(" ");
  if (typeof value === "object") {
    return Object.entries(value)
      .filter(([key]) => !["href", "src"].includes(key))
      .map(([, child]) => textContent(child))
      .join(" ");
  }
  return "";
}

function collectNavLinks(node, links = []) {
  if (node == null) return links;
  if (Array.isArray(node)) {
    for (const item of node) collectNavLinks(item, links);
    return links;
  }
  if (typeof node !== "object") return links;

  if (node.a?.href) {
    links.push({
      href: node.a.href,
      label: normalizeEpubText(textContent(node.a)),
    });
  }
  for (const child of Object.values(node)) collectNavLinks(child, links);
  return links;
}

function findNavDocument(manifest) {
  return manifest.find((item) => String(item.properties || "").split(/\s+/).includes("nav"));
}

function isNonBodyNavLabel(label) {
  return /後記|后记|あとがき|特典|番外|extra|bonus|版權|版权|colophon|copyright|cover|書封|封面|目錄|目录|contents|制作信息|簡介|简介/i.test(label);
}

function isBodyNavLabel(label) {
  if (!label || isNonBodyNavLabel(label)) return false;
  return /序|章|行間|行间|終章|终章|prologue|chapter|epilogue|between/i.test(label);
}

function looksLikeFrontMatter(text) {
  const compact = normalizeEpubText(text).replace(/\s+/g, " ");
  if (!compact) return true;
  if (Array.from(compact).length < 30) return true;
  return /^(contents|目錄|目录|ＣＯＮＴＥＮＴＳ|navigation|本電子書籍|本电子书籍|Kadokawa|暗部共生少女\s*1?$)/i.test(compact);
}

function meaningfulBlocks(text) {
  return normalizeEpubText(text)
    .split(/\n\s*\n+/)
    .map((block) => block.replace(/\s+/g, " ").trim())
    .filter((block) => Array.from(block).length >= 2);
}

function firstMeaningfulBlock(text) {
  return meaningfulBlocks(text)[0] || "";
}

function looksLikeBackMatterStart(text) {
  const first = firstMeaningfulBlock(text);
  return /^(後記|后记|あとがき|特典|電子書特典|番外|extra|bonus|版權頁|版权页|colophon|copyright|Kadokawa Fantastic Novels)(?:\s|$|[：:])/i.test(first);
}

async function spineTextPreview(zip, itemPath, options = {}) {
  const htmlFile = zip.file(itemPath);
  if (!htmlFile) return "";
  return normalizeEpubText(epubHtmlToText(await htmlFile.async("string"), options));
}

function countMatches(text, regex) {
  return (text.match(regex) || []).length;
}

function textLength(text) {
  return Array.from(text.replace(/\s+/g, "")).length;
}

function isTextDense(block) {
  const length = textLength(block);
  if (length < 20) return false;
  const punctuation = countMatches(block, /[。．.!！？?」』”’）)]/g);
  return length >= 80 || punctuation >= 2;
}

function looksLikeCopyrightOrProduction(text) {
  const compact = normalizeEpubText(text).replace(/\s+/g, " ");
  if (!compact) return false;
  return /©|copyright|all rights reserved|isbn|kadokawa|出版|發行|发行|著者|作者|譯者|译者|校[對对]|製作|制作|電子書籍|电子书|本電子書|本电子书|無断転載|版权所有|版權所有|版权页|版權頁/i.test(compact);
}

function analyzeSpineDocument(rawHtml, text, labels) {
  const blocks = meaningfulBlocks(text);
  const compact = normalizeEpubText(text).replace(/\s+/g, " ");
  const length = textLength(compact);
  const denseBlocks = blocks.filter(isTextDense).length;
  const sentenceMarks = countMatches(compact, /[。．.!！？?]/g);
  const dialogueMarks = countMatches(compact, /[「『]/g);
  const linkCount = countMatches(rawHtml, /<\s*a\b/gi);
  const imageCount = countMatches(rawHtml, /<\s*img\b|<\s*image\b/gi);
  const hasNavMarkup = /<\s*nav\b|epub:type\s*=\s*["'][^"']*(toc|landmarks|page-list)/i.test(rawHtml);
  const labelText = labels.join(" ");
  const hasBodyLabel = labels.some(isBodyNavLabel);
  const hasNonBodyLabel = labels.some(isNonBodyNavLabel);
  const first = firstMeaningfulBlock(text);
  const shortNavigationLike = linkCount >= 4 && length < 1200;
  const leadingText = blocks.slice(0, 4).join(" ");
  const productionLike = looksLikeCopyrightOrProduction(leadingText) && length < 1600;
  const backMatterStart = looksLikeBackMatterStart(text);

  let bodyScore = 0;
  if (length >= 120) bodyScore += 2;
  if (length >= 500) bodyScore += 2;
  if (denseBlocks >= 2) bodyScore += 2;
  if (sentenceMarks >= 3) bodyScore += 1;
  if (dialogueMarks >= 1) bodyScore += 1;
  if (hasBodyLabel) bodyScore += 4;

  let nonBodyScore = 0;
  if (!length) nonBodyScore += 3;
  if (hasNavMarkup || shortNavigationLike) nonBodyScore += 4;
  if (productionLike) nonBodyScore += 4;
  if (backMatterStart) nonBodyScore += 5;
  if (hasNonBodyLabel) nonBodyScore += 6;
  if (/cover|contents|toc|nav|colophon|copyright/i.test(labelText)) nonBodyScore += 2;

  return {
    text,
    labels,
    blocks,
    length,
    denseBlocks,
    sentenceMarks,
    dialogueMarks,
    linkCount,
    imageCount,
    hasBodyLabel,
    hasNonBodyLabel,
    first,
    bodyScore,
    nonBodyScore,
    isEmptyOrImageOnly: length === 0 && imageCount > 0,
    isStructuralOnly: length === 0 || hasNavMarkup || shortNavigationLike,
    isBodyCandidate: bodyScore >= 4 && nonBodyScore < 6,
    isHardEndBoundary: hasNonBodyLabel || backMatterStart || productionLike,
  };
}

async function collectNavLinkInfo(zip, opfPath, manifest, spineItems) {
  const navItem = findNavDocument(manifest);
  if (!navItem) return null;

  const navPath = epubPathJoin(opfPath, navItem.href);
  const navFile = zip.file(navPath);
  if (!navFile) return null;

  const nav = parser.parse(await navFile.async("string"));
  const spineIndexByHref = new Map(spineItems.map((item, index) => [normalizeHrefPath(item.path), index]));
  const spineIndexForHref = (href) => {
    const normalized = normalizeHrefPath(href);
    const exact = spineIndexByHref.get(normalized);
    if (exact != null) return exact;

    const targetBase = path.posix.basename(normalized);
    if (!targetBase) return undefined;
    for (let index = 0; index < spineItems.length; index += 1) {
      const spineBase = path.posix.basename(normalizeHrefPath(spineItems[index].path));
      if (spineBase === targetBase || spineBase.endsWith(targetBase)) return index;
    }
    return undefined;
  };
  const links = collectNavLinks(nav)
    .map((link) => ({
      ...link,
      path: epubPathJoin(navPath, stripFragment(link.href)),
    }))
    .map((link) => ({
      ...link,
      spineIndex: spineIndexForHref(link.path),
    }))
    .filter((link) => link.spineIndex != null);

  return links;
}

function selectBodySpineIndexes(infos) {
  const bodyLabelIndexes = infos
    .map((info, index) => (info.hasBodyLabel ? index : -1))
    .filter((index) => index !== -1);

  if (!bodyLabelIndexes.length) return null;

  let start = Math.min(...bodyLabelIndexes);
  for (let index = start - 1; index >= 0; index -= 1) {
    const info = infos[index];
    if (looksLikeFrontMatter(info.text) || info.isStructuralOnly || info.isHardEndBoundary) break;
    start = index;
  }

  let end = infos.length;
  for (let index = start + 1; index < infos.length; index += 1) {
    const info = infos[index];
    if (info.isHardEndBoundary) {
      end = index;
      break;
    }
  }

  const indexes = new Set();
  for (let index = start; index < end; index += 1) {
    const info = infos[index];
    if (!info.text || info.isStructuralOnly || info.isHardEndBoundary) continue;
    indexes.add(index);
  }
  return indexes.size ? indexes : null;
}

async function readEpubTextWithPandoc(file, options = {}) {
  const html = await readWithPandoc(file, { from: "epub", to: "html" });
  const text = normalizeEpubText(epubHtmlToText(html, options));
  if (!text) throw new Error(`Pandoc produced empty text for ${file}`);
  return text;
}

async function readEpubTextFromSpine(file, options = {}) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const containerFile = zip.file("META-INF/container.xml");
  if (!containerFile) throw new Error(`Missing META-INF/container.xml in ${file}`);

  const container = parser.parse(await containerFile.async("string"));
  const rootfile = asArray(container.container?.rootfiles?.rootfile)[0];
  const opfPath = rootfile?.["full-path"];
  if (!opfPath) throw new Error(`Cannot find OPF path in ${file}`);

  const opfFile = zip.file(opfPath);
  if (!opfFile) throw new Error(`Missing OPF file ${opfPath} in ${file}`);

  const opf = parser.parse(await opfFile.async("string"));
  const manifest = asArray(opf.package?.manifest?.item);
  const spine = asArray(opf.package?.spine?.itemref);
  const byId = new Map(manifest.map((item) => [item.id, item]));
  const spineItems = spine
    .map((ref) => {
      if (String(ref.linear || "yes").toLowerCase() === "no") return null;
      const item = byId.get(ref.idref);
      if (!item || !/x?html/i.test(item["media-type"] || "")) return null;
      return {
        ref,
        item,
        path: epubPathJoin(opfPath, item.href),
      };
    })
    .filter(Boolean);
  const navLinks = await collectNavLinkInfo(zip, opfPath, manifest, spineItems);
  const labelsBySpineIndex = new Map();
  for (const link of navLinks || []) {
    if (!labelsBySpineIndex.has(link.spineIndex)) labelsBySpineIndex.set(link.spineIndex, []);
    labelsBySpineIndex.get(link.spineIndex).push(link.label);
  }
  const spineInfos = [];
  for (const item of spineItems) {
    const htmlFile = zip.file(item.path);
    const rawHtml = htmlFile ? await htmlFile.async("string") : "";
    const text = normalizeEpubText(epubHtmlToText(rawHtml, options));
    const index = spineInfos.length;
    const labels = labelsBySpineIndex.get(index) || [];
    spineInfos.push(analyzeSpineDocument(rawHtml, text, labels));
  }
  const bodyIndexes = selectBodySpineIndexes(spineInfos);
  const chunks = [];

  for (let index = 0; index < spineInfos.length; index += 1) {
    if (bodyIndexes && !bodyIndexes.has(index)) continue;
    const text = spineInfos[index].text;
    if (text) chunks.push(text);
  }

  return normalizeEpubText(chunks.join("\n\n"));
}

async function readEpubText(file, options = {}) {
  const converter = (process.env.TRANSCOMPARATOR_EPUB_CONVERTER || "auto").toLowerCase();

  if (converter !== "internal") {
    try {
      return await readEpubTextWithPandoc(file, options);
    } catch (error) {
      if (converter === "pandoc") throw error;
      if (error?.code && error.code !== "ENOENT") throw error;
      console.warn("Pandoc not found; using built-in EPUB OPF/nav/spine reader.");
    }
  }

  return readEpubTextFromSpine(file, options);
}

module.exports = {
  readEpubText,
  readEpubTextFromSpine,
  readEpubTextWithPandoc,
};
