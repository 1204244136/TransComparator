const fs = require("fs");
const path = require("path");
const { outputDir, loadParagraphs } = require("./text-utils");
const { describeSelection, resolveInputSelection, saveSelection, selectionFile } = require("./input-selection");

const progressPrefix = "@@transcomparator-progress@@";

function reportProgress(percent, label) {
  if (process.env.TRANS_COMPARATOR_MACHINE_PROGRESS !== "1") return;
  console.log(`${progressPrefix}${JSON.stringify({ percent, label })}`);
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  reportProgress(1, "读取输入配置");
  const selection = await resolveInputSelection({ promptIfSaved: true });
  saveSelection(selection);

  reportProgress(3, "转换并清理源文本");
  const paragraphs = {
    comparisonMode: selection.comparisonMode || "trilingual",
    ...(await loadParagraphs(selection)),
  };
  const outFile = path.join(outputDir, "paragraphs.json");
  fs.writeFileSync(outFile, JSON.stringify(paragraphs, null, 2), "utf8");
  reportProgress(8, "段落导出完成");

  console.log("Input files:");
  console.log(describeSelection(selection));
  console.log(`JP paragraphs: ${paragraphs.jp.length}`);
  console.log(`CN paragraphs: ${paragraphs.cn.length}`);
  console.log(`TW paragraphs: ${paragraphs.tw.length}`);
  console.log(`Saved input selection: ${selectionFile}`);
  console.log(`Wrote ${outFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
