const { execFile } = require("child_process");

const pandocBin = process.env.PANDOC_BIN || "pandoc";

execFile(pandocBin, ["--version"], { encoding: "utf8" }, (error, stdout) => {
  if (error) {
    console.log("Pandoc not found.");
    console.log("Run npm run setup:env to install Pandoc automatically on Windows, or set PANDOC_BIN.");
    console.log("Runtime fallback: EPUB input can use the built-in OPF/nav/spine reader, but other non-TXT formats require Pandoc.");
    process.exit(0);
  }

  const firstLine = stdout.split(/\r?\n/).find(Boolean) || "pandoc";
  console.log(`Pandoc available: ${firstLine}`);
  console.log("Non-TXT inputs use Pandoc by default, then TransComparator applies main-body filtering.");
});
