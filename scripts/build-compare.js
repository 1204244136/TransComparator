const fs = require("fs");
const path = require("path");
const { outputDir, toCn, loadParagraphs } = require("./text-utils");
const { resolveInputSelection } = require("./input-selection");
const { providerDefaults, proofreadPromptFor } = require("./ai-proofread");
const { createProjectContext, rowSignature } = require("./project-context");
const { publishProject } = require("./project-store");

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
  <style>
    :root {
      color-scheme: light;
      --bg: #f3f5f8;
      --surface: #ffffff;
      --surface-subtle: #f8fafc;
      --head: #eef2f6;
      --line: #d8e0ea;
      --line-strong: #b8c4d4;
      --text: #182230;
      --muted: #667085;
      --muted-2: #8a95a6;
      --focus: #245fb8;
      --focus-hover: #1d4f9a;
      --review: #fff1f0;
      --review-strong: #bd2b22;
      --watch: #fff7df;
      --watch-strong: #9a6700;
      --ok: #edf8f1;
      --ok-strong: #157a3a;
      --info: #eef5ff;
      --radius: 6px;
      --shadow-panel: 0 1px 2px rgba(16, 24, 40, 0.04);
    }
    * { box-sizing: border-box; }
    html {
      background: var(--bg);
    }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif;
      font-size: 15px;
      line-height: 1.7;
      text-wrap: pretty;
    }
    .app-shell {
      min-width: 980px;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 5;
      padding: 12px 18px 11px;
      border-bottom: 1px solid var(--line);
      background: #f5f7fa;
    }
    .topbar {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) auto;
      gap: 16px;
      align-items: center;
    }
    h1 {
      margin: 0 0 4px;
      font-size: 18px;
      line-height: 1.3;
      letter-spacing: 0;
    }
    .subtle {
      color: var(--muted);
      font-size: 13px;
    }
    .files {
      margin-top: 5px;
      color: var(--muted-2);
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 760px;
    }
    .stats {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 6px;
      max-width: 520px;
    }
    .stat {
      min-width: 76px;
      padding: 6px 8px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
      font-size: 12px;
      line-height: 1.25;
      box-shadow: var(--shadow-panel);
    }
    .stat strong {
      display: block;
      color: var(--text);
      font-size: 16px;
      line-height: 1.2;
    }
    .stat.review { background: var(--review); border-color: #f1b6b0; }
    .stat.watch { background: var(--watch); border-color: #ead08d; }
    .stat.ok { background: var(--ok); border-color: #b8dec5; }
    .stat-divider {
      align-self: stretch;
      width: 1px;
      margin: 2px 2px;
      background: var(--line-strong);
    }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(280px, 1fr) minmax(540px, auto) auto;
      gap: 10px;
      margin-top: 11px;
      padding-top: 11px;
      border-top: 1px solid var(--line);
      align-items: start;
    }
    input, select, button, textarea {
      height: 32px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
      color: var(--text);
      font: inherit;
      font-size: 13px;
      transition: border-color 140ms ease, box-shadow 140ms ease, background-color 140ms ease, color 140ms ease;
    }
    input {
      padding: 0 10px;
      width: 100%;
    }
    select {
      appearance: none;
      padding: 0 34px 0 9px;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16' fill='none'%3E%3Cpath d='M4.75 6.25L8 9.5L11.25 6.25' stroke='%23344054' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
      background-position: right 10px center;
      background-size: 16px 16px;
      background-repeat: no-repeat;
    }
    select.enhanced-select {
      position: absolute;
      width: 1px;
      height: 1px;
      opacity: 0;
      pointer-events: none;
    }
    .select-combobox {
      position: relative;
      min-width: 0;
    }
    .select-trigger {
      width: 100%;
      height: 32px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 16px;
      gap: 8px;
      align-items: center;
      padding: 0 10px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
      color: var(--text);
      font: inherit;
      font-size: 13px;
      text-align: left;
      cursor: pointer;
      transition: border-color 140ms ease, box-shadow 140ms ease, background-color 140ms ease;
    }
    .select-trigger:hover {
      border-color: var(--line-strong);
    }
    .select-trigger:focus {
      outline: 2px solid color-mix(in srgb, var(--focus) 22%, transparent);
      border-color: var(--focus);
    }
    .select-trigger[aria-expanded="true"] {
      border-color: var(--focus);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus) 14%, transparent);
    }
    .select-value {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .select-icon {
      width: 16px;
      height: 16px;
      color: #344054;
      transition: transform 140ms ease;
    }
    .select-trigger[aria-expanded="true"] .select-icon {
      transform: rotate(180deg);
    }
    .select-menu {
      position: absolute;
      z-index: 20;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      max-height: 240px;
      overflow: auto;
      padding: 4px;
      border: 1px solid var(--line-strong);
      border-radius: var(--radius);
      background: var(--surface);
      box-shadow: 0 12px 24px rgba(16, 24, 40, 0.14);
    }
    .select-menu[hidden] {
      display: none;
    }
    .select-option {
      width: 100%;
      min-height: 30px;
      display: flex;
      align-items: center;
      padding: 5px 8px;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: var(--text);
      font: inherit;
      font-size: 13px;
      text-align: left;
      cursor: pointer;
    }
    .select-option:hover,
    .select-option.is-active {
      background: var(--surface-subtle);
    }
    .select-option.is-selected {
      background: var(--info);
      color: var(--focus-hover);
      font-weight: 700;
    }
    button {
      padding: 0 9px;
      cursor: pointer;
      background: var(--surface-subtle);
      font-weight: 700;
    }
    button:hover, select:hover, input:hover {
      border-color: var(--line-strong);
    }
    .filter-panel {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      min-width: 0;
    }
    .filter-group {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      padding: 2px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
    }
    .filter-group-label {
      padding: 0 5px 0 6px;
      color: var(--muted-2);
      font-size: 11px;
      font-weight: 800;
      white-space: nowrap;
    }
    .segmented {
      display: inline-flex;
      min-width: 0;
      padding: 2px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
    }
    .filter-group .segmented {
      padding: 0;
      border: 0;
      background: transparent;
    }
    .segmented button,
    .filter-chip {
      height: 28px;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: var(--muted);
      font-weight: 700;
      white-space: nowrap;
    }
    .segmented button {
      padding: 0 8px;
    }
    .filter-chip {
      padding: 0 9px;
      border: 1px solid var(--line);
      background: var(--surface);
    }
    .segmented button:hover,
    .filter-chip:hover {
      background: var(--surface-subtle);
      color: var(--text);
    }
    .segmented button.is-active,
    .filter-chip.is-active {
      background: var(--info);
      color: var(--focus-hover);
    }
    .filter-chip.is-active {
      border-color: color-mix(in srgb, var(--focus) 28%, var(--line));
    }
    .toolbar-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .display-toggles,
    .action-buttons {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .display-toggles {
      min-height: 32px;
      padding: 0 8px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
    }
    .display-toggles label {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }
    button.primary {
      border-color: var(--focus);
      background: var(--focus);
      color: #fff;
      font-weight: 700;
    }
    button.primary:hover {
      border-color: var(--focus-hover);
      background: var(--focus-hover);
    }
    button.danger {
      border-color: #e6aaa5;
      background: var(--review);
      color: var(--review-strong);
      font-weight: 700;
    }
    button.accept-ai-same {
      border-color: #b8dec5;
      background: var(--ok);
      color: var(--ok-strong);
    }
    button.ai-log-clear {
      border-color: color-mix(in srgb, var(--focus) 24%, var(--line));
      background: var(--info);
      color: var(--focus-hover);
    }
    button.filter-clear {
      color: var(--muted);
      background: var(--surface-subtle);
    }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.56;
    }
    input:focus, select:focus, button:focus, textarea:focus {
      outline: 2px solid color-mix(in srgb, var(--focus) 22%, transparent);
      border-color: var(--focus);
    }
    .ai-panel {
      margin-top: 11px;
      padding: 8px 10px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface-subtle);
    }
    .ai-panel[open] {
      background: var(--surface);
    }
    .ai-panel-title {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 10px;
      margin: 0;
      font-size: 13px;
      line-height: 1.3;
      font-weight: 700;
      cursor: default;
      list-style: none;
    }
    .ai-panel-title::-webkit-details-marker {
      display: none;
    }
    .ai-section {
      border-top: 1px solid var(--line);
      padding-top: 7px;
      margin-top: 7px;
    }
    .ai-section:first-of-type {
      border-top: 0;
      padding-top: 0;
      margin-top: 0;
    }
    .ai-section summary {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.25;
      font-weight: 700;
      cursor: default;
      list-style: none;
    }
    .ai-section summary::-webkit-details-marker {
      display: none;
    }
    .details-toggle {
      width: 24px;
      height: 24px;
      display: inline-grid;
      place-items: center;
      justify-self: end;
      padding: 0;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
    }
    .details-toggle:hover {
      background: var(--surface-subtle);
      color: var(--text);
    }
    .details-toggle::before {
      content: "";
      width: 16px;
      height: 16px;
      background: currentColor;
      mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16' fill='none'%3E%3Cpath d='M4.75 6.25L8 9.5L11.25 6.25' stroke='black' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 16px 16px no-repeat;
      transition: transform 140ms ease;
    }
    details[open] > summary .details-toggle::before {
      transform: rotate(180deg);
    }
    .ai-grid {
      display: grid;
      grid-template-columns: minmax(150px, 0.7fr) minmax(280px, 1.45fr) minmax(220px, 1fr) minmax(220px, 1fr);
      gap: 8px 10px;
      align-items: end;
    }
    .ai-field {
      min-width: 0;
    }
    .ai-field input,
    .ai-field select {
      min-width: 0;
      width: 100%;
    }
    .ai-field label {
      display: block;
      margin-bottom: 2px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.25;
      font-weight: 700;
    }
    .ai-mode-note {
      margin-top: 3px;
      font-size: 11px;
      line-height: 1.3;
    }
    .ai-secondary {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: minmax(120px, 150px) minmax(80px, 110px) minmax(100px, 130px) minmax(0, 1fr);
      gap: 8px 10px;
      align-items: start;
    }
    .ai-controls {
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-width: 0;
    }
    .ai-options {
      min-width: 0;
      flex-wrap: wrap;
    }
    .ai-actions {
      display: flex;
      align-items: center;
      justify-content: flex-start;
      gap: 6px;
      flex: 0 0 auto;
      white-space: nowrap;
    }
    .ai-actions button {
      min-width: 76px;
      height: 28px;
    }
    .ai-model-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 92px;
      gap: 8px;
    }
    .ai-status {
      margin-top: 7px;
      display: grid;
      grid-template-columns: minmax(240px, 1fr) minmax(160px, auto);
      gap: 8px;
      align-items: center;
      color: var(--muted);
      font-size: 11px;
    }
    .ai-progress {
      height: 6px;
      overflow: hidden;
      border-radius: 999px;
      background: #eef2f6;
    }
    .ai-progress[hidden] {
      display: none;
    }
    .ai-progress span {
      display: block;
      width: 0;
      height: 100%;
      background: var(--focus);
      transition: width 160ms ease;
    }
    .ai-prompt-box {
      margin-top: 0;
    }
    .ai-prompt-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 6px;
    }
    .ai-prompt-head label {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.25;
      font-weight: 700;
    }
    .ai-prompt-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .ai-prompt-box textarea {
      min-height: 96px;
      max-height: 320px;
      font-size: 12px;
      background: var(--surface-subtle);
    }
    .ai-monitor {
      margin-top: 0;
    }
    .ai-monitor-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 6px;
    }
    .ai-monitor-title {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.25;
      font-weight: 700;
    }
    .ai-monitor-state {
      color: var(--muted-2);
      font-size: 12px;
    }
    .ai-request-list {
      display: grid;
      gap: 6px;
    }
    .ai-request-empty {
      padding: 8px 10px;
      border: 1px dashed var(--line);
      border-radius: var(--radius);
      color: var(--muted-2);
      background: var(--surface-subtle);
      font-size: 12px;
    }
    .ai-request {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface-subtle);
      overflow: hidden;
    }
    .ai-request.is-waiting {
      border-color: color-mix(in srgb, var(--focus) 34%, var(--line));
      background: color-mix(in srgb, var(--info) 54%, var(--surface));
    }
    .ai-request.is-slow {
      border-color: #ead08d;
      background: var(--watch);
    }
    .ai-request.is-error {
      border-color: #f1b6b0;
      background: var(--review);
    }
    .ai-request-summary {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 8px;
      align-items: center;
      padding: 8px 10px;
      cursor: default;
      list-style: none;
    }
    .ai-request-summary::-webkit-details-marker {
      display: none;
    }
    .ai-request-main {
      min-width: 0;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      color: var(--text);
      font-size: 12px;
      line-height: 1.35;
    }
    .ai-request-pill {
      display: inline-flex;
      align-items: center;
      min-height: 20px;
      padding: 1px 7px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--surface);
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
    }
    .ai-request-time {
      color: var(--muted-2);
      font-size: 12px;
      white-space: nowrap;
    }
    .ai-request-body {
      display: grid;
      gap: 6px;
      padding: 0 10px 10px;
    }
    .ai-message {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--surface);
      overflow: hidden;
    }
    .ai-shared-message {
      border-color: color-mix(in srgb, var(--focus) 22%, var(--line));
      background: color-mix(in srgb, var(--info) 42%, var(--surface));
    }
    .ai-message-role {
      padding: 5px 7px;
      border-bottom: 1px solid var(--line);
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      background: var(--surface-subtle);
    }
    .ai-message pre,
    .ai-response-preview {
      margin: 0;
      padding: 7px;
      max-height: 220px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      color: #344054;
      font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
    }
    .ai-response-preview {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--surface);
    }
    .toggle-row {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--muted);
      font-size: 13px;
      white-space: nowrap;
    }
    .toggle-row label,
    .done-line {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    input[type="checkbox"] {
      width: 14px;
      height: 14px;
      accent-color: var(--focus);
    }
    .wrap {
      --results-max-height: none;
      padding: 12px 18px 28px;
    }
    .table-frame {
      overflow: auto;
      max-height: var(--results-max-height);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
      box-shadow: var(--shadow-panel);
    }
    .table-frame.is-fit-content {
      overflow: visible;
      max-height: none;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      background: var(--surface);
    }
    th, td {
      vertical-align: top;
      border: 1px solid var(--line);
      padding: 10px;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 2;
      background: var(--head);
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
      text-align: left;
    }
    th:nth-child(1), td:nth-child(1) { width: 12%; }
    th:nth-child(2), td:nth-child(2) { width: 27%; }
    th:nth-child(3), td:nth-child(3) { width: 43%; }
    th:nth-child(4), td:nth-child(4) { width: 18%; }
    tr.ok .meta-cell { background: var(--ok); border-left: 3px solid var(--ok-strong); }
    tr.watch .meta-cell { background: var(--watch); border-left: 3px solid var(--watch-strong); }
    tr.review .meta-cell { background: var(--review); border-left: 3px solid var(--review-strong); }
    tr.done {
      opacity: 0.72;
    }
    tr.active-row {
      outline: 2px solid color-mix(in srgb, var(--focus) 35%, transparent);
      outline-offset: -2px;
    }
    tr.ai-active {
      outline: 2px solid color-mix(in srgb, var(--watch-strong) 42%, transparent);
      outline-offset: -2px;
    }
    .meta-cell {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
    }
    .row-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
    }
    .idx {
      color: var(--text);
      font-weight: 700;
      font-size: 14px;
    }
    .status-dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--ok-strong);
      flex: 0 0 auto;
    }
    tr.watch .status-dot { background: var(--watch-strong); }
    tr.review .status-dot { background: var(--review-strong); }
    .chapter {
      margin: 5px 0 7px;
      color: var(--text);
      font-weight: 600;
    }
    .source-cell {
      background: var(--surface);
    }
    dl {
      margin: 0;
    }
    dl div {
      margin-top: 5px;
    }
    dt {
      display: inline;
      color: var(--muted-2);
      margin-right: 4px;
    }
    dd {
      display: inline;
      margin: 0;
    }
    .translation-cell {
      padding: 0;
      background: var(--surface);
    }
    .version-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 0;
      min-height: 100%;
    }
    .mode-bilingual .version-grid {
      grid-template-columns: minmax(0, 1fr);
    }
    .version-panel {
      padding: 10px;
      min-width: 0;
    }
    .version-panel + .version-panel {
      border-left: 1px solid var(--line);
    }
    .version-label {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 6px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
      font-weight: 700;
    }
    .copy-version {
      flex: 0 0 auto;
      min-height: 22px;
      padding: 1px 7px;
      border-radius: 6px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.2;
      background: var(--surface-subtle);
    }
    .diff-block {
      border-top: 1px dashed var(--line);
      padding: 9px 10px 10px;
      background: var(--surface-subtle);
      color: #344054;
      font-size: 14px;
    }
    .diff-title {
      margin-bottom: 8px;
      color: var(--text);
      font-size: 12px;
      font-weight: 700;
    }
    .diff-comparison + .diff-comparison {
      margin-top: 9px;
      padding-top: 9px;
      border-top: 1px solid var(--line);
    }
    .diff-match-badge {
      flex: 0 0 auto;
      padding: 2px 5px;
      border: 1px solid color-mix(in srgb, var(--focus) 24%, var(--line));
      border-radius: 999px;
      background: var(--info);
      color: var(--focus);
      font-size: 11px;
      line-height: 1;
      font-weight: 700;
    }
    ins {
      background: #dff5e5;
      color: #14532d;
      text-decoration: none;
      border-radius: 3px;
      padding: 0 2px;
    }
    del {
      background: #ffe2e2;
      color: #7f1d1d;
      text-decoration: line-through;
      border-radius: 3px;
      padding: 0 2px;
    }
    .note-cell {
      background: var(--surface);
    }
    .confirm-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      margin-bottom: 7px;
    }
    .confirm-options {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
    }
    .done-line,
    .manual-note-line {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: var(--muted);
      font-size: 13px;
    }
    .manual-note-line {
      color: #475467;
    }
    .ai-confirm-badge {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 2px 7px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--surface-subtle);
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }
    .ai-confirm-badge.is-modify {
      border-color: #f1b6b0;
      background: var(--review);
      color: var(--review-strong);
    }
    .ai-confirm-badge.is-same {
      border-color: #b8dec5;
      background: var(--ok);
      color: var(--ok-strong);
    }
    .ai-confirm-badge.is-unclear,
    .ai-confirm-badge.is-on {
      border-color: color-mix(in srgb, var(--focus) 28%, var(--line));
      background: color-mix(in srgb, var(--info) 62%, var(--surface));
      color: #175cd3;
    }
    .ai-confirm-badge.is-failure {
      border-color: #e6aaa5;
      background: #fff7f6;
      color: var(--review-strong);
    }
    .ai-confirm-badge.is-off {
      color: var(--muted-2);
    }
    .note-summary {
      display: grid;
      gap: 5px;
      margin-bottom: 8px;
      padding: 8px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface-subtle);
      font-size: 13px;
      line-height: 1.45;
    }
    .note-summary[hidden] {
      display: none;
    }
    .note-summary-line {
      display: grid;
      grid-template-columns: 94px minmax(0, 1fr);
      gap: 8px;
    }
    .note-detail {
      margin-top: 4px;
      padding-top: 6px;
      border-top: 1px dashed var(--line);
      color: var(--muted);
    }
    .note-detail-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 3px;
    }
    .revision-select {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
    }
    .note-summary-key {
      color: var(--muted);
      font-weight: 700;
    }
    .note-summary-value {
      color: #344054;
      word-break: break-word;
      white-space: pre-wrap;
    }
    .issue-severity-badge {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      width: fit-content;
      padding: 1px 7px;
      border: 1px solid var(--line);
      border-radius: 4px;
      font-size: 12px;
      font-weight: 700;
      line-height: 1.2;
    }
    .issue-severity-badge.is-critical {
      border-color: #e6aaa5;
      background: var(--review);
      color: var(--review-strong);
    }
    .issue-severity-badge.is-major {
      border-color: #ead08a;
      background: var(--watch);
      color: var(--watch-strong);
    }
    .issue-severity-badge.is-minor {
      border-color: #b8cee9;
      background: var(--info);
      color: var(--focus-hover);
    }
    .copy-revision {
      flex: 0 0 auto;
      min-height: 24px;
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 12px;
      line-height: 1.2;
    }
    textarea {
      display: block;
      width: 100%;
      min-height: 112px;
      height: auto;
      padding: 8px;
      resize: vertical;
      line-height: 1.55;
      border-color: var(--line);
      background: var(--surface-subtle);
    }
    .note-editor {
      min-height: 52px;
      max-height: 40vh;
      overflow-y: hidden;
    }
    .note-editor[hidden] {
      display: none;
    }
    .note-editor.has-manual-note {
      min-height: 88px;
    }
    .note-editor.is-overflowing {
      overflow-y: auto;
    }
    .hide-source th:nth-child(2),
    .hide-source td:nth-child(2) {
      display: none;
    }
    .hide-translation-diff [data-diff-kind="translation"],
    .hide-revision-diff [data-diff-kind="revision"],
    .hide-translation-diff [data-diff][data-has-revision="0"],
    .hide-revision-diff [data-diff][data-has-translation="0"],
    .hide-translation-diff.hide-revision-diff [data-diff] {
      display: none;
    }
    .pagination-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
      padding: 12px;
      color: var(--muted);
      font-size: 13px;
      border: 1px solid var(--line);
      border-top: 0;
      background: var(--surface);
    }
    .pagination-bar.hidden {
      display: none;
    }
    .pagination-actions,
    .pagination-size {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .pagination-bar button {
      height: 30px;
    }
    .pagination-bar input {
      width: 64px;
      height: 30px;
      text-align: center;
    }
    .pagination-bar select {
      width: 96px;
      height: 30px;
    }
    mark {
      background: #fff2a8;
      color: inherit;
      padding: 0 1px;
    }
    .empty-state {
      display: none;
      padding: 18px;
      color: var(--muted);
      text-align: center;
      border: 1px solid var(--line);
      border-top: 0;
      background: var(--surface);
    }
    .empty-state.visible {
      display: block;
    }
    @media (max-width: 1100px) {
      .app-shell { min-width: 760px; }
      body { font-size: 14px; }
      th, td { padding: 8px; }
      .topbar { grid-template-columns: 1fr; }
      .stats { justify-content: flex-start; max-width: none; }
      .toolbar { grid-template-columns: minmax(220px, 1fr); }
      .filter-panel,
      .toolbar-actions {
        justify-content: flex-start;
      }
      .ai-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .ai-secondary { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .ai-controls { grid-column: span 3; align-items: flex-start; flex-direction: column; }
      .ai-actions { flex-wrap: wrap; }
      .ai-status { grid-template-columns: 1fr; }
    }
  </style>
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
      <div class="toolbar">
        <input id="query" type="search" placeholder="搜索原文、译文、备注">
        <div class="filter-panel" aria-label="筛选">
          <div class="filter-group">
            <span class="filter-group-label">相似度</span>
            <div class="segmented" role="group" aria-label="相似度状态">
              <button type="button" class="is-active" data-severity="all">全部</button>
              <button type="button" data-severity="review" title="相似度低于 18%">较低</button>
              <button type="button" data-severity="watch" title="相似度为 18% 至 35%">中等</button>
              <button type="button" data-severity="ok" title="相似度不低于 35%">较高</button>
            </div>
          </div>
          <div class="filter-group">
            <span class="filter-group-label">自动</span>
            <div class="segmented" role="group" aria-label="自动分析结果">
              <button type="button" class="is-active" data-ai-result="all">全部</button>
              <button type="button" data-ai-result="modify">需改</button>
              <button type="button" data-ai-result="same">不改</button>
              <button type="button" data-ai-result="unclear">待判</button>
            </div>
          </div>
          <div class="filter-group">
            <span class="filter-group-label" title="按 MQM 风格的问题严重程度筛选">分级</span>
            <div class="segmented" role="group" aria-label="AI 问题严重程度">
              <button type="button" class="is-active" data-issue-severity="all">全部</button>
              <button type="button" data-issue-severity="critical" title="核心意义严重失真，或存在安全、法律等高风险后果">致命</button>
              <button type="button" data-issue-severity="major" title="影响准确性、完整性或可用性">严重</button>
              <button type="button" data-issue-severity="minor" title="不改变意义的局部语言或文体问题">轻微</button>
            </div>
          </div>
          <button id="noteFilter" class="filter-chip" type="button" aria-pressed="false">有备注</button>
          <button id="doneFilter" class="filter-chip" type="button" data-mode="open" aria-pressed="false">未人工确认</button>
        </div>
        <div class="toolbar-actions">
          <div class="display-toggles" aria-label="显示列">
            <label><input id="showSource" type="checkbox" checked>原文</label>
            <label${bilingual ? " hidden" : ""}><input id="showTranslationDiff" type="checkbox" checked>译文差异</label>
            <label><input id="showRevisionDiff" type="checkbox" checked>修改差异</label>
          </div>
          <div class="action-buttons">
            <button id="acceptAiSame" class="accept-ai-same" type="button">确认自动不改</button>
            <button id="exportNotes" type="button">导出修改结果</button>
            <button id="confirmRevisions" type="button">确认修改结果</button>
            <button id="clearAiLog" class="ai-log-clear" type="button">清AI记录</button>
            <button id="clearFilter" class="filter-clear" type="button">清筛选</button>
          </div>
        </div>
      </div>
      <details id="aiPanel" class="ai-panel" aria-label="AI 校对">
        <summary class="ai-panel-title"><span>AI 校对</span><button class="details-toggle" type="button" data-details-toggle aria-label="折叠或展开 AI 校对"></button></summary>
        <details id="aiConfigSection" class="ai-section" open>
          <summary><span>运行配置</span><button class="details-toggle" type="button" data-details-toggle aria-label="折叠或展开运行配置"></button></summary>
          <div class="ai-grid">
            <div class="ai-field">
              <label for="aiProvider">接口</label>
              <select id="aiProvider">
                <option value="local">本地默认</option>
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
            <div class="ai-field">
              <label for="aiApiKey">API Key</label>
              <input id="aiApiKey" type="password" autocomplete="off" placeholder="${escapeHtml(providerDefaults.local.apiKeyPlaceholder || "")}">
            </div>
            <div class="ai-secondary">
              <div class="ai-field">
                <label for="aiProofreadMode">校对模式</label>
                <select id="aiProofreadMode" disabled>
                  <option value="${defaultProofreadMode}">${bilingual ? "双语版本校对" : "三语语境校对"}</option>
                </select>
                <div id="aiProofreadModeHint" class="subtle ai-mode-note">${bilingual ? "目标固定为译文 B，参考原文 A；原文只作语义边界和上下文。" : "目标可选非原文 B 或 C，同时参考原文 A 和另一版本。"}</div>
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
              <div class="ai-field">
                <label for="aiSimilarity">${escapeHtml(similarityLabel)}相似度预筛选</label>
                <input id="aiSimilarity" type="text" inputmode="decimal" value="92%" aria-label="${escapeHtml(similarityLabel)}相似度预筛选百分比">
              </div>
              <div class="ai-controls">
                <div class="toggle-row ai-options">
                  <label><input id="aiMonitorEnabled" type="checkbox">显示记录对话监控</label>
                  <label><input id="aiPromptVisible" type="checkbox">显示内置提示词</label>
                </div>
                <div class="ai-actions">
                  <button id="aiStart" class="primary" type="button">开始</button>
                  <button id="aiStop" class="danger" type="button" disabled>停止</button>
                </div>
              </div>
            </div>
          </div>
        </details>
        <div class="ai-status">
          <div id="aiStatus">${escapeHtml(providerDefaults.local.note || "等待启动 AI 校对。")}</div>
          <div id="aiProgressWrap" class="ai-progress" aria-hidden="true" hidden><span id="aiProgress"></span></div>
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
    </header>
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
    const pageLabels = pageMeta.pageLabels;
    const bilingualMode = pageMeta.comparisonMode === "bilingual";
    const aiConfigStorageKey = "translation-compare-ai-config-v1";
    const aiPromptStorageKey = "translation-compare-ai-prompt-v1:" + (pageMeta.projectKey || "unscoped");
    const automatedNoteMarkers = ["[AI校对]", "[规则预筛]", "[相似度预筛]"];
    const allRows = JSON.parse(document.getElementById("rowData").textContent);
    const rowsById = new Map(allRows.map((row) => [String(row.index), row]));
    const renderedRowsById = new Map();
    const currentRawNotes = readStoredNotes(storageKey);
    const notes = {};
    for (const [id, value] of Object.entries(currentRawNotes)) {
      notes[id] = normalizeStoredNote(value);
    }
    const tbody = document.querySelector("tbody");
    const wrap = document.querySelector(".wrap");
    const tableFrame = document.querySelector(".table-frame");
    const query = document.getElementById("query");
    const severityButtons = Array.from(document.querySelectorAll("[data-severity]"));
    const aiResultButtons = Array.from(document.querySelectorAll("[data-ai-result]"));
    const issueSeverityButtons = Array.from(document.querySelectorAll("[data-issue-severity]"));
    const noteFilter = document.getElementById("noteFilter");
    const doneFilter = document.getElementById("doneFilter");
    const showSource = document.getElementById("showSource");
    const showTranslationDiff = document.getElementById("showTranslationDiff");
    const showRevisionDiff = document.getElementById("showRevisionDiff");
    const emptyState = document.getElementById("emptyState");
    const paginationBar = document.getElementById("paginationBar");
    const paginationStatus = document.getElementById("paginationStatus");
    const pageInput = document.getElementById("pageInput");
    const pageTotal = document.getElementById("pageTotal");
    const pageSize = document.getElementById("pageSize");
    const firstPage = document.getElementById("firstPage");
    const prevPage = document.getElementById("prevPage");
    const nextPage = document.getElementById("nextPage");
    const lastPage = document.getElementById("lastPage");
    const doneCount = document.getElementById("doneCount");
    const aiDoneCount = document.getElementById("aiDoneCount");
    const aiIds = {
      provider: document.getElementById("aiProvider"),
      panel: document.getElementById("aiPanel"),
      configSection: document.getElementById("aiConfigSection"),
      monitorSection: document.getElementById("aiMonitorSection"),
      promptSection: document.getElementById("aiPromptSection"),
      baseUrl: document.getElementById("aiBaseUrl"),
      model: document.getElementById("aiModel"),
      refreshModels: document.getElementById("aiRefreshModels"),
      apiKey: document.getElementById("aiApiKey"),
      proofreadMode: document.getElementById("aiProofreadMode"),
      proofreadModeHint: document.getElementById("aiProofreadModeHint"),
      target: document.getElementById("aiTarget"),
      concurrency: document.getElementById("aiConcurrency"),
      similarity: document.getElementById("aiSimilarity"),
      monitorEnabled: document.getElementById("aiMonitorEnabled"),
      promptVisible: document.getElementById("aiPromptVisible"),
      start: document.getElementById("aiStart"),
      stop: document.getElementById("aiStop"),
      clearCache: document.getElementById("clearAiLog"),
      status: document.getElementById("aiStatus"),
      progressWrap: document.getElementById("aiProgressWrap"),
      progress: document.getElementById("aiProgress"),
      monitorState: document.getElementById("aiMonitorState"),
      requestList: document.getElementById("aiRequestList"),
      prompt: document.getElementById("aiPrompt"),
      promptReset: document.getElementById("aiPromptReset"),
    };
    const appliedAiResults = new Set();
    const aiActiveIds = new Set();
    const aiRequestCache = new Map();
    const clearedAiRunIds = new Set();
    const manualNoteOpenIds = new Set();
    const selectedRevisionIds = new Set();
    const diffHtmlCache = new Map();
    let filteredRows = allRows;
    let currentPage = 1;
    let activeRowId = "";
    let lastAiRunId = "";
    let lastAiResultRevision = 0;
    let aiMonitorRenderKey = "";
    let aiStatusRefreshInFlight = false;
    let aiCatchupTimer = 0;
    let notesSavePending = false;
    let notesSaveHandle = 0;
    let notesSaveHandleType = "";
    let filterTimer = 0;
    let severityFilter = "all";
    let aiResultFilter = "all";
    let issueSeverityFilter = "all";
    let notesOnly = false;
    let doneMode = "all";
    let providerDefaults = pageMeta.providerDefaults || {};
    let defaultProofreadPrompt = pageMeta.proofreadPrompt?.system || "";
    let aiModelOptions = [];
    let statusMessageLockedUntil = 0;
    aiIds.monitorSection.hidden = !aiIds.monitorEnabled.checked;
    aiIds.promptSection.hidden = !aiIds.promptVisible.checked;

    function readStoredNotes(key) {
      if (!key) return {};
      try {
        return JSON.parse(localStorage.getItem(key) || "{}") || {};
      } catch {
        return {};
      }
    }

    function persistNotes() {
      localStorage.setItem(storageKey, JSON.stringify(notes));
    }

    function cancelScheduledNotesSave() {
      if (!notesSavePending) return;
      if (notesSaveHandleType === "idle" && window.cancelIdleCallback) {
        window.cancelIdleCallback(notesSaveHandle);
      } else {
        window.clearTimeout(notesSaveHandle);
      }
      notesSavePending = false;
      notesSaveHandle = 0;
      notesSaveHandleType = "";
    }

    function flushNotes() {
      if (!notesSavePending) return;
      cancelScheduledNotesSave();
      persistNotes();
    }

    function saveNotes({ immediate = false } = {}) {
      if (immediate) {
        cancelScheduledNotesSave();
        persistNotes();
        return;
      }
      if (notesSavePending) return;
      notesSavePending = true;
      const commit = () => {
        notesSavePending = false;
        notesSaveHandle = 0;
        notesSaveHandleType = "";
        persistNotes();
      };
      if (window.requestIdleCallback) {
        notesSaveHandleType = "idle";
        notesSaveHandle = window.requestIdleCallback(commit, { timeout: 2000 });
      } else {
        notesSaveHandleType = "timeout";
        notesSaveHandle = window.setTimeout(commit, 250);
      }
    }

    function parsePercentRatio(value, fallback = 0.92) {
      const raw = String(value ?? "").trim();
      if (!raw) return fallback;
      const numeric = Number(raw.replace("%", "").trim());
      if (!Number.isFinite(numeric)) return fallback;
      const ratio = raw.includes("%") || numeric > 1 ? numeric / 100 : numeric;
      return Math.min(1, Math.max(0.5, ratio));
    }

    function formatPercentRatio(value) {
      const ratio = parsePercentRatio(value);
      const percent = ratio * 100;
      const text = Number.isInteger(percent) ? String(percent) : percent.toFixed(1).replace(/\\.0$/, "");
      return text + "%";
    }

    function normalizeSimilarityInput() {
      aiIds.similarity.value = formatPercentRatio(aiIds.similarity.value);
    }

    function updateProofreadModeHint() {
      aiIds.proofreadMode.value = bilingualMode ? "bilingual" : "trilingual";
      aiIds.proofreadModeHint.textContent = bilingualMode
        ? "目标固定为译文 B，参考原文 A；原文只作语义边界和上下文。"
        : "目标可选非原文 B 或 C，同时参考原文 A 和另一版本。";
    }

    function automatedNoteMarker(value) {
      const text = String(value || "").trimStart();
      return automatedNoteMarkers.find((marker) => text.startsWith(marker)) || "";
    }

    function isAutomatedNoteText(value) {
      return Boolean(automatedNoteMarker(value));
    }

    function hasAutomatedDecisionNote(note) {
      return !isAiFailureNote(note) && Boolean(parseAutomatedNote(note));
    }

    function isAiFailureNote(note) {
      const lines = String(note || "").split(/\\n+/).map((line) => line.trim()).filter(Boolean);
      if (!lines[0]?.startsWith("[AI校对]")) return false;
      return lines.slice(1).some((line) =>
        line.startsWith("调用失败：") ||
        line === "校对已终止。" ||
        line.startsWith("校对已终止：")
      );
    }

    function cleanAiFailureState(item) {
      if (!item || !isAiFailureNote(item.note)) return false;
      const changed = Boolean(item.manualDone || item.done || item.aiDone);
      item.manualDone = false;
      item.done = false;
      item.aiDone = false;
      return changed;
    }

    function normalizeStoredNote(value) {
      const note = String(value?.note || "");
      const manualNote = String(value?.manualNote || "");
      const manualDone = Boolean(value?.manualDone);
      const item = splitStoredNote(note, manualNote, false, manualDone);
      item.aiDone = Boolean(value?.aiDone || hasAutomatedDecisionNote(item.note));
      cleanAiFailureState(item);
      return item;
    }

    function splitStoredNote(note, manualNote, done, manualDone = false, aiDone = false) {
      const text = String(note || "");
      const manual = String(manualNote || "").trim();
      if (isAutomatedNoteText(text)) return { note: text, manualNote: manual, done, manualDone, aiDone };
      const markerIndexes = automatedNoteMarkers.map((marker) => text.indexOf(marker)).filter((index) => index >= 0);
      const markerIndex = markerIndexes.length ? Math.min(...markerIndexes) : -1;
      if (markerIndex < 0) return { note: text, manualNote: manual, done, manualDone, aiDone };
      return {
        note: text.slice(markerIndex).trim(),
        manualNote: [manual, text.slice(0, markerIndex).trim()].filter(Boolean).join("\\n\\n"),
        done,
        manualDone,
        aiDone,
      };
    }

    function hasStoredNote(item) {
      return Boolean(item?.note || item?.manualNote);
    }

    function visibleManualNote(item) {
      if (!item) return "";
      return isAutomatedNoteText(item.note) ? item.manualNote || "" : item.note || "";
    }

    function combinedNoteText(item) {
      if (!item) return "";
      return [item.note, item.manualNote].filter(Boolean).join("\\n\\n");
    }

    function pruneEmptyNote(id) {
      const item = notes[id];
      if (item && !hasStoredNote(item) && !item.done && !item.manualDone && !item.aiDone) delete notes[id];
    }

    function setManualNote(item, value) {
      if (isAutomatedNoteText(item.note)) {
        item.manualNote = value;
      } else {
        item.note = value;
        item.manualNote = "";
      }
    }

    function loadSavedAiConfig() {
      try {
        return JSON.parse(localStorage.getItem(aiConfigStorageKey) || "{}");
      } catch {
        return {};
      }
    }

    function loadSavedAiPrompt() {
      try {
        return JSON.parse(localStorage.getItem(aiPromptStorageKey) || "{}");
      } catch {
        return {};
      }
    }

    function saveAiConfig() {
      const config = {
        provider: aiIds.provider.value,
        baseUrl: aiIds.baseUrl.value,
        model: aiIds.model.value,
        modelOptions: aiModelOptions,
        modelOptionsBaseUrl: aiModelOptions.length ? normalizeApiBaseUrl(aiIds.baseUrl.value) : "",
        apiKey: aiIds.apiKey.value,
        proofreadMode: aiIds.proofreadMode.value,
        target: aiIds.target.value,
        concurrency: aiIds.concurrency.value,
        similarity: formatPercentRatio(aiIds.similarity.value),
        monitorEnabled: aiIds.monitorEnabled.checked,
        promptVisible: aiIds.promptVisible.checked,
      };
      localStorage.setItem(aiConfigStorageKey, JSON.stringify(config));
    }

    function saveAiPrompt() {
      localStorage.setItem(aiPromptStorageKey, JSON.stringify({
        systemPrompt: aiIds.prompt.value,
        promptTouched: Boolean(aiIds.prompt.dataset.touched),
      }));
    }

    function restoreAiConfig() {
      const saved = loadSavedAiConfig();
      const savedPrompt = loadSavedAiPrompt();
      if (!saved || typeof saved !== "object") return;
      if (saved.provider && providerDefaults[saved.provider]) aiIds.provider.value = saved.provider;
      if (typeof saved.baseUrl === "string") {
        aiIds.baseUrl.value = saved.baseUrl;
        aiIds.baseUrl.dataset.touched = "1";
      }
      const savedModelOptions = restorableModelOptions(saved);
      if (savedModelOptions.length) {
        setModelOptions(savedModelOptions, { selected: saved.model });
        aiIds.model.dataset.touched = "1";
      } else if (typeof saved.model === "string" && saved.model) {
        setModelOptions([saved.model], { selected: saved.model });
        aiIds.model.dataset.touched = "1";
      }
      if (typeof saved.apiKey === "string") aiIds.apiKey.value = saved.apiKey;
      if (saved.target === "cn" || saved.target === "tw") aiIds.target.value = saved.target;
      if (bilingualMode) aiIds.target.value = "cn";
      if (saved.concurrency != null) aiIds.concurrency.value = saved.concurrency;
      if (saved.similarity != null) aiIds.similarity.value = formatPercentRatio(saved.similarity);
      aiIds.monitorEnabled.checked = Boolean(saved.monitorEnabled);
      aiIds.promptVisible.checked = Boolean(saved.promptVisible);
      if (typeof savedPrompt.systemPrompt === "string" && savedPrompt.systemPrompt) {
        if (savedPrompt.promptTouched) {
          aiIds.prompt.value = savedPrompt.systemPrompt;
          aiIds.prompt.dataset.touched = "1";
        } else {
          aiIds.prompt.value = defaultProofreadPrompt;
          aiIds.prompt.dataset.touched = "";
        }
      }
      aiIds.monitorSection.hidden = !aiIds.monitorEnabled.checked;
      aiIds.promptSection.hidden = !aiIds.promptVisible.checked;
      normalizeSimilarityInput();
      updateProofreadModeHint();
    }

    function bindDetailsToggle(scope = document) {
      scope.querySelectorAll("summary").forEach((summary) => {
        if (summary.dataset.toggleBound) return;
        summary.dataset.toggleBound = "1";
        summary.addEventListener("click", (event) => {
          const button = event.target.closest("[data-details-toggle]");
          if (!button) {
            event.preventDefault();
            return;
          }
          event.preventDefault();
          const details = summary.closest("details");
          if (details) {
            details.open = !details.open;
            window.requestAnimationFrame(syncVisibleRowLayout);
          }
        });
        summary.addEventListener("keydown", (event) => {
          if (event.target.closest("[data-details-toggle]")) return;
          if (event.key === "Enter" || event.key === " ") event.preventDefault();
        });
      });
    }

    function isStatusMessageLocked() {
      return Date.now() < statusMessageLockedUntil;
    }

    function setRuntimeStatus(message) {
      statusMessageLockedUntil = 0;
      aiIds.status.dataset.runtimeMessage = "1";
      aiIds.status.textContent = message;
    }

    function setTemporaryStatus(message, durationMs = 8000) {
      statusMessageLockedUntil = Date.now() + durationMs;
      aiIds.status.dataset.runtimeMessage = "1";
      aiIds.status.textContent = message;
    }

    function clearLocalAiCache() {
      appliedAiResults.clear();
      aiActiveIds.clear();
      activeRowId = "";
      lastAiRunId = "";
      lastAiResultRevision = 0;
      aiMonitorRenderKey = "";
      aiRequestCache.clear();
      aiIds.progress.style.width = "0%";
      aiIds.progressWrap.hidden = true;
      aiIds.monitorState.textContent = "尚未启动";
      aiIds.requestList.innerHTML = '<div class="ai-request-empty">启动 AI 校对后，这里会显示程序发给模型的问题和接口等待状态。</div>';
      updateRenderedAiActive();
    }

    function renderClearedAiStatus(message = "已清除 AI 运行记录和对话监控；备注与人工确认已保留。") {
      aiIds.start.disabled = false;
      aiIds.stop.disabled = true;
      aiIds.monitorEnabled.disabled = false;
      aiIds.status.dataset.cacheCleared = "1";
      setRuntimeStatus(message);
      aiIds.progress.style.width = "0%";
      aiIds.progressWrap.hidden = true;
      aiIds.monitorState.textContent = "尚未启动";
      aiIds.requestList.innerHTML = '<div class="ai-request-empty">启动 AI 校对后，这里会显示程序发给模型的问题和接口等待状态。</div>';
      aiMonitorRenderKey = "";
      aiActiveIds.clear();
      updateRenderedAiActive();
    }

    function enhanceSelect(select) {
      if (!select || select.dataset.enhanced) return;
      select.dataset.enhanced = "1";
      select.classList.add("enhanced-select");

      const wrapper = document.createElement("div");
      wrapper.className = "select-combobox";
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "select-trigger";
      trigger.setAttribute("aria-haspopup", "listbox");
      trigger.setAttribute("aria-expanded", "false");
      const value = document.createElement("span");
      value.className = "select-value";
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("class", "select-icon");
      icon.setAttribute("viewBox", "0 0 16 16");
      icon.setAttribute("fill", "none");
      icon.setAttribute("aria-hidden", "true");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M4.75 6.25L8 9.5L11.25 6.25");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "1.75");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      icon.append(path);
      trigger.append(value, icon);

      const menu = document.createElement("div");
      menu.className = "select-menu";
      menu.setAttribute("role", "listbox");
      menu.hidden = true;

      select.parentNode.insertBefore(wrapper, select);
      wrapper.append(select, trigger, menu);

      function selectedOption() {
        return select.options[select.selectedIndex] || select.options[0];
      }

      function sync() {
        const selected = selectedOption();
        value.textContent = selected?.textContent || "";
        trigger.title = selected?.textContent || "";
        menu.replaceChildren(...Array.from(select.options).map((option) => {
          const item = document.createElement("button");
          item.type = "button";
          item.className = "select-option";
          item.setAttribute("role", "option");
          item.dataset.value = option.value;
          item.textContent = option.textContent;
          if (option.value === select.value) {
            item.classList.add("is-selected");
            item.setAttribute("aria-selected", "true");
          } else {
            item.setAttribute("aria-selected", "false");
          }
          item.disabled = option.disabled;
          return item;
        }));
      }

      function close() {
        menu.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
      }

      function open() {
        closeAllSelects(wrapper);
        sync();
        menu.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
      }

      trigger.addEventListener("click", () => {
        if (menu.hidden) open();
        else close();
      });

      menu.addEventListener("click", (event) => {
        const item = event.target.closest(".select-option");
        if (!item || item.disabled) return;
        select.value = item.dataset.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        sync();
        close();
        trigger.focus();
      });

      trigger.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          close();
          return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        if (menu.hidden) {
          open();
          return;
        }
        const options = Array.from(menu.querySelectorAll(".select-option:not(:disabled)"));
        if (!options.length) return;
        const selectedIndex = Math.max(0, options.findIndex((item) => item.dataset.value === select.value));
        const nextIndex = event.key === "ArrowUp"
          ? Math.max(0, selectedIndex - 1)
          : Math.min(options.length - 1, selectedIndex + 1);
        if (event.key === "Enter" || event.key === " ") {
          options[selectedIndex].click();
          return;
        }
        for (const option of options) option.classList.remove("is-active");
        const next = options[nextIndex];
        next.classList.add("is-active");
        const nextTop = next.offsetTop;
        const nextBottom = nextTop + next.offsetHeight;
        if (nextTop < menu.scrollTop) menu.scrollTop = nextTop;
        if (nextBottom > menu.scrollTop + menu.clientHeight) {
          menu.scrollTop = nextBottom - menu.clientHeight;
        }
      });

      select.addEventListener("change", sync);
      select._syncEnhancedSelect = sync;
      sync();
    }

    function closeAllSelects(except) {
      for (const wrapper of document.querySelectorAll(".select-combobox")) {
        if (wrapper === except) continue;
        const menu = wrapper.querySelector(".select-menu");
        const trigger = wrapper.querySelector(".select-trigger");
        if (menu) menu.hidden = true;
        if (trigger) trigger.setAttribute("aria-expanded", "false");
      }
    }

    document.addEventListener("click", (event) => {
      if (!event.target.closest(".select-combobox")) closeAllSelects();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeAllSelects();
    });

    function syncEnhancedSelect(select) {
      select?._syncEnhancedSelect?.();
    }

    function escapeHtml(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function diffCacheKey(row) {
      return row.signature || String(row.index);
    }

    function renderRowDiffHtml(row) {
      if (!row.cn || !row.twCn) return "";
      const key = diffCacheKey(row);
      if (diffHtmlCache.has(key)) return diffHtmlCache.get(key);
      const html = inlineDiffHtml(row.cn, row.twCn);
      diffHtmlCache.set(key, html);
      return html;
    }

    function renderDiffBlock(row, noteText) {
      const twDiffHtml = renderRowDiffHtml(row);
      const revision = parseAutomatedNote(noteText)?.revision || "";
      const revisionDiffHtml = row.cn && revision ? inlineDiffHtml(row.cn, revision) : "";
      const revisionMatchesTw = Boolean(twDiffHtml && revisionDiffHtml && twDiffHtml === revisionDiffHtml);
      const comparisons = [];
      if (twDiffHtml && !revisionMatchesTw) {
        comparisons.push({
          kind: "translation",
          html: '<div class="diff-comparison" data-diff-kind="translation">' +
          '<div class="version-label"><span>' + escapeHtml(pageLabels.cn) + ' -> ' + escapeHtml(pageLabels.tw) + '简体化</span></div>' +
          '<div lang="zh-Hans">' + twDiffHtml + '</div>' +
          '</div>',
        });
      }
      if (revisionDiffHtml) {
        const id = String(row.index);
        const matchBadge = revisionMatchesTw
          ? '<span class="diff-match-badge" title="与' + escapeHtml(pageLabels.tw) + '简体化的差异完全相同">同' + escapeHtml(pageLabels.tw) + '简体化</span>'
          : "";
        comparisons.push({
          kind: "revision",
          html: '<div class="diff-comparison" data-diff-kind="revision">' +
          '<div class="version-label"><label class="revision-select"><span>' + escapeHtml(pageLabels.cn) + ' -> 修改结果</span><input type="checkbox" data-export-revision="' + escapeHtml(id) + '" aria-label="选择第 ' + escapeHtml(id) + ' 行修改结果"' + (selectedRevisionIds.has(id) ? " checked" : "") + '></label>' + matchBadge + '</div>' +
          '<div lang="zh-Hans">' + revisionDiffHtml + '</div>' +
          '</div>',
        });
      }
      const hasTranslation = comparisons.some((item) => item.kind === "translation");
      const hasRevision = comparisons.some((item) => item.kind === "revision");
      return comparisons.length
        ? '<section class="diff-block" data-diff data-has-translation="' + (hasTranslation ? "1" : "0") + '" data-has-revision="' + (hasRevision ? "1" : "0") + '">' +
          '<div class="diff-title">差异辅助</div>' +
          comparisons.map((item) => item.html).join("") +
          '</section>'
        : "";
    }

    function inlineDiffHtml(oldText, newText) {
      const oldValue = String(oldText || "");
      const newValue = String(newText || "");
      if (!oldValue && !newValue) return "";
      if (oldValue === newValue) return escapeHtml(newValue);
      const oldChars = Array.from(oldValue);
      const newChars = Array.from(newValue);
      if (oldChars.length * newChars.length > 50000) {
        return prefixSuffixDiffHtml(oldChars, newChars);
      }
      const width = newChars.length + 1;
      const dp = new Uint16Array((oldChars.length + 1) * width);
      for (let i = 1; i <= oldChars.length; i += 1) {
        for (let j = 1; j <= newChars.length; j += 1) {
          const index = i * width + j;
          dp[index] = oldChars[i - 1] === newChars[j - 1]
            ? dp[(i - 1) * width + j - 1] + 1
            : Math.max(dp[(i - 1) * width + j], dp[i * width + j - 1]);
        }
      }
      const parts = [];
      let i = oldChars.length;
      let j = newChars.length;
      while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldChars[i - 1] === newChars[j - 1]) {
          parts.push({ type: "same", value: oldChars[i - 1] });
          i -= 1;
          j -= 1;
        } else if (j > 0 && (i === 0 || dp[i * width + j - 1] >= dp[(i - 1) * width + j])) {
          parts.push({ type: "ins", value: newChars[j - 1] });
          j -= 1;
        } else {
          parts.push({ type: "del", value: oldChars[i - 1] });
          i -= 1;
        }
      }
      return compactDiffParts(parts.reverse());
    }

    function prefixSuffixDiffHtml(oldChars, newChars) {
      let prefix = 0;
      while (prefix < oldChars.length && prefix < newChars.length && oldChars[prefix] === newChars[prefix]) {
        prefix += 1;
      }
      let oldEnd = oldChars.length;
      let newEnd = newChars.length;
      while (oldEnd > prefix && newEnd > prefix && oldChars[oldEnd - 1] === newChars[newEnd - 1]) {
        oldEnd -= 1;
        newEnd -= 1;
      }
      return [
        escapeHtml(oldChars.slice(0, prefix).join("")),
        oldEnd > prefix ? "<del>" + escapeHtml(oldChars.slice(prefix, oldEnd).join("")) + "</del>" : "",
        newEnd > prefix ? "<ins>" + escapeHtml(newChars.slice(prefix, newEnd).join("")) + "</ins>" : "",
        escapeHtml(oldChars.slice(oldEnd).join("")),
      ].join("");
    }

    function compactDiffParts(parts) {
      const chunks = [];
      for (const part of parts) {
        const last = chunks[chunks.length - 1];
        if (last && last.type === part.type) {
          last.value += part.value;
        } else {
          chunks.push({ ...part });
        }
      }
      return chunks.map((part) => {
        const value = escapeHtml(part.value);
        if (part.type === "ins") return "<ins>" + value + "</ins>";
        if (part.type === "del") return "<del>" + value + "</del>";
        return value;
      }).join("");
    }

    function parseAutomatedNote(note) {
      const lines = String(note || "").split(/\\n+/).map((line) => line.trim()).filter(Boolean);
      if (!automatedNoteMarker(lines[0])) return null;
      if (isAiFailureNote(note)) return null;
      const data = { semantic: "", modify: "", severity: "", revision: "", analysis: "" };
      let currentField = "";
      for (const line of lines.slice(1)) {
        if (line.startsWith("语义是否相同：")) {
          data.semantic = line.slice("语义是否相同：".length).trim();
          currentField = "";
        } else if (line.startsWith("是否需要修改：")) {
          data.modify = line.slice("是否需要修改：".length).trim();
          currentField = "";
        } else if (line.startsWith("严重程度：") || line.startsWith("问题严重程度：")) {
          data.severity = normalizeIssueSeverity(line.replace(/^(问题)?严重程度：/, "").trim());
          currentField = "";
        } else if (line.startsWith("修改结果：") || line.startsWith("修改后：") || line.startsWith("修改后文本：")) {
          data.revision = line.replace(/^(修改结果|修改后|修改后文本)：/, "").trim();
          currentField = "revision";
        } else if (line.startsWith("建议改法：")) {
          data.analysis = [data.analysis, "建议改法：" + line.slice("建议改法：".length).trim()].filter(Boolean).join("\\n");
          currentField = "analysis";
        } else if (line.startsWith("分析：") || line.startsWith("原因：") || line.startsWith("问题：")) {
          data.analysis = line.replace(/^(分析|原因|问题)：/, "").trim();
          currentField = "analysis";
        } else if (line.startsWith("分析过程：")) {
          data.analysis = line.slice("分析过程：".length).trim();
          currentField = "analysis";
        } else if (currentField === "revision") {
          data.revision = [data.revision, line].filter(Boolean).join("\\n");
        } else {
          data.analysis = [data.analysis, line].filter(Boolean).join("\\n");
          currentField = "analysis";
        }
      }
      return data.semantic || data.modify || data.severity || data.revision || data.analysis ? data : null;
    }

    function normalizeIssueSeverity(value) {
      const text = String(value || "").trim().toLowerCase();
      if (["critical", "致命", "高", "high"].includes(text)) return "critical";
      if (["major", "严重", "重大", "主要", "中", "medium"].includes(text)) return "major";
      if (["minor", "轻微", "次要", "低", "low"].includes(text)) return "minor";
      return "";
    }

    function issueSeverityLabel(severity) {
      return { critical: "致命", major: "严重", minor: "轻微" }[severity] || "";
    }

    function renderNoteSummary(noteText) {
      const note = parseAutomatedNote(noteText);
      if (!note) return '<div class="note-summary" hidden></div>';
      const analysis = note.analysis
        ? '<div class="note-detail note-reason"><div class="note-detail-head"><span class="note-summary-key">分析</span></div><div class="note-summary-value">' + escapeHtml(note.analysis) + '</div></div>'
        : "";
      const revision = note.revision
        ? '<div class="note-detail note-revision"><div class="note-detail-head"><span class="note-summary-key">修改结果</span><button type="button" class="copy-revision" data-copy-text="' + escapeHtml(note.revision) + '" title="复制修改结果">复制</button></div><div class="note-summary-value">' + escapeHtml(note.revision) + '</div></div>'
        : "";
      const severity = note.severity
        ? '<div class="note-summary-line"><span class="note-summary-key">严重程度</span><span class="issue-severity-badge is-' + note.severity + '">' + issueSeverityLabel(note.severity) + '</span></div>'
        : "";
      return '<div class="note-summary">' +
        '<div class="note-summary-line"><span class="note-summary-key">语义</span><span class="note-summary-value">' + escapeHtml(note.semantic || "待人工判定") + '</span></div>' +
        '<div class="note-summary-line"><span class="note-summary-key">修改</span><span class="note-summary-value">' + escapeHtml(note.modify || "待人工判定") + '</span></div>' +
        severity +
        analysis +
        revision +
      '</div>';
    }

    function aiBadgeState(item) {
      if (isAiFailureNote(item?.note)) return { cls: "is-failure", text: "AI失败" };
      const marker = automatedNoteMarker(item?.note || "");
      const note = parseAutomatedNote(item?.note || "");
      if (!note) return { cls: "is-off", text: "AI未跑" };
      if (marker === "[规则预筛]") {
        return note.modify === "待人工确认"
          ? { cls: "is-unclear", text: "规则冲突" }
          : { cls: "is-same", text: "规则通过" };
      }
      if (marker === "[相似度预筛]") return { cls: "is-same", text: "相似跳过" };
      if (note.modify === "是") return { cls: "is-modify", text: "AI需改" };
      if (note.modify === "否") return { cls: "is-same", text: "AI不改" };
      return { cls: "is-unclear", text: "AI待判" };
    }

    function rowText(row) {
      const note = combinedNoteText(notes[row.index]);
      return [
        row.index,
        row.chapter,
        row.relation,
        row.jp,
        row.cn,
        row.tw,
        row.twCn,
        note,
      ].join(" ").toLowerCase();
    }

    function renderRow(row) {
      const id = String(row.index);
      const note = notes[id] || { note: "", done: false, manualDone: false, aiDone: false };
      const done = Boolean(note.manualDone);
      const manualNoteText = visibleManualNote(note);
      const manualNoteOpen = manualNoteOpenIds.has(id);
      const aiBadgeStateValue = aiBadgeState(note);
      const aiBadge = '<span class="ai-confirm-badge ' + aiBadgeStateValue.cls + '" data-ai-done="' + id + '">' + aiBadgeStateValue.text + '</span>';
      const classes = [row.cls, done ? "done" : "", activeRowId === id ? "active-row" : "", aiActiveIds.has(id) ? "ai-active" : ""]
        .filter(Boolean)
        .join(" ");
      const cnCopyButton = '<button type="button" class="copy-version" data-copy-text="' + escapeHtml(row.cn || "") + '" title="复制' + escapeHtml(pageLabels.cn) + '">复制</button>';
      const twCopyButton = '<button type="button" class="copy-version" data-copy-text="' + escapeHtml(row.tw || "") + '" title="复制' + escapeHtml(pageLabels.tw) + '">复制</button>';
      const diffBlock = bilingualMode ? "" : renderDiffBlock(row, note.note || "");
      const twPanel = bilingualMode ? "" : '<section class="version-panel"><div class="version-label"><span>' + escapeHtml(pageLabels.tw) + '</span>' + twCopyButton + '</div><div lang="zh-Hant">' + escapeHtml(row.tw) + '</div></section>';
      const twChars = bilingualMode ? "" : ' / ' + escapeHtml(pageLabels.tw) + ' ' + (row.twChars || 0);
      const semanticLine = !bilingualMode && row.jpAlignScoreText
        ? '<div><dt>' + escapeHtml(pageMeta.semanticLabel) + ' 语义</dt><dd>' + escapeHtml(row.jpAlignScoreText) + '</dd></div>'
        : "";
      return [
        '<tr class="' + classes + '" data-score="' + Number(row.score || 0).toFixed(4) + '" data-index="' + id + '">',
        '<td class="meta-cell">',
        '<div class="row-head"><span class="idx">#' + id + '</span><span class="status-dot" aria-label="' + escapeHtml(row.cls) + '"></span></div>',
        '<div class="chapter">' + escapeHtml(row.chapter || "未分章") + '</div>',
        '<dl>',
        '<div><dt>关系</dt><dd>' + escapeHtml(row.relation || "") + '</dd></div>',
        '<div><dt>' + escapeHtml(pageMeta.similarityLabel) + ' 相似</dt><dd>' + escapeHtml(row.scoreText || "") + '</dd></div>',
        semanticLine,
        '<div><dt>字数</dt><dd>' + escapeHtml(pageLabels.jp) + ' ' + (row.jpChars || 0) + ' / ' + escapeHtml(pageLabels.cn) + ' ' + (row.cnChars || 0) + twChars + '</dd></div>',
        '</dl>',
        '</td>',
        '<td class="source-cell" lang="ja">' + escapeHtml(row.jp) + '</td>',
        '<td class="translation-cell">',
        '<div class="version-grid">',
        '<section class="version-panel"><div class="version-label"><span>' + escapeHtml(pageLabels.cn) + '</span>' + cnCopyButton + '</div><div lang="zh-Hans">' + escapeHtml(row.cn) + '</div></section>',
        twPanel,
        '</div>',
        '<div data-diff-slot="' + id + '">' + diffBlock + '</div>',
        '</td>',
        '<td class="note-cell">',
        '<div class="confirm-row">',
        '<div class="confirm-options">',
        '<label class="done-line"><input type="checkbox" data-done="' + id + '"' + (done ? " checked" : "") + '><span>人工确认</span></label>',
        '<label class="manual-note-line"><input type="checkbox" data-note-toggle="' + id + '"' + (manualNoteOpen ? " checked" : "") + '><span>人工批注</span></label>',
        '</div>',
        aiBadge,
        '</div>',
        renderNoteSummary(note.note || ""),
        '<textarea class="note-editor" data-note="' + id + '" aria-label="第 ' + id + ' 行人工备注"' + (manualNoteOpen ? "" : " hidden") + '>' + escapeHtml(manualNoteText) + '</textarea>',
        '</td>',
        '</tr>',
      ].join("");
    }

    function syncNoteEditorHeight(editor) {
      if (!editor) return;
      if (editor.hidden) {
        editor.classList.remove("is-overflowing");
        editor.style.height = "";
        return;
      }
      editor.classList.toggle("has-manual-note", Boolean(editor.value.trim()));
      editor.classList.remove("is-overflowing");
      editor.style.height = "auto";
      const maxHeight = Math.max(120, Math.round(window.innerHeight * 0.4));
      const nextHeight = Math.min(editor.scrollHeight + 2, maxHeight);
      editor.style.height = nextHeight + "px";
      editor.classList.toggle("is-overflowing", editor.scrollHeight > maxHeight);
    }

    function syncVisibleRowLayout() {
      for (const editor of tbody.querySelectorAll(".note-editor")) syncNoteEditorHeight(editor);

      const visibleRows = tbody.querySelectorAll("tr[data-index]").length;
      const fitContent = visibleRows <= 3;
      tableFrame.classList.toggle("is-fit-content", fitContent);
      if (fitContent) {
        wrap.style.setProperty("--results-max-height", "none");
        return;
      }

      const tableTop = tableFrame.getBoundingClientRect().top;
      const viewportGap = 88;
      const available = Math.max(320, window.innerHeight - tableTop - viewportGap);
      wrap.style.setProperty("--results-max-height", available + "px");
    }

    function renderedRow(id) {
      return renderedRowsById.get(String(id)) || null;
    }

    function updateDoneCount() {
      let done = 0;
      let aiDone = 0;
      for (const item of Object.values(notes)) {
        if (item?.manualDone) done += 1;
        if (item?.aiDone) aiDone += 1;
      }
      doneCount.textContent = String(done);
      aiDoneCount.textContent = String(aiDone);
    }

    function totalPages() {
      return Math.max(1, Math.ceil(filteredRows.length / Number(pageSize.value || 100)));
    }

    function updatePaginationStatus() {
      const visible = filteredRows.length;
      const size = Number(pageSize.value || 100);
      const total = totalPages();
      currentPage = Math.max(1, Math.min(currentPage, total));
      const start = visible ? ((currentPage - 1) * size) + 1 : 0;
      const end = visible ? Math.min(currentPage * size, visible) : 0;
      emptyState.classList.toggle("visible", visible === 0);
      paginationBar.classList.toggle("hidden", visible === 0);
      pageInput.value = String(currentPage);
      pageInput.max = String(total);
      pageTotal.textContent = "/ " + total + " 页";
      paginationStatus.textContent = visible
        ? "第 " + start + "-" + end + " 行，共 " + visible + " 行"
        : "没有匹配的行";
      firstPage.disabled = currentPage <= 1;
      prevPage.disabled = currentPage <= 1;
      nextPage.disabled = currentPage >= total;
      lastPage.disabled = currentPage >= total;
    }

    function renderVisibleRows({ reset = false } = {}) {
      if (reset) currentPage = 1;
      const size = Number(pageSize.value || 100);
      const total = totalPages();
      currentPage = Math.max(1, Math.min(currentPage, total));
      const start = (currentPage - 1) * size;
      const slice = filteredRows.slice(start, start + size);
      tbody.innerHTML = slice.map(renderRow).join("");
      renderedRowsById.clear();
      for (const row of tbody.querySelectorAll("tr[data-index]")) renderedRowsById.set(row.dataset.index, row);
      syncVisibleRowLayout();
      updateDoneCount();
      updatePaginationStatus();
    }

    function updateRenderedAiActive() {
      for (const row of tbody.querySelectorAll("tr[data-index]")) {
        row.classList.toggle("ai-active", aiActiveIds.has(row.dataset.index));
      }
    }

    function writeNote(id, note, aiDone, { deferCommit = false } = {}) {
      const current = notes[id] || { note: "", done: false };
      current.aiDone = Boolean(aiDone || current.aiDone || hasAutomatedDecisionNote(note));
      current.done = Boolean(current.manualDone);
      if (!current.note || isAutomatedNoteText(current.note)) {
        current.note = note || current.note;
      } else if (isAutomatedNoteText(note)) {
        current.manualNote = [current.manualNote, current.note].filter(Boolean).join("\\n\\n");
        current.note = note;
      } else if (note && !current.note.includes(note)) {
        current.note = current.note + "\\n\\n" + note;
      }
      cleanAiFailureState(current);
      notes[id] = current;
      pruneEmptyNote(id);
      const rendered = renderedRow(id);
      const textarea = rendered?.querySelector('[data-note]');
      if (textarea) {
        textarea.value = visibleManualNote(notes[id]);
        syncNoteEditorHeight(textarea);
        const summary = textarea.closest(".note-cell")?.querySelector(".note-summary");
        if (summary) {
          const wrapper = document.createElement("div");
          wrapper.innerHTML = renderNoteSummary(notes[id]?.note || "");
          summary.replaceWith(wrapper.firstElementChild);
        }
      }
      const checkbox = rendered?.querySelector('[data-done]');
      if (checkbox) {
        checkbox.checked = Boolean(notes[id]?.manualDone);
        checkbox.closest("tr").classList.toggle("done", checkbox.checked);
      }
      const aiBadge = rendered?.querySelector('[data-ai-done]');
      if (aiBadge) {
        const state = aiBadgeState(notes[id]);
        aiBadge.className = "ai-confirm-badge " + state.cls;
        aiBadge.textContent = state.text;
      }
      const diffSlot = rendered?.querySelector('[data-diff-slot]');
      const row = rowsById.get(id);
      if (diffSlot && row) diffSlot.innerHTML = renderDiffBlock(row, notes[id]?.note || "");
      if (!deferCommit) {
        saveNotes();
        updateDoneCount();
      }
    }

    async function copyText(text) {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
      const helper = document.createElement("textarea");
      helper.value = text;
      helper.setAttribute("readonly", "");
      helper.style.position = "fixed";
      helper.style.left = "-9999px";
      helper.style.top = "0";
      document.body.appendChild(helper);
      helper.select();
      const ok = document.execCommand("copy");
      helper.remove();
      if (!ok) throw new Error("copy failed");
    }

    function aiResultState(row) {
      const note = parseAutomatedNote(notes[String(row.index)]?.note || "");
      if (!note) return "none";
      if (note.modify === "是") return "modify";
      if (note.modify === "否") return "same";
      return "unclear";
    }

    function issueSeverityState(row) {
      const note = parseAutomatedNote(notes[String(row.index)]?.note || "");
      return note?.severity || "unrated";
    }

    function currentAiSameRows() {
      return filteredRows.filter((row) => {
        const item = notes[String(row.index)];
        return aiResultState(row) === "same" && !item?.manualDone;
      });
    }

    function matchesFilter(row, q) {
      const id = String(row.index);
      const hasNote = hasStoredNote(notes[id]);
      const isDone = Boolean(notes[id]?.manualDone);
      const matchesQuery = !q || rowText(row).includes(q);
      const matchesSeverity = severityFilter === "all" || row.cls === severityFilter;
      const matchesAiResult = aiResultFilter === "all" || aiResultState(row) === aiResultFilter;
      const matchesIssueSeverity = issueSeverityFilter === "all" || issueSeverityState(row) === issueSeverityFilter;
      const matchesNotes = !notesOnly || hasNote;
      const matchesDone =
        doneMode === "all" ||
        (doneMode === "open" && !isDone) ||
        (doneMode === "done" && isDone);
      return matchesQuery && matchesSeverity && matchesAiResult && matchesIssueSeverity && matchesNotes && matchesDone;
    }

    function applyFilters({ reset = true } = {}) {
      const q = query.value.trim().toLowerCase();
      filteredRows = allRows.filter((row) => matchesFilter(row, q));
      renderVisibleRows({ reset });
    }

    function scheduleFilter() {
      window.clearTimeout(filterTimer);
      filterTimer = window.setTimeout(() => applyFilters(), 120);
    }

    tbody.addEventListener("input", (event) => {
      const cell = event.target.closest("[data-note]");
      if (cell) {
        syncNoteEditorHeight(cell);
        const id = cell.dataset.note;
        const current = notes[id] || { note: "", done: false };
        setManualNote(current, cell.value.trim());
        notes[id] = current;
        pruneEmptyNote(id);
        const summary = cell.closest(".note-cell")?.querySelector(".note-summary");
        if (summary) {
          const wrapper = document.createElement("div");
          wrapper.innerHTML = renderNoteSummary(current.note);
          summary.replaceWith(wrapper.firstElementChild);
        }
        saveNotes();
        updateDoneCount();
      }
    });

    tbody.addEventListener("blur", (event) => {
      if (event.target.closest("[data-note]")) scheduleFilter();
    }, true);

    tbody.addEventListener("change", (event) => {
      const noteToggle = event.target.closest("[data-note-toggle]");
      if (noteToggle) {
        const id = noteToggle.dataset.noteToggle;
        if (noteToggle.checked) {
          manualNoteOpenIds.add(id);
        } else {
          manualNoteOpenIds.delete(id);
        }
        const editor = tbody.querySelector('[data-note="' + CSS.escape(id) + '"]');
        if (editor) {
          editor.hidden = !noteToggle.checked;
          syncNoteEditorHeight(editor);
        }
        syncVisibleRowLayout();
        return;
      }

      const box = event.target.closest("[data-done]");
      if (box) {
        const id = box.dataset.done;
        const current = notes[id] || { note: "", done: false };
        current.manualDone = box.checked;
        current.done = Boolean(current.manualDone);
        notes[id] = current;
        pruneEmptyNote(id);
        box.closest("tr").classList.toggle("done", box.checked);
        saveNotes();
        updateDoneCount();
        if (doneMode !== "all") applyFilters();
        return;
      }

      const revisionBox = event.target.closest("[data-export-revision]");
      if (revisionBox) {
        const id = revisionBox.dataset.exportRevision;
        if (revisionBox.checked) {
          selectedRevisionIds.add(id);
        } else {
          selectedRevisionIds.delete(id);
        }
      }
    });

    tbody.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-copy-text]");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      const originalText = button.textContent;
      button.disabled = true;
      try {
        await copyText(button.dataset.copyText || "");
        button.textContent = "已复制";
      } catch {
        button.textContent = "复制失败";
      } finally {
        window.setTimeout(() => {
          button.textContent = originalText || "复制";
          button.disabled = false;
        }, 1200);
      }
    });

    tbody.addEventListener("click", (event) => {
      const row = event.target.closest("tbody tr");
      if (!row) return;
      const previous = activeRowId ? renderedRow(activeRowId) : null;
      if (previous) previous.classList.remove("active-row");
      activeRowId = row.dataset.index;
      row.classList.add("active-row");
    });

    query.addEventListener("input", scheduleFilter);
    for (const button of severityButtons) {
      button.addEventListener("click", () => {
        severityFilter = button.dataset.severity;
        for (const item of severityButtons) item.classList.toggle("is-active", item === button);
        applyFilters();
      });
    }
    for (const button of aiResultButtons) {
      button.addEventListener("click", () => {
        aiResultFilter = button.dataset.aiResult;
        for (const item of aiResultButtons) item.classList.toggle("is-active", item === button);
        applyFilters();
      });
    }
    for (const button of issueSeverityButtons) {
      button.addEventListener("click", () => {
        issueSeverityFilter = button.dataset.issueSeverity;
        for (const item of issueSeverityButtons) item.classList.toggle("is-active", item === button);
        applyFilters();
      });
    }
    noteFilter.addEventListener("click", () => {
      notesOnly = !notesOnly;
      noteFilter.classList.toggle("is-active", notesOnly);
      noteFilter.setAttribute("aria-pressed", String(notesOnly));
      applyFilters();
    });
    doneFilter.addEventListener("click", () => {
      doneMode = doneMode === "open" ? "all" : "open";
      const active = doneMode === "open";
      doneFilter.classList.toggle("is-active", active);
      doneFilter.setAttribute("aria-pressed", String(active));
      doneFilter.textContent = "未人工确认";
      applyFilters();
    });
    showSource.addEventListener("change", () => {
      document.documentElement.classList.toggle("hide-source", !showSource.checked);
      syncVisibleRowLayout();
    });
    showTranslationDiff.addEventListener("change", () => {
      document.documentElement.classList.toggle("hide-translation-diff", !showTranslationDiff.checked);
      syncVisibleRowLayout();
    });
    showRevisionDiff.addEventListener("change", () => {
      document.documentElement.classList.toggle("hide-revision-diff", !showRevisionDiff.checked);
      syncVisibleRowLayout();
    });
    aiIds.monitorEnabled.addEventListener("change", () => {
      aiIds.monitorSection.hidden = !aiIds.monitorEnabled.checked;
      if (!aiIds.monitorEnabled.checked) {
        aiIds.monitorState.textContent = "未启用";
        aiIds.requestList.innerHTML = "";
        aiMonitorRenderKey = "";
      }
      saveAiConfig();
      syncVisibleRowLayout();
    });
    aiIds.promptVisible.addEventListener("change", () => {
      aiIds.promptSection.hidden = !aiIds.promptVisible.checked;
      if (aiIds.promptVisible.checked) aiIds.promptSection.open = true;
      saveAiConfig();
      syncVisibleRowLayout();
    });

    function setPage(page) {
      currentPage = Math.max(1, Math.min(Number(page) || 1, totalPages()));
      renderVisibleRows();
      const tableTop = document.querySelector(".table-frame").offsetTop - 12;
      window.scrollTo({ top: tableTop, behavior: "auto" });
    }

    firstPage.addEventListener("click", () => setPage(1));
    prevPage.addEventListener("click", () => setPage(currentPage - 1));
    nextPage.addEventListener("click", () => setPage(currentPage + 1));
    lastPage.addEventListener("click", () => setPage(totalPages()));
    pageInput.addEventListener("change", () => setPage(pageInput.value));
    pageInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") setPage(pageInput.value);
    });
    pageSize.addEventListener("change", () => renderVisibleRows({ reset: true }));

    document.getElementById("clearFilter").addEventListener("click", () => {
      query.value = "";
      severityFilter = "all";
      aiResultFilter = "all";
      issueSeverityFilter = "all";
      notesOnly = false;
      doneMode = "all";
      for (const button of severityButtons) button.classList.toggle("is-active", button.dataset.severity === "all");
      for (const button of aiResultButtons) button.classList.toggle("is-active", button.dataset.aiResult === "all");
      for (const button of issueSeverityButtons) button.classList.toggle("is-active", button.dataset.issueSeverity === "all");
      noteFilter.classList.remove("is-active");
      noteFilter.setAttribute("aria-pressed", "false");
      doneFilter.classList.remove("is-active");
      doneFilter.setAttribute("aria-pressed", "false");
      doneFilter.textContent = "未人工确认";
      showSource.checked = true;
      showTranslationDiff.checked = true;
      showRevisionDiff.checked = true;
      document.documentElement.classList.remove("hide-source", "hide-translation-diff", "hide-revision-diff");
      applyFilters();
    });

    function selectedRevisionEntries() {
      const entries = [];
      for (const row of allRows) {
        const id = String(row.index);
        if (!selectedRevisionIds.has(id)) continue;
        const revision = parseAutomatedNote(notes[id]?.note || "")?.revision || "";
        if (!row.cn || !revision) continue;
        entries.push({ id, searchText: row.cn, replaceText: revision });
      }
      return entries;
    }

    function markRevisionEntriesDone(entries) {
      for (const entry of entries) {
        const current = notes[entry.id] || { note: "", manualNote: "", done: false, manualDone: false, aiDone: false };
        current.manualDone = true;
        current.done = true;
        notes[entry.id] = current;
      }
      saveNotes();
    }

    function shortTimestamp(date = new Date()) {
      const pad = (value) => String(value).padStart(2, "0");
      return pad(date.getMonth() + 1) + pad(date.getDate()) + "-" + pad(date.getHours()) + pad(date.getMinutes());
    }

    function escapePgaText(value) {
      return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;");
    }

    function buildPgaContent(entries) {
      const pairPattern = /(^[ \\t]*)<searchtext>[\\s\\S]*?<\\/searchtext>(\\r?\\n)\\1<replacetext>[\\s\\S]*?<\\/replacetext>/m;
      const match = pgaTemplate.match(pairPattern);
      if (!match) throw new Error("PGA 模板中未找到连续的 searchtext 和 replacetext。");
      const indent = match[1];
      const newline = match[2];
      const replacement = entries.map((entry) =>
        indent + '<searchtext>' + escapePgaText(entry.searchText) + '</searchtext>' + newline +
        indent + '<replacetext>' + escapePgaText(entry.replaceText) + '</replacetext>'
      ).join(newline);
      return pgaTemplate.replace(pairPattern, replacement);
    }

    document.getElementById("acceptAiSame").addEventListener("click", () => {
      const rows = currentAiSameRows();
      if (!rows.length) {
        setTemporaryStatus("当前筛选结果中没有待确认的自动不改行。", 5000);
        return;
      }
      if (!confirm("将当前筛选结果中的 " + rows.length + " 条自动不改行标记为人工确认？")) return;
      for (const row of rows) {
        const id = String(row.index);
        const current = notes[id] || { note: "", manualNote: "", done: false, manualDone: false, aiDone: false };
        current.manualDone = true;
        current.done = true;
        notes[id] = current;
      }
      saveNotes();
      updateDoneCount();
      setTemporaryStatus("已将 " + rows.length + " 条自动不改行标记为人工确认。", 7000);
      applyFilters({ reset: false });
    });

    document.getElementById("exportNotes").addEventListener("click", () => {
      const entries = selectedRevisionEntries();
      if (!entries.length) {
        setTemporaryStatus("请先勾选要导出的修改结果。", 5000);
        return;
      }
      let content;
      try {
        content = buildPgaContent(entries);
      } catch (error) {
        setTemporaryStatus(error.message, 8000);
        return;
      }
      const blob = new Blob([content], { type: "application/xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "修改" + entries.length + "处-" + shortTimestamp() + ".pga";
      a.click();
      URL.revokeObjectURL(url);
      setTemporaryStatus("已导出 " + entries.length + " 处修改结果；勾选状态已保留，可继续确认。", 5000);
    });

    document.getElementById("confirmRevisions").addEventListener("click", () => {
      const entries = selectedRevisionEntries();
      if (!entries.length) {
        setTemporaryStatus("请先勾选要确认的修改结果。", 5000);
        return;
      }
      if (!confirm("将当前勾选的 " + entries.length + " 处修改结果标记为人工确认？")) return;
      markRevisionEntriesDone(entries);
      selectedRevisionIds.clear();
      applyFilters({ reset: false });
      setTemporaryStatus("已将 " + entries.length + " 处修改结果标记为人工确认。", 5000);
      tableFrame.scrollTop = 0;
    });

    function aiConfig() {
      return {
        provider: aiIds.provider.value,
        baseUrl: aiIds.baseUrl.value,
        model: aiIds.model.value,
        apiKey: aiIds.apiKey.value,
        proofreadMode: aiIds.proofreadMode.value,
        target: aiIds.target.value,
        concurrency: Number(aiIds.concurrency.value),
        similarityThreshold: parsePercentRatio(aiIds.similarity.value),
        systemPrompt: aiIds.prompt.value,
        labels: pageLabels,
        projectKey: pageMeta.projectKey || "",
        rowsSignature: pageMeta.rowsSignature || "",
        completedIndexes: [...new Set(Object.entries(notes)
          .filter(([, item]) => item?.manualDone)
          .map(([id]) => Number(id))
          .filter((id) => Number.isInteger(id) && id > 0))],
        monitorEnabled: aiIds.monitorEnabled.checked,
      };
    }

    function setProviderHint(defaults) {
      if (!defaults) return;
      aiIds.apiKey.placeholder = defaults.apiKeyPlaceholder || "";
      if (!aiIds.status.dataset.runtimeMessage) {
        aiIds.status.textContent = defaults.note || "等待启动 AI 校对。";
      }
    }

    function applyProviderDefaults(defaults, { force = false } = {}) {
      if (!defaults) return;
      if (force || !aiIds.baseUrl.dataset.touched) {
        aiIds.baseUrl.value = defaults.baseUrl || "";
      }
      if ((force || !aiIds.model.dataset.touched) && !aiModelOptions.length) {
        setModelOptions([defaults.model], { selected: defaults.model || "" });
      }
      setProviderHint(defaults);
    }

    function formatDuration(ms) {
      const value = Math.max(0, Number(ms) || 0);
      const seconds = Math.floor(value / 1000);
      if (seconds < 60) return seconds + " 秒";
      const minutes = Math.floor(seconds / 60);
      return minutes + " 分 " + String(seconds % 60).padStart(2, "0") + " 秒";
    }

    function requestStateLabel(request) {
      if (request.state === "waiting") return "等待接口返回";
      if (request.state === "done") return "已返回";
      if (request.state === "error") return "调用失败";
      if (request.state === "stopped") return "已终止";
      return request.state || "未知";
    }

    function renderAiMonitor(ai) {
      const enabled = Boolean(ai.monitorEnabled);
      aiIds.monitorSection.hidden = !enabled;
      if (!enabled) {
        aiIds.monitorState.textContent = "未启用";
        if (aiMonitorRenderKey) aiIds.requestList.innerHTML = "";
        aiMonitorRenderKey = "";
        aiRequestCache.clear();
        return;
      }
      const hydrateRequest = (request) => {
        const id = String(request.id || "");
        const hydrated = { ...(aiRequestCache.get(id) || {}), ...request };
        if (id) aiRequestCache.set(id, hydrated);
        return hydrated;
      };
      const active = (ai.activeRequests || []).map(hydrateRequest);
      const recent = (ai.recentRequests || []).map(hydrateRequest);
      const retainedIds = new Set([...active, ...recent].map((request) => String(request.id || "")));
      for (const id of aiRequestCache.keys()) {
        if (!retainedIds.has(id)) aiRequestCache.delete(id);
      }
      const items = [...active, ...recent].slice(0, 10);
      const sharedSystemMessage = findSharedSystemMessage(items);
      if (active.length) {
        const slow = active.filter((request) => (request.elapsedMs || 0) > 30000).length;
        aiIds.monitorState.textContent = slow
          ? active.length + " 个请求等待中，" + slow + " 个超过 30 秒"
          : active.length + " 个请求等待中";
      } else if (recent.length) {
        aiIds.monitorState.textContent = ai.running ? "暂无等待中的接口请求" : "最近请求已完成";
      } else {
        aiIds.monitorState.textContent = ai.running ? "正在准备请求" : "尚未启动";
      }
      if (!items.length) {
        const emptyKey = "empty:" + String(ai.running);
        if (aiMonitorRenderKey !== emptyKey) {
          aiIds.requestList.innerHTML = '<div class="ai-request-empty">启动 AI 校对后，这里会显示程序发给模型的问题和接口等待状态。</div>';
          aiMonitorRenderKey = emptyKey;
        }
        return;
      }
      const renderKey = JSON.stringify(items.map((request) => [
        request.id,
        request.state,
        request.finishedAt,
        request.responsePreview,
        request.error,
      ]));
      if (aiMonitorRenderKey === renderKey) {
        for (const request of items) {
          const item = aiIds.requestList.querySelector('[data-request-id="' + CSS.escape(String(request.id)) + '"]');
          const time = item?.querySelector(".ai-request-time");
          if (time) time.textContent = formatDuration(request.elapsedMs);
        }
        return;
      }
      aiIds.requestList.innerHTML = [
        renderSharedSystemMessage(sharedSystemMessage),
        ...items.map((request, index) => renderAiRequest(request, index === 0)),
      ].filter(Boolean).join("");
      aiMonitorRenderKey = renderKey;
      bindDetailsToggle(aiIds.requestList);
    }

    function findSharedSystemMessage(requests) {
      for (const request of requests) {
        const message = (request.messages || []).find((item) => item.role === "system");
        if (message?.content) return message.content;
      }
      return "";
    }

    function renderSharedSystemMessage(content) {
      if (!content) return "";
      return '<details class="ai-message ai-shared-message">' +
        '<summary class="ai-request-summary">' +
          '<div class="ai-request-main"><span class="ai-request-pill">system</span><span>共享系统提示词</span></div>' +
          '<button class="details-toggle" type="button" data-details-toggle aria-label="折叠或展开共享系统提示词"></button>' +
        '</summary>' +
        '<pre>' + escapeHtml(content) + '</pre>' +
      '</details>';
    }

    function renderAiRequest(request, open) {
      const state = requestStateLabel(request);
      const elapsed = formatDuration(request.elapsedMs);
      const classes = [
        "ai-request",
        request.state === "waiting" ? "is-waiting" : "",
        request.state === "waiting" && (request.elapsedMs || 0) > 30000 ? "is-slow" : "",
        request.state === "error" ? "is-error" : "",
      ].filter(Boolean).join(" ");
      const messages = (request.messages || []).filter((message) => message.role !== "system").map((message) =>
        '<div class="ai-message">' +
          '<div class="ai-message-role">' + escapeHtml(message.role || "message") + '</div>' +
          '<pre>' + escapeHtml(message.content || "") + '</pre>' +
        '</div>'
      ).join("");
      const response = request.responsePreview
        ? '<div class="ai-response-preview">' + escapeHtml(request.responsePreview) + '</div>'
        : "";
      const error = request.error
        ? '<div class="ai-response-preview">' + escapeHtml(request.error) + '</div>'
        : "";
      return '<details class="' + classes + '" data-request-id="' + escapeHtml(request.id || "") + '"' + (open ? " open" : "") + '>' +
        '<summary class="ai-request-summary">' +
          '<div class="ai-request-main">' +
            '<span class="ai-request-pill">' + escapeHtml(state) + '</span>' +
            '<span>第 ' + escapeHtml(request.rowIndex) + ' 行</span>' +
            '<span>' + escapeHtml(request.stageLabel || request.stage || "") + '</span>' +
            '<span>' + escapeHtml(request.model || "") + '</span>' +
          '</div>' +
          '<div class="ai-request-time">' + elapsed + '</div>' +
          '<button class="details-toggle" type="button" data-details-toggle aria-label="折叠或展开第 ' + escapeHtml(request.rowIndex) + ' 行请求详情"></button>' +
        '</summary>' +
        '<div class="ai-request-body">' + messages + response + error + '</div>' +
      '</details>';
    }

    function renderAiStatus(ai) {
      if (!ai) return;
      const aiRunId = ai.runId || "";
      if (aiRunId && lastAiRunId && aiRunId !== lastAiRunId) {
        appliedAiResults.clear();
        lastAiResultRevision = 0;
        aiMonitorRenderKey = "";
        aiRequestCache.clear();
      }
      if (aiRunId) lastAiRunId = aiRunId;
      const sameAiScope = Boolean(
        ai.projectKey &&
        ai.rowsSignature &&
        ai.projectKey === pageMeta.projectKey &&
        ai.rowsSignature === pageMeta.rowsSignature
      );
      if (aiRunId && clearedAiRunIds.has(aiRunId) && !ai.running) {
        renderClearedAiStatus();
        return;
      }
      if (ai.running) {
        aiIds.status.dataset.cacheCleared = "";
      }
      renderAiMonitor(ai);
      if (ai.providerDefaults) {
        providerDefaults = ai.providerDefaults;
        applyProviderDefaults(providerDefaults[aiIds.provider.value]);
      }
      if (sameAiScope && ai.proofreadPrompt?.system) {
        const previousDefault = defaultProofreadPrompt;
        defaultProofreadPrompt = ai.proofreadPrompt.system;
        if (!aiIds.prompt.dataset.touched || aiIds.prompt.value === previousDefault) {
          aiIds.prompt.value = defaultProofreadPrompt;
        }
      }
      aiIds.start.disabled = Boolean(ai.running);
      aiIds.stop.disabled = !ai.running;
      aiIds.monitorEnabled.disabled = Boolean(ai.running);
      aiIds.monitorSection.hidden = !Boolean(ai.monitorEnabled);
      const aiTotal = Math.max(0, ai.queued || 0);
      const done = ai.modelProcessed || 0;
      const total = Math.max(1, aiTotal);
      const rowTotal = Math.max(0, ai.total || 0);
      const skippedDone = Math.min(rowTotal || Infinity, Math.max(0, ai.skippedDone || 0));
      const prefiltered = Math.min(rowTotal || Infinity, Math.max(0, ai.prefiltered || 0));
      const rulePrefiltered = Math.min(rowTotal || Infinity, Math.max(0, ai.rulePrefiltered || 0));
      const similarityPrefiltered = Math.min(rowTotal || Infinity, Math.max(0, ai.similarityPrefiltered || 0));
      const structuredConflicts = Math.min(rowTotal || Infinity, Math.max(0, ai.structuredConflicts || 0));
      aiIds.progress.style.width = Math.min(100, Math.round((done / total) * 100)) + "%";
      aiIds.progressWrap.hidden = !ai.running && done === 0 && !prefiltered;
      const queueText = done + "/" + aiTotal;
      const skipText = "人工确认跳过 " + skippedDone;
      const prefilterText = "规则跳过 " + rulePrefiltered + "，结构化冲突 " + structuredConflicts + "，相似度跳过 " + similarityPrefiltered;
      if (!isStatusMessageLocked()) {
        if (ai.running) {
          setRuntimeStatus("AI 校对中：实际调用 " + queueText + "，" + skipText + "，" + prefilterText + "，建议 " + (ai.suggested || 0) + "，错误 " + (ai.errors || 0));
        } else if (ai.finishedAt) {
          setRuntimeStatus((ai.stopRequested ? "AI 校对已终止：" : "AI 校对完成：") + "实际调用 " + queueText + "，" + skipText + "，" + prefilterText + "，建议 " + (ai.suggested || 0) + "，错误 " + (ai.errors || 0));
        } else if (ai.error) {
          setRuntimeStatus(ai.error);
        }
      }
      const previousActive = Array.from(aiActiveIds).join(",");
      aiActiveIds.clear();
      for (const id of (ai.active || []).map(String)) aiActiveIds.add(id);
      const nextActive = Array.from(aiActiveIds).join(",");
      if (previousActive !== nextActive) updateRenderedAiActive();
      let appliedResult = false;
      let skippedStaleResults = 0;
      const pendingResults = [];
      if (sameAiScope) {
        for (const result of ai.results || []) {
          const key = result.runId + ":" + result.index + ":" + (result.resultRevision || result.status);
          if (appliedAiResults.has(key)) continue;
          appliedAiResults.add(key);
          const currentRow = rowsById.get(String(result.index));
          if (currentRow?.signature && result.signature !== currentRow.signature) {
            skippedStaleResults += 1;
            continue;
          }
          appliedResult = true;
          pendingResults.push(result);
        }
        for (const result of pendingResults) {
          writeNote(String(result.index), result.note || "", Boolean(result.done), { deferCommit: true });
        }
        if (pendingResults.length) {
          saveNotes();
          updateDoneCount();
        }
        if (skippedStaleResults && !isStatusMessageLocked()) {
          setRuntimeStatus("已跳过 " + skippedStaleResults + " 条与当前工作台行内容不匹配的自动结果。");
        }
      } else if ((ai.results || []).length && !ai.running && !isStatusMessageLocked()) {
        setRuntimeStatus("已忽略非当前项目快照的自动结果；当前项目备注保持独立。");
      }
      lastAiResultRevision = Math.max(lastAiResultRevision, Number(ai.resultRevision) || 0);
      if (appliedResult && (query.value.trim() || notesOnly || doneMode !== "all" || aiResultFilter !== "all" || issueSeverityFilter !== "all")) {
        applyFilters({ reset: false });
      }
    }

    async function refreshAiStatus() {
      if (aiStatusRefreshInFlight) return;
      aiStatusRefreshInFlight = true;
      let hasMoreResults = false;
      try {
        const params = new URLSearchParams({ compact: "1", resultLimit: "64" });
        if (lastAiRunId) {
          params.set("runId", lastAiRunId);
          params.set("afterRevision", String(lastAiResultRevision));
          for (const id of aiRequestCache.keys()) params.append("knownRequestId", id);
        }
        const response = await fetch("/api/ai-proofread/status?" + params);
        const data = await response.json();
        if (data.ok) {
          renderAiStatus(data.ai);
          hasMoreResults = Boolean(data.ai?.hasMoreResults);
        }
      } catch {
        if (aiIds.status.dataset.cacheCleared) return;
        if (!isStatusMessageLocked()) setRuntimeStatus("未连接到本地控制台服务，AI 校对需要通过 npm run setup 打开工作台。");
      } finally {
        aiStatusRefreshInFlight = false;
        if (hasMoreResults && !aiCatchupTimer) {
          aiCatchupTimer = window.setTimeout(() => {
            aiCatchupTimer = 0;
            refreshAiStatus();
          }, 16);
        }
      }
    }

    function setModelOptions(models, { selected = aiIds.model.value } = {}) {
      const resolved = resolveModelOptions(models, selected);
      aiModelOptions = resolved.models;
      aiIds.model.replaceChildren(...resolved.options.map((value) => {
        const item = document.createElement("option");
        item.value = value;
        item.textContent = value === "custom" ? "自定义..." : value;
        return item;
      }));
      aiIds.model.value = resolved.selected;
      syncEnhancedSelect(aiIds.model);
    }

    async function refreshAiModels() {
      aiIds.refreshModels.disabled = true;
      const previousStatus = aiIds.status.textContent;
      const requestedProvider = aiIds.provider.value;
      const requestedBaseUrl = normalizeApiBaseUrl(aiIds.baseUrl.value);
      setTemporaryStatus("正在获取可用模型...", 15000);
      try {
        const response = await fetch("/api/ai-proofread/models", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider: aiIds.provider.value,
            baseUrl: aiIds.baseUrl.value,
            apiKey: aiIds.apiKey.value,
          }),
        });
        const data = await response.json();
        if (!data.ok) throw new Error(data.error);
        const currentBaseUrl = normalizeApiBaseUrl(aiIds.baseUrl.value);
        if (aiIds.provider.value !== requestedProvider || currentBaseUrl !== requestedBaseUrl) {
          setTemporaryStatus("接口地址已变更，已忽略旧地址返回的模型列表。", 5000);
          return;
        }
        const models = data.models?.models || data.models || [];
        const defaultModel = providerDefaults[aiIds.provider.value]?.model || "";
        const wasDefault = !aiIds.model.dataset.touched || aiIds.model.value === defaultModel;
        const selectedModel = wasDefault && models[0]?.id ? models[0].id : aiIds.model.value;
        setModelOptions(models, { selected: selectedModel });
        aiIds.model.dataset.touched = "1";
        if (data.models?.warning) {
          setTemporaryStatus("已使用内置模型列表：" + models.length + " 个模型。");
        } else {
          setTemporaryStatus(models.length
          ? "已获取 " + models.length + " 个模型，可在模型下拉框中选择。"
          : "没有从接口返回模型列表，可手动输入模型名。");
        }
      } catch (error) {
        setTemporaryStatus("获取模型失败：" + error.message + "。可手动输入模型名。");
      } finally {
        aiIds.refreshModels.disabled = false;
        saveAiConfig();
        if (!aiIds.status.textContent && previousStatus) aiIds.status.textContent = previousStatus;
      }
    }

    aiIds.provider.addEventListener("change", async () => {
      aiIds.baseUrl.dataset.touched = "";
      aiIds.model.dataset.touched = "";
      aiModelOptions = [];
      aiIds.status.dataset.runtimeMessage = "";
      statusMessageLockedUntil = 0;
      if (providerDefaults[aiIds.provider.value]) {
        applyProviderDefaults(providerDefaults[aiIds.provider.value], { force: true });
        saveAiConfig();
        return;
      }
      try {
        const response = await fetch("/api/ai-proofread/status");
        const data = await response.json();
        providerDefaults = data.ai?.providerDefaults || providerDefaults;
        applyProviderDefaults(providerDefaults[aiIds.provider.value], { force: true });
      } catch {
        setProviderHint(null);
      }
      saveAiConfig();
    });
    aiIds.baseUrl.addEventListener("input", () => {
      aiIds.baseUrl.dataset.touched = "1";
      aiIds.model.dataset.touched = "";
      setModelOptions([], { selected: "" });
      setTemporaryStatus("地址已修改，可点击刷新获取模型列表。", 5000);
      saveAiConfig();
    });
    aiIds.baseUrl.addEventListener("change", () => {
      setTemporaryStatus("地址已更新，可点击刷新获取模型列表。", 8000);
      saveAiConfig();
    });
    aiIds.model.addEventListener("input", () => {
      aiIds.model.dataset.touched = "1";
      saveAiConfig();
    });
    aiIds.model.addEventListener("change", () => {
      aiIds.model.dataset.touched = "1";
      if (aiIds.model.value === "custom") {
        const value = prompt("输入模型名", "") || "";
        if (value.trim()) {
          setModelOptions([...aiModelOptions, value.trim()], { selected: value.trim() });
          aiIds.model.value = value.trim();
        }
      }
      saveAiConfig();
    });
    [aiIds.apiKey, aiIds.target, aiIds.concurrency, aiIds.proofreadMode].forEach((input) => {
      input.addEventListener("input", saveAiConfig);
      input.addEventListener("change", saveAiConfig);
    });
    aiIds.proofreadMode.addEventListener("change", updateProofreadModeHint);
    aiIds.similarity.addEventListener("input", saveAiConfig);
    aiIds.similarity.addEventListener("change", () => {
      normalizeSimilarityInput();
      saveAiConfig();
    });
    aiIds.prompt.addEventListener("input", () => {
      aiIds.prompt.dataset.touched = "1";
      saveAiPrompt();
    });
    aiIds.promptReset.addEventListener("click", () => {
      aiIds.prompt.value = defaultProofreadPrompt;
      aiIds.prompt.dataset.touched = "";
      aiIds.prompt.focus();
      saveAiPrompt();
    });
    aiIds.refreshModels.addEventListener("click", refreshAiModels);
    window.addEventListener("resize", syncVisibleRowLayout);
    window.addEventListener("pagehide", flushNotes);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) flushNotes();
    });
    aiIds.start.addEventListener("click", async () => {
      statusMessageLockedUntil = 0;
      aiIds.start.disabled = true;
      const monitorEnabled = aiIds.monitorEnabled.checked;
      aiIds.monitorEnabled.disabled = true;
      aiIds.status.dataset.cacheCleared = "";
      aiIds.panel.open = true;
      aiIds.monitorSection.hidden = !monitorEnabled;
      aiIds.monitorSection.open = monitorEnabled;
      if (!monitorEnabled) {
        aiIds.monitorState.textContent = "未启用";
        aiIds.requestList.innerHTML = "";
        aiMonitorRenderKey = "";
      }
      setRuntimeStatus("正在启动 AI 校对...");
      try {
        const response = await fetch("/api/ai-proofread/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(aiConfig()),
        });
        const data = await response.json();
        if (!data.ok) throw new Error(data.error);
        renderAiStatus(data.ai);
        refreshAiStatus();
      } catch (error) {
        setRuntimeStatus(error.message);
        aiIds.start.disabled = false;
        aiIds.monitorEnabled.disabled = false;
      }
    });
    aiIds.stop.addEventListener("click", async () => {
      statusMessageLockedUntil = 0;
      aiIds.stop.disabled = true;
      setRuntimeStatus("正在终止 AI 校对...");
      try {
        const response = await fetch("/api/ai-proofread/stop", { method: "POST" });
        const data = await response.json();
        if (data.ok) {
          renderAiStatus(data.ai);
          refreshAiStatus();
        }
      } catch (error) {
        setRuntimeStatus(error.message);
      } finally {
        aiIds.monitorEnabled.disabled = false;
      }
    });
    aiIds.clearCache.addEventListener("click", async () => {
      statusMessageLockedUntil = 0;
      if (aiIds.stop.disabled === false) {
        setRuntimeStatus("AI 校对仍在运行，请先停止任务再清除 AI 记录。");
        return;
      }
      if (!confirm("清除 AI 运行记录和对话监控？备注与人工确认不会被清除。")) return;
      aiIds.clearCache.disabled = true;
      setRuntimeStatus("正在清除 AI 记录...");
      if (lastAiRunId) clearedAiRunIds.add(lastAiRunId);
      clearLocalAiCache();
      renderClearedAiStatus();
      try {
        const response = await fetch("/api/ai-proofread/cache/clear", { method: "POST" });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "清除失败。");
        if (data.ai?.runId) clearedAiRunIds.add(data.ai.runId);
        renderClearedAiStatus();
      } catch (error) {
        if (error instanceof TypeError || /Unknown local API endpoint|清除失败/.test(error.message || "")) {
          renderClearedAiStatus("已清除本页 AI 对话监控；备注与人工确认已保留。本地服务重启后可同步清除后台记录。");
        } else {
          setRuntimeStatus(error.message);
        }
      } finally {
        aiIds.clearCache.disabled = false;
      }
    });
    bindDetailsToggle();
    document.querySelectorAll("select").forEach(enhanceSelect);
    restoreAiConfig();
    document.querySelectorAll("select").forEach(syncEnhancedSelect);
    refreshAiStatus();
    setInterval(refreshAiStatus, 1500);
    applyFilters();
  </script>
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
