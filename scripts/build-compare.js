const fs = require("fs");
const path = require("path");
const { outputDir, toCn, loadParagraphs } = require("./text-utils");
const { resolveInputSelection } = require("./input-selection");
const { providerDefaults, proofreadPromptFor } = require("./ai-proofread");
const { createProjectContext, rowSignature } = require("./project-context");
const { publishProject } = require("./project-store");

const workbenchStyle = fs.readFileSync(path.join(__dirname, "..", "public", "workbench-style.css"), "utf8");
const workbenchClient = fs.readFileSync(path.join(__dirname, "..", "public", "workbench-client.js"), "utf8");
const progressPrefix = "@@transcomparator-progress@@";

function reportProgress(percent, label, current = 0, total = 0) {
  if (process.env.TRANS_COMPARATOR_MACHINE_PROGRESS !== "1") return;
  console.log(`${progressPrefix}${JSON.stringify({ percent, label, current, total })}`);
}

function resolveModelOptions(models, selected = "") {
  const values = [];
  const seen = new Set();
  for (const model of models || []) {
    const value = String(typeof model === "string" ? model : model?.id || "").trim();
    if (!value || value === "custom" || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }

  const current = String(selected || "").trim();
  return {
    models: values,
    options: [...values, "custom"],
    selected: seen.has(current) ? current : values[0] || "custom",
  };
}

function normalizeApiBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function restorableModelOptions(saved) {
  if (!saved || typeof saved !== "object") return [];
  const baseUrl = normalizeApiBaseUrl(saved.baseUrl);
  const optionsBaseUrl = normalizeApiBaseUrl(saved.modelOptionsBaseUrl);
  if (!baseUrl || !optionsBaseUrl || baseUrl !== optionsBaseUrl) return [];
  return Array.isArray(saved.modelOptions)
    ? saved.modelOptions.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

const fallbackPgaTemplate = `<?xml version="1.0" encoding="UTF-8"?>
<pgr:powergrep xmlns:pgr="http://www.powergrep.com/powergrep52.xsd" version="5.2">
\t<actionfile>
\t\t<action actiontype="replace" searchtype="regex list" concurrent="1" targettype="same" backuptype="none">
\t\t\t<searchtext></searchtext>
\t\t\t<replacetext></replacetext>
\t\t\t<sectioning sectiontype="whole file"/>
\t\t\t<context contexttype="line" numbering="1" extra="context"/>
\t\t</action>
\t</actionfile>
</pgr:powergrep>
`;

function loadPgaTemplate() {
  const configuredPath = process.env.TRANS_COMPARATOR_PGA_TEMPLATE;
  const homeDir = process.env.USERPROFILE || process.env.HOME || "";
  const templatePath = configuredPath
    ? path.resolve(configuredPath)
    : path.join(homeDir, "Desktop", "替换.pga");
  if (!templatePath || !fs.existsSync(templatePath)) return fallbackPgaTemplate;
  return fs.readFileSync(templatePath, "utf8").replace(/^\uFEFF/, "");
}

function normalizeZh(text) {
  return toCn(text)
    .toLowerCase()
    .replace(/[「」『』“”‘’（）()【】《》〈〉—\-─…、，。！？：；,.!?;:\s0-9a-z]/g, "");
}

function bigrams(text) {
  const chars = Array.from(normalizeZh(text));
  if (chars.length < 2) return new Set(chars);
  const grams = new Set();
  for (let i = 0; i < chars.length - 1; i += 1) grams.add(chars[i] + chars[i + 1]);
  return grams;
}

function similarity(a, b) {
  const aSet = bigrams(a);
  const bSet = bigrams(b);
  if (!aSet.size && !bSet.size) return 1;
  if (!aSet.size || !bSet.size) return 0;

  let intersection = 0;
  for (const gram of aSet) {
    if (bSet.has(gram)) intersection += 1;
  }
  return intersection / (aSet.size + bSet.size - intersection);
}

function lengthScore(a, b) {
  const aLen = Math.max(1, Array.from(normalizeZh(a)).length);
  const bLen = Math.max(1, Array.from(normalizeZh(b)).length);
  return Math.min(aLen, bLen) / Math.max(aLen, bLen);
}

function paragraphScore(a, b) {
  if (!a || !b) return 0;
  return (similarity(a, b) * 0.72) + (lengthScore(a, b) * 0.28);
}

function splitComparableUnits(text) {
  const normalized = String(text || "").replace(/\r\n?/g, "\n");
  const sentenceEnd = new Set(["。", "！", "？", "!", "?"]);
  const closers = new Set(["」", "』", "）", ")", "】"]);
  const units = [];
  let buffer = "";

  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    buffer += char;
    if (!sentenceEnd.has(char)) continue;

    while (i + 1 < normalized.length && (sentenceEnd.has(normalized[i + 1]) || closers.has(normalized[i + 1]))) {
      i += 1;
      buffer += normalized[i];
    }

    const trimmed = buffer.trim();
    if (trimmed) units.push(trimmed);
    buffer = "";
  }

  const tail = buffer.trim();
  if (tail) units.push(tail);
  return units;
}

function makeFragmentItem(text, base) {
  return {
    sourceIndex: base?.sourceIndex ?? null,
    lang: base?.lang || "",
    chapter: base?.chapter || "",
    text,
    cnText: base?.lang === "tw" ? toCn(text) : text,
    chars: Array.from(text).length,
  };
}

function splitGroupItems(items) {
  const result = [];
  for (const item of items) {
    const units = splitComparableUnits(item.text);
    if (units.length <= 1) {
      result.push(item);
      continue;
    }
    for (const unit of units) result.push(makeFragmentItem(unit, item));
  }
  return result;
}

function joinTexts(items, field = "text") {
  return items.filter(Boolean).map((item) => item[field] || "").filter(Boolean).join("\n\n");
}

function sumChars(items) {
  return items.filter(Boolean).reduce((sum, item) => sum + (item.chars || 0), 0);
}

function alignPair(left, right, band = 60) {
  const n = left.length;
  const m = right.length;
  const neg = -1e9;
  const gapPenalty = -0.18;
  const dp = Array.from({ length: n + 1 }, () => new Float32Array(m + 1).fill(neg));
  const trace = Array.from({ length: n + 1 }, () => new Int8Array(m + 1));

  dp[0][0] = 0;
  for (let i = 1; i <= n; i += 1) {
    if (Math.abs(i - 0) <= band) {
      dp[i][0] = dp[i - 1][0] + gapPenalty;
      trace[i][0] = 2;
    }
  }
  for (let j = 1; j <= m; j += 1) {
    if (Math.abs(0 - j) <= band) {
      dp[0][j] = dp[0][j - 1] + gapPenalty;
      trace[0][j] = 3;
    }
  }

  for (let i = 1; i <= n; i += 1) {
    const jStart = Math.max(1, i - band);
    const jEnd = Math.min(m, i + band);
    for (let j = jStart; j <= jEnd; j += 1) {
      const match = dp[i - 1][j - 1] + paragraphScore(left[i - 1].text, right[j - 1].text);
      const del = dp[i - 1][j] + gapPenalty;
      const ins = dp[i][j - 1] + gapPenalty;
      if (match >= del && match >= ins) {
        dp[i][j] = match;
        trace[i][j] = 1;
      } else if (del >= ins) {
        dp[i][j] = del;
        trace[i][j] = 2;
      } else {
        dp[i][j] = ins;
        trace[i][j] = 3;
      }
    }
  }

  const pairs = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const step = trace[i][j];
    if (step === 1) {
      pairs.push([left[i - 1], right[j - 1], paragraphScore(left[i - 1].text, right[j - 1].text)]);
      i -= 1;
      j -= 1;
    } else if (step === 2) {
      pairs.push([left[i - 1], null, 0]);
      i -= 1;
    } else if (step === 3) {
      pairs.push([null, right[j - 1], 0]);
      j -= 1;
    } else {
      if (i > 0 && j > 0) {
        pairs.push([left[i - 1], right[j - 1], paragraphScore(left[i - 1].text, right[j - 1].text)]);
        i -= 1;
        j -= 1;
      } else if (i > 0) {
        pairs.push([left[i - 1], null, 0]);
        i -= 1;
      } else {
        pairs.push([null, right[j - 1], 0]);
        j -= 1;
      }
    }
  }
  return pairs.reverse();
}

function groupText(items, lang) {
  if (lang === "twCn") return joinTexts(items, "cnText");
  return joinTexts(items, "text");
}

function groupScore(left, right) {
  if (!left.length || !right.length) return -0.22;
  const score = paragraphScore(groupText(left, "cn"), groupText(right, "twCn"));
  const mergePenalty = 0.03 * Math.max(0, left.length + right.length - 2);
  return score - mergePenalty;
}

function textLengthForAnchor(text) {
  return Array.from(normalizeZh(text)).length;
}

function bestRightForLeft(left, right, i, radius) {
  let best = null;
  const start = Math.max(0, i - radius);
  const end = Math.min(right.length - 1, i + radius);
  for (let j = start; j <= end; j += 1) {
    const score = paragraphScore(left[i].text, right[j].cnText);
    if (!best || score > best.score) best = { j, score };
  }
  return best;
}

function bestLeftForRight(left, right, j, radius) {
  let best = null;
  const start = Math.max(0, j - radius);
  const end = Math.min(left.length - 1, j + radius);
  for (let i = start; i <= end; i += 1) {
    const score = paragraphScore(left[i].text, right[j].cnText);
    if (!best || score > best.score) best = { i, score };
  }
  return best;
}

function findLocalAnchors(left, right, radius = 6) {
  const anchors = [];
  let lastI = -1;
  let lastJ = -1;

  for (let i = 0; i < left.length; i += 1) {
    if (textLengthForAnchor(left[i].text) < 10) continue;
    const bestRight = bestRightForLeft(left, right, i, radius);
    if (!bestRight || bestRight.score < 0.34) continue;
    if (textLengthForAnchor(right[bestRight.j].cnText) < 10) continue;

    const bestLeft = bestLeftForRight(left, right, bestRight.j, radius);
    if (!bestLeft || bestLeft.i !== i) continue;
    if (i <= lastI || bestRight.j <= lastJ) continue;

    anchors.push({ i, j: bestRight.j, score: bestRight.score });
    lastI = i;
    lastJ = bestRight.j;
  }

  return anchors;
}

function alignGroupsCore(left, right, band = 60) {
  const n = left.length;
  const m = right.length;
  const moves = [[1, 1], [1, 2], [2, 1], [2, 2], [1, 0], [0, 1]];
  const neg = -1e9;
  const dp = Array.from({ length: n + 1 }, () => new Float32Array(m + 1).fill(neg));
  const trace = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => null));

  dp[0][0] = 0;
  for (let i = 0; i <= n; i += 1) {
    const expected = Math.round((i / Math.max(1, n)) * m);
    const jStart = Math.max(0, expected - band);
    const jEnd = Math.min(m, expected + band);

    for (let j = jStart; j <= jEnd; j += 1) {
      if (dp[i][j] <= neg / 2) continue;

      for (const [li, rj] of moves) {
        const ni = i + li;
        const nj = j + rj;
        if (ni > n || nj > m) continue;

        const nextExpected = Math.round((ni / Math.max(1, n)) * m);
        if (Math.abs(nj - nextExpected) > band) continue;

        const score = groupScore(left.slice(i, ni), right.slice(j, nj));
        const candidate = dp[i][j] + score;
        if (candidate > dp[ni][nj]) {
          dp[ni][nj] = candidate;
          trace[ni][nj] = [li, rj, score];
        }
      }
    }
  }

  const groups = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    let step = trace[i][j];
    if (!step) {
      step = i > 0 && j > 0 ? [1, 1, groupScore(left.slice(i - 1, i), right.slice(j - 1, j))]
        : i > 0 ? [1, 0, groupScore(left.slice(i - 1, i), [])]
          : [0, 1, groupScore([], right.slice(j - 1, j))];
    }

    const [li, rj, score] = step;
    const leftStart = i - li;
    const rightStart = j - rj;
    groups.push({
      left: left.slice(leftStart, i),
      right: right.slice(rightStart, j),
      score,
      relation: `${li}:${rj}`,
    });
    i = leftStart;
    j = rightStart;
  }

  return groups.reverse();
}

function alignGroups(left, right, band = 60) {
  const anchors = findLocalAnchors(left, right);
  if (!anchors.length) return alignGroupsCore(left, right, band);

  const groups = [];
  let leftStart = 0;
  let rightStart = 0;

  for (const anchor of anchors) {
    if (anchor.i > leftStart || anchor.j > rightStart) {
      groups.push(...alignGroupsCore(left.slice(leftStart, anchor.i), right.slice(rightStart, anchor.j), band));
    }
    groups.push({
      left: [left[anchor.i]],
      right: [right[anchor.j]],
      score: anchor.score,
      relation: "1:1",
    });
    leftStart = anchor.i + 1;
    rightStart = anchor.j + 1;
  }

  if (leftStart < left.length || rightStart < right.length) {
    groups.push(...alignGroupsCore(left.slice(leftStart), right.slice(rightStart), band));
  }

  return groups;
}

function alignRows(cn, tw, jp, comparisonMode = "trilingual") {
  const cnTw = alignGroups(cn, tw).map((group) => ({
    ...group,
    cnStart: group.left[0]?.sourceIndex ?? null,
    cnEnd: group.left.length ? group.left[group.left.length - 1].sourceIndex + 1 : null,
    twStart: group.right[0]?.sourceIndex ?? null,
    twEnd: group.right.length ? group.right[group.right.length - 1].sourceIndex + 1 : null,
  }));
  const jpPivotGroups = loadJpGroupAlignmentList(jp);
  const pivotLang = loadJpPivotLang(comparisonMode);
  const rows = [];

  for (let i = 0; i < cnTw.length;) {
    const firstGroup = cnTw[i];
    const firstStart = groupPivotStart(firstGroup, pivotLang);
    const firstEnd = groupPivotEnd(firstGroup, pivotLang);
    if (firstStart == null || firstEnd == null) {
      i += 1;
      continue;
    }

    const firstJpGroups = jpPivotGroups.filter((group) => rangesOverlap(firstStart, firstEnd, group.pivotStart, group.pivotEnd));
    if (!firstJpGroups.length) {
      i += 1;
      continue;
    }

    let unionStart = Math.min(firstStart, ...firstJpGroups.map((group) => group.pivotStart));
    let unionEnd = Math.max(firstEnd, ...firstJpGroups.map((group) => group.pivotEnd));
    let endIndex = i + 1;
    let changed = true;

    while (changed) {
      changed = false;
      for (const jpGroup of jpPivotGroups) {
        if (rangesOverlap(unionStart, unionEnd, jpGroup.pivotStart, jpGroup.pivotEnd)) {
          const nextStart = Math.min(unionStart, jpGroup.pivotStart);
          const nextEnd = Math.max(unionEnd, jpGroup.pivotEnd);
          if (nextStart !== unionStart || nextEnd !== unionEnd) {
            unionStart = nextStart;
            unionEnd = nextEnd;
            changed = true;
          }
        }
      }

      while (endIndex < cnTw.length) {
        const nextGroup = cnTw[endIndex];
        const nextStart = groupPivotStart(nextGroup, pivotLang);
        const nextEnd = groupPivotEnd(nextGroup, pivotLang);
        if (nextStart == null || nextEnd == null) {
          endIndex += 1;
          continue;
        }
        if (nextStart >= unionEnd) break;
        unionStart = Math.min(unionStart, nextStart);
        unionEnd = Math.max(unionEnd, nextEnd);
        endIndex += 1;
        changed = true;
      }
    }

    const cnGroups = cnTw.slice(i, endIndex)
      .filter((group) => groupPivotStart(group, pivotLang) != null && groupPivotEnd(group, pivotLang) != null)
      .filter((group) => rangesOverlap(groupPivotStart(group, pivotLang), groupPivotEnd(group, pivotLang), unionStart, unionEnd));
    const jpGroups = jpPivotGroups.filter((group) => rangesOverlap(unionStart, unionEnd, group.pivotStart, group.pivotEnd));
    if (jpGroups.length) {
      rows.push(makeRow(rows.length + 1, cnGroups, jpGroups, comparisonMode));
    }
    i = endIndex;
  }

  return rows;
}

function groupPivotStart(group, pivotLang) {
  return pivotLang === "cn" ? group.cnStart : group.twStart;
}

function groupPivotEnd(group, pivotLang) {
  return pivotLang === "cn" ? group.cnEnd : group.twEnd;
}

function makeRow(index, cnGroups, jpGroups, comparisonMode = "trilingual") {
    const bilingual = comparisonMode === "bilingual";
    const cnItems = cnGroups.flatMap((group) => group.left);
    const twItems = cnGroups.flatMap((group) => group.right);
    const jpItems = uniqueBySourceIndex(jpGroups.flatMap((group) => group.items));
    const cnText = groupText(cnItems, "cn");
    const twText = groupText(twItems, "tw");
    const twCnText = groupText(twItems, "twCn");
    const baseScore = cnText && twCnText ? paragraphScore(cnText, twCnText) : 0;
    const refined = refineLowConfidenceGroups(cnItems, twItems, baseScore);
    const jpText = joinTexts(jpItems, "text");
    const chapter = cnItems[0]?.chapter || twItems[0]?.chapter || jpItems[0]?.chapter || "";
    const cnRelation = refined ? `细分 ${refined.relation}` : relationSummary(cnGroups, "left", "right");
    const jpRelation = jpGroups.length ? relationSummary(jpGroups, "items", "pivotItems") : "";
    const jpScore = average(jpGroups.map((group) => group.score));

    return {
      index,
      chapter,
      relation: bilingual
        ? `原文-译文 ${jpRelation || relationSummary(jpGroups, "items", "pivotItems")}`
        : `简台 ${cnRelation}${jpRelation ? ` / 日文 ${jpRelation}` : ""}`,
      jp: jpText,
      jpAlignScore: jpGroups.length ? jpScore : null,
      cn: refined?.cnText ?? cnText,
      tw: refined?.twText ?? twText,
      twCn: refined?.twCnText ?? twCnText,
      score: bilingual ? jpScore : (refined?.score ?? baseScore),
      refinedScore: refined?.averageMatched ?? null,
      cnChars: sumChars(cnItems),
      twChars: sumChars(twItems),
      jpChars: sumChars(jpItems),
    };
}

function pivotLabel(pivotLang, labels) {
  return pivotLang === "cn" ? labels.cn : labels.tw;
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function uniqueBySourceIndex(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (!item || seen.has(item.sourceIndex)) continue;
    seen.add(item.sourceIndex);
    result.push(item);
  }
  return result;
}

function relationSummary(groups, leftKey, rightKey) {
  const leftCount = groups.reduce((sum, group) => sum + group[leftKey].length, 0);
  const rightCount = groups.reduce((sum, group) => sum + group[rightKey].length, 0);
  if (groups.length === 1 && groups[0].relation) return groups[0].relation;
  return `${leftCount}:${rightCount}`;
}

function refineLowConfidenceGroups(cnItems, twItems, baseScore) {
  if (baseScore >= 0.22 || !cnItems.length || !twItems.length) return null;

  const cnFragments = splitGroupItems(cnItems);
  const twFragments = splitGroupItems(twItems);
  if (cnFragments.length === cnItems.length && twFragments.length === twItems.length) return null;
  if (cnFragments.length > 8 || twFragments.length > 8) return null;

  const refinedGroups = alignGroupsCore(cnFragments, twFragments, 8);
  const refinedScore = paragraphScore(groupText(cnFragments, "cn"), groupText(twFragments, "twCn"));
  const matchedScores = refinedGroups
    .filter((group) => group.left.length && group.right.length)
    .map((group) => paragraphScore(groupText(group.left, "cn"), groupText(group.right, "twCn")));
  const averageMatched = average(matchedScores) ?? 0;

  if (averageMatched < Math.max(0.26, baseScore + 0.12)) return null;

  return {
    groups: refinedGroups,
    score: refinedScore,
    relation: relationSummary(refinedGroups, "left", "right"),
    cnText: groupText(cnFragments, "cn"),
    twText: groupText(twFragments, "tw"),
    twCnText: groupText(twFragments, "twCn"),
    averageMatched,
  };
}

function average(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (!filtered.length) return null;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function loadJpAlignment(jp) {
  const alignFile = path.join(outputDir, "jp-align.json");
  const byTw = new Map();
  if (!fs.existsSync(alignFile)) return byTw;

  const data = JSON.parse(fs.readFileSync(alignFile, "utf8"));
  for (const item of data.mapping || []) {
    const current = byTw.get(item.twIndex);
    if (!current || item.score > current.score) {
      byTw.set(item.twIndex, {
        score: item.score,
        jpIndex: item.jpIndex,
        para: jp[item.jpIndex] || null,
      });
    }
  }
  return byTw;
}

function shouldUseJpAlignment(aligned, twPara, fallbackJpIndex) {
  if (!aligned?.para || !twPara) return false;
  if (fallbackJpIndex == null) return false;
  if (twPara.chars < 12 || aligned.para.chars < 12) return false;
  if (Math.abs(aligned.jpIndex - fallbackJpIndex) > 8) return false;
  if (aligned.score >= 0.78) return true;
  return aligned.score >= 0.55;
}

function loadJpGroupAlignment(jp) {
  const alignFile = path.join(outputDir, "jp-align.json");
  const byTwRange = new Map();
  if (!fs.existsSync(alignFile)) return byTwRange;

  const data = JSON.parse(fs.readFileSync(alignFile, "utf8"));
  for (const group of data.groups || []) {
    if (group.jpStart === group.jpEnd || group.twStart === group.twEnd) continue;
    byTwRange.set(`${group.twStart}:${group.twEnd}`, {
      score: group.score,
      relation: group.relation,
      jpStart: group.jpStart,
      jpEnd: group.jpEnd,
      items: jp.slice(group.jpStart, group.jpEnd),
    });
  }
  return byTwRange;
}

function loadJpGroupAlignmentList(jp) {
  const alignFile = path.join(outputDir, "jp-align.json");
  if (!fs.existsSync(alignFile)) return [];

  const data = JSON.parse(fs.readFileSync(alignFile, "utf8"));
  return (data.groups || [])
    .filter((group) => group.jpStart !== group.jpEnd && group.twStart !== group.twEnd)
    .map((group) => ({
      score: group.score,
      relation: group.relation,
      pivotStart: group.pivotStart ?? group.twStart,
      pivotEnd: group.pivotEnd ?? group.twEnd,
      jpStart: group.jpStart,
      jpEnd: group.jpEnd,
      items: jp.slice(group.jpStart, group.jpEnd),
      pivotItems: Array.from(
        { length: (group.pivotEnd ?? group.twEnd) - (group.pivotStart ?? group.twStart) },
        (_, index) => ({ sourceIndex: (group.pivotStart ?? group.twStart) + index })
      ),
    }));
}

function loadJpPivotLang(comparisonMode = "trilingual") {
  if (comparisonMode === "bilingual") return "cn";
  const alignFile = path.join(outputDir, "jp-align.json");
  if (!fs.existsSync(alignFile)) return "tw";

  const data = JSON.parse(fs.readFileSync(alignFile, "utf8"));
  return data.pivotLang || "tw";
}

function shouldUseJpGroupAlignment(aligned, twItems) {
  if (!aligned?.items?.length || !twItems.length) return false;
  if (sumChars(twItems) < 12 || sumChars(aligned.items) < 12) return false;
  if (aligned.score < 0.18) return false;
  return true;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function rowClass(score) {
  if (score >= 0.35) return "ok";
  if (score >= 0.18) return "watch";
  return "review";
}

function makeHtml(rows, selection, projectContext, pgaTemplate) {
  const comparisonMode = selection.comparisonMode === "bilingual" ? "bilingual" : "trilingual";
  const bilingual = comparisonMode === "bilingual";
  const proofreadPrompt = proofreadPromptFor(comparisonMode);
  const generatedAt = new Date(projectContext.generatedAt).toLocaleString("zh-CN", { hour12: false });
  const labels = {
    jp: "日文",
    cn: "简中",
    tw: "台版",
    ...(selection.labels || {}),
  };
  const pivotLang = loadJpPivotLang(comparisonMode);
  const similarityLabel = bilingual ? `${labels.jp}-${labels.cn}` : `${labels.cn}-${labels.tw}`;
  const semanticLabel = `${labels.jp}-${pivotLabel(pivotLang, labels)}`;
  const stats = rows.reduce((acc, row) => {
    const cls = rowClass(row.score);
    acc[cls] += 1;
    acc.total += 1;
    acc.emptySource += row.jp ? 0 : 1;
    acc.scoreSum += row.score || 0;
    return acc;
  }, { total: 0, review: 0, watch: 0, ok: 0, emptySource: 0, scoreSum: 0 });
  const avgScore = stats.total ? stats.scoreSum / stats.total : 0;
  const fileNames = Object.fromEntries(Object.entries(selection.files || {})
    .map(([lang, file]) => [lang, path.basename(file)]));
  const rowsSignature = projectContext.rowsSignature;
  const storageKey = projectContext.notesStorage.key;
  const clientMeta = {
    project: projectContext,
    comparisonMode,
    pageLabels: {
      jp: labels.jp,
      cn: labels.cn,
      tw: labels.tw,
    },
    similarityLabel,
    semanticLabel,
    providerDefaults,
    proofreadPrompt,
    rowsSignature,
    projectKey: projectContext.projectKey,
  };
  const pageLabels = {
    jp: labels.jp,
    cn: labels.cn,
    tw: labels.tw,
  };
  const defaultProofreadMode = comparisonMode;
  const clientRows = rows.map((row) => {
    const cls = rowClass(row.score);
    return {
      ...row,
      signature: rowSignature(row),
      cls,
      scoreText: `${((row.score || 0) * 100).toFixed(0)}%`,
      jpAlignScoreText: row.jpAlignScore == null ? "" : `${(row.jpAlignScore * 100).toFixed(0)}%`,
    };
  });
  const rowsJson = JSON.stringify(clientRows).replace(/</g, "\\u003c");
  const pgaTemplateJson = JSON.stringify(pgaTemplate).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${bilingual ? "双语" : "三语"}翻译对比校对工作台</title>
  <style>${workbenchStyle}</style>
</head>
<body>
  <div class="app-shell mode-${comparisonMode}">
    <header>
      <div class="topbar">
        <div>
          <h1>${bilingual ? "双语" : "三语"}翻译对比校对工作台</h1>
          <div class="subtle">生成时间 ${escapeHtml(generatedAt)} · 平均相似 ${(avgScore * 100).toFixed(0)}% · 空原文 ${stats.emptySource}</div>
          <div class="files" title="原文 A ${escapeHtml(fileNames.jp || "")} · ${bilingual ? "译文 B" : "非原文 B"} ${escapeHtml(fileNames.cn || "")}${bilingual ? "" : ` · 非原文 C ${escapeHtml(fileNames.tw || "")}`} ">
            原文 A ${escapeHtml(fileNames.jp || "")} · ${bilingual ? "译文 B" : "非原文 B"} ${escapeHtml(fileNames.cn || "")}${bilingual ? "" : ` · 非原文 C ${escapeHtml(fileNames.tw || "")}`}
          </div>
        </div>
        <div class="stats" aria-label="校对统计">
          <div class="stat"><strong>${stats.total}</strong>总行</div>
          <div class="stat review" title="相似度低于 18%"><strong>${stats.review}</strong>较低相似度</div>
          <div class="stat watch" title="相似度为 18% 至 35%"><strong>${stats.watch}</strong>中等相似度</div>
          <div class="stat ok" title="相似度不低于 35%"><strong>${stats.ok}</strong>较高相似度</div>
          <div class="stat-divider" aria-hidden="true"></div>
          <div class="stat"><strong id="doneCount">0</strong>人工确认</div>
          <div class="stat"><strong id="aiDoneCount">0</strong>自动结果</div>
        </div>
      </div>
    </header>
    <div class="control-stack">
      <details id="prefilterPanel" class="panel-details" aria-label="预筛选">
        <summary class="panel-summary"><span>预筛选</span><button class="details-toggle" type="button" data-details-toggle aria-label="折叠或展开预筛选"></button></summary>
        <div class="prefilter-body">
          <div class="prefilter-config">
            <div class="ai-field">
              <label for="prefilterSimilarity">${escapeHtml(similarityLabel)}相似度预筛</label>
              <input id="prefilterSimilarity" type="text" inputmode="decimal" value="92%" aria-label="${escapeHtml(similarityLabel)}相似度预筛百分比">
            </div>
            <p class="prefilter-hint">规则预筛统一繁简、全半角、空白和不可见字符；完全一致或两列均空直接通过，结构化内容不一致标记为冲突。相似度预筛只处理足够长的正文，数字或标识符不同、文本过短或长度差异明显时不启用。预筛结果会写入备注，AI 校对会跳过已通过预筛的行。</p>
          </div>
          <div class="prefilter-runbar">
            <div id="prefilterStats" class="prefilter-stats" aria-live="polite">尚未运行预筛选。</div>
            <div class="prefilter-actions">
              <button id="prefilterStart" class="btn btn--primary" type="button">开始预筛</button>
              <button id="prefilterConfirm" class="btn btn--success" type="button" disabled>确认预筛</button>
              <button id="prefilterStop" class="btn btn--danger" type="button" disabled>停止</button>
            </div>
          </div>
        </div>
      </details>
      <div class="filter-bar" aria-label="筛选">
        <input id="query" class="filter-search" type="search" placeholder="搜索原文、译文、备注">
        <div class="filter-groups">
          <div class="segmented" role="group" aria-label="相似度状态">
            <span class="segmented__label">相似度</span>
            <button type="button" class="segmented__btn is-active" data-severity="all">全部</button>
            <button type="button" class="segmented__btn" data-severity="review" title="相似度低于 18%">较低</button>
            <button type="button" class="segmented__btn" data-severity="watch" title="相似度为 18% 至 35%">中等</button>
            <button type="button" class="segmented__btn" data-severity="ok" title="相似度不低于 35%">较高</button>
          </div>
          <div class="segmented" role="group" aria-label="自动分析结果">
            <span class="segmented__label">自动</span>
            <button type="button" class="segmented__btn is-active" data-ai-result="all">全部</button>
            <button type="button" class="segmented__btn" data-ai-result="modify">需改</button>
            <button type="button" class="segmented__btn" data-ai-result="same">不改</button>
            <button type="button" class="segmented__btn" data-ai-result="unclear">待判</button>
          </div>
          <div class="segmented" role="group" aria-label="AI 问题严重程度">
            <span class="segmented__label" title="按 MQM 风格的问题严重程度筛选">分级</span>
            <button type="button" class="segmented__btn is-active" data-issue-severity="all">全部</button>
            <button type="button" class="segmented__btn" data-issue-severity="critical" title="核心意义严重失真，或存在安全、法律等高风险后果">致命</button>
            <button type="button" class="segmented__btn" data-issue-severity="major" title="影响准确性、完整性或可用性">严重</button>
            <button type="button" class="segmented__btn" data-issue-severity="minor" title="不改变意义的局部语言或文体问题">轻微</button>
          </div>
          <button id="prefilterResultFilter" class="chip" type="button" aria-pressed="false" disabled>预筛结果</button>
          <button id="noteFilter" class="chip" type="button" aria-pressed="false">有备注</button>
          <button id="doneFilter" class="chip" type="button" data-mode="open" aria-pressed="false">未人工确认</button>
        </div>
        <button id="clearFilter" class="btn btn--ghost" type="button">清筛选</button>
      </div>
      <div class="action-bar">
        <div class="action-group" aria-label="显示设置">
          <span class="action-group__label">显示</span>
          <label class="toggle-inline"><input id="showSource" type="checkbox" checked>原文</label>
          <label class="toggle-inline"${bilingual ? " hidden" : ""}><input id="showTranslationDiff" type="checkbox" checked>译文差异</label>
          <label class="toggle-inline"><input id="showRevisionDiff" type="checkbox" checked>修改差异</label>
        </div>
        <div class="action-group" aria-label="修改结果操作">
          <span class="action-group__label">修改结果</span>
          <button id="acceptAiSame" class="btn btn--success" type="button">确认自动不改</button>
          <button id="exportNotes" class="btn" type="button">导出修改结果</button>
          <button id="confirmRevisions" class="btn" type="button">确认修改结果</button>
        </div>
      </div>
      <details id="aiPanel" class="panel-details ai-panel" aria-label="AI 校对">
        <summary class="ai-panel-title"><span>AI 辅助校对</span><button class="details-toggle" type="button" data-details-toggle aria-label="折叠或展开 AI 辅助校对"></button></summary>
        <div id="aiConfigSection" class="ai-config-stack">
          <section class="ai-config-band ai-service-band" aria-labelledby="aiServiceLabel">
            <div id="aiServiceLabel" class="ai-config-label">AI 服务</div>
            <div id="aiServiceFields" class="ai-service-fields has-reasoning">
              <div class="ai-field">
                <label for="aiProvider">接口</label>
                <select id="aiProvider">
                  <option value="local">本地默认</option>
                  <option value="claude">Claude</option>
                  <option value="compatible">第三方兼容服务</option>
                </select>
              </div>
              <div class="ai-field">
                <label for="aiBaseUrl">地址</label>
                <input id="aiBaseUrl" type="url" value="${escapeHtml(providerDefaults.local.baseUrl)}">
              </div>
              <div class="ai-field">
                <label for="aiModel">模型</label>
                <div class="ai-model-row">
                  <select id="aiModel">
                    <option value="${escapeHtml(providerDefaults.local.model)}">${escapeHtml(providerDefaults.local.model)}</option>
                  </select>
                  <button id="aiRefreshModels" type="button">刷新</button>
                </div>
              </div>
              <div id="aiReasoningField" class="ai-field">
                <label for="aiReasoningEffort">推理强度</label>
                <select id="aiReasoningEffort" title="非 GPT 模型默认不发送 temperature">
                  <option value="" selected>模型默认</option>
                </select>
              </div>
              <div class="ai-field">
                <label for="aiApiKey">API Key</label>
                <input id="aiApiKey" type="password" autocomplete="off" placeholder="${escapeHtml(providerDefaults.local.apiKeyPlaceholder || "")}">
              </div>
            </div>
          </section>
          <section class="ai-config-band ai-proofread-band" aria-labelledby="aiProofreadLabel">
            <div id="aiProofreadLabel" class="ai-config-label">校对设置</div>
            <div class="ai-proofread-fields">
              <div class="ai-field">
                <label for="aiProofreadMode">校对模式</label>
                <select id="aiProofreadMode" disabled>
                  <option value="${defaultProofreadMode}">${bilingual ? "双语版本校对" : "三语语境校对"}</option>
                </select>
              </div>
              <div class="ai-field">
                <label for="aiTarget">校对列</label>
                <select id="aiTarget"${bilingual ? " disabled" : ""}>
                  <option value="cn">${escapeHtml(labels.cn)}</option>
                  ${bilingual ? "" : `<option value="tw">${escapeHtml(labels.tw)}</option>`}
                </select>
              </div>
              <div class="ai-field">
                <label for="aiConcurrency">并发</label>
                <input id="aiConcurrency" type="number" min="1" max="12" value="3">
              </div>
            </div>
          </section>
        </div>
        <div class="ai-runbar">
          <div class="toggle-row ai-options">
            <label><input id="aiMonitorEnabled" type="checkbox">对话监控</label>
            <label><input id="aiPromptVisible" type="checkbox">内置提示词</label>
          </div>
          <div class="ai-status">
            <div id="aiStatus" title="就绪">就绪</div>
            <div id="aiProgressWrap" class="ai-progress" aria-hidden="true" hidden><span id="aiProgress"></span></div>
          </div>
          <div class="ai-actions">
            <button id="aiStart" class="btn btn--primary" type="button">开始</button>
            <button id="aiStop" class="btn btn--danger" type="button" disabled>停止</button>
            <button id="clearAiLog" class="btn btn--subtle" type="button">清AI记录</button>
          </div>
        </div>
        <details id="aiMonitorSection" class="ai-section" open>
          <summary><span>AI 对话监控 <span id="aiMonitorState" class="ai-monitor-state">尚未启动</span></span><button class="details-toggle" type="button" data-details-toggle aria-label="折叠或展开 AI 对话监控"></button></summary>
          <div class="ai-monitor">
            <div id="aiRequestList" class="ai-request-list">
              <div class="ai-request-empty">启动 AI 校对后，这里会显示程序发给模型的问题和接口等待状态。</div>
            </div>
          </div>
        </details>
        <details id="aiPromptSection" class="ai-section">
          <summary><span>内置提示词</span><button class="details-toggle" type="button" data-details-toggle aria-label="折叠或展开内置提示词"></button></summary>
          <div class="ai-prompt-box">
          <div class="ai-monitor-head">
            <div class="ai-prompt-actions">
              <button id="aiPromptReset" type="button">恢复默认</button>
            </div>
          </div>
          <textarea id="aiPrompt" spellcheck="false">${escapeHtml(proofreadPrompt.system)}</textarea>
          </div>
        </details>
      </details>
    </div>
    <main class="wrap">
      <div class="table-frame">
        <table>
          <thead>
            <tr>
              <th>位置</th>
              <th>${escapeHtml(labels.jp)}</th>
              <th>译文对照</th>
              <th>校对备注</th>
            </tr>
          </thead>
          <tbody>
          </tbody>
        </table>
        <div id="keyboardScrollSpacer" class="keyboard-scroll-spacer" aria-hidden="true"></div>
      </div>
      <div id="paginationBar" class="pagination-bar">
        <div id="paginationStatus">正在准备行数据...</div>
        <div class="pagination-actions">
          <button id="firstPage" type="button">首页</button>
          <button id="prevPage" type="button">上一页</button>
          <label for="pageInput">第</label>
          <input id="pageInput" type="number" min="1" value="1" aria-label="页码">
          <span id="pageTotal">/ 1 页</span>
          <button id="nextPage" type="button">下一页</button>
          <button id="lastPage" type="button">末页</button>
        </div>
        <label class="pagination-size" for="pageSize">
          <span>每页</span>
          <select id="pageSize">
            <option value="50">50 行</option>
            <option value="100" selected>100 行</option>
            <option value="200">200 行</option>
            <option value="500">500 行</option>
          </select>
        </label>
      </div>
      <div id="emptyState" class="empty-state">没有匹配的行</div>
    </main>
  </div>
  <script id="rowData" type="application/json">${rowsJson}</script>
  <script>
    ${resolveModelOptions.toString()}
    ${normalizeApiBaseUrl.toString()}
    ${restorableModelOptions.toString()}

    const storageKey = ${JSON.stringify(storageKey)};
    const pageMeta = ${JSON.stringify(clientMeta)};
    const pgaTemplate = ${pgaTemplateJson};
${workbenchClient}</script>
</body>
</html>`;
}

function toCsv(rows, comparisonMode = "trilingual") {
  const cols = comparisonMode === "bilingual"
    ? ["index", "chapter", "relation", "score", "jpAlignScore", "jp", "cn"]
    : ["index", "chapter", "relation", "score", "jpAlignScore", "jp", "cn", "tw", "twCn"];
  const escapeCsv = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  return [
    cols.join(","),
    ...rows.map((row) => cols.map((col) => escapeCsv(row[col])).join(",")),
  ].join("\n");
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });

  reportProgress(5, "读取段落与对齐结果");
  const selection = await resolveInputSelection({ allowPrompt: false });
  const { tw, cn, jp } = await loadParagraphs(selection);
  reportProgress(28, "合并非原文对齐组");
  const rows = alignRows(cn, tw, jp, selection.comparisonMode);
  reportProgress(58, "整理比较行", rows.length, rows.length);
  const projectContext = createProjectContext(selection, rows);
  const pgaTemplate = loadPgaTemplate();

  reportProgress(70, "渲染工作台页面");
  const html = makeHtml(rows, selection, projectContext, pgaTemplate);
  fs.writeFileSync(path.join(outputDir, "translation-compare.html"), html, "utf8");
  reportProgress(86, "写入导出文件");
  fs.writeFileSync(path.join(outputDir, "translation-compare.csv"), toCsv(rows, selection.comparisonMode), "utf8");
  const rowsWithSignature = rows.map((row) => ({ ...row, signature: rowSignature(row) }));
  fs.writeFileSync(path.join(outputDir, "translation-compare.json"), JSON.stringify({
    project: projectContext,
    files: selection.files,
    labels: selection.labels,
    counts: { jp: jp.length, cn: cn.length, tw: tw.length },
    rowsSignature: projectContext.rowsSignature,
    rows: rowsWithSignature,
  }, null, 2), "utf8");
  reportProgress(100, "比较工作台构建完成", rows.length, rows.length);

  const published = process.env.TRANSCOMPARATOR_OUTPUT_DIR
    ? null
    : publishProject(outputDir);

  console.log(`JP paragraphs: ${jp.length}`);
  console.log(`CN paragraphs: ${cn.length}`);
  console.log(`TW paragraphs: ${tw.length}`);
  if (published) {
    console.log(`Published project: ${published.id} (${published.outputUrl})`);
  } else {
    console.log(`HTML: ${path.join(outputDir, "translation-compare.html")}`);
    console.log(`CSV: ${path.join(outputDir, "translation-compare.csv")}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  alignRows,
  makeHtml,
  restorableModelOptions,
  resolveModelOptions,
  toCsv,
};
