const fs = require("fs");
const path = require("path");
const { outputDir, loadParagraphs } = require("./text-utils");
const { describeSelection, resolveInputSelection, saveSelection, selectionFile } = require("./input-selection");

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const selection = await resolveInputSelection({ promptIfSaved: true });
  saveSelection(selection);

  const paragraphs = {
    comparisonMode: selection.comparisonMode || "trilingual",
    ...(await loadParagraphs(selection)),
  };
  const outFile = path.join(outputDir, "paragraphs.json");
  fs.writeFileSync(outFile, JSON.stringify(paragraphs, null, 2), "utf8");

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
