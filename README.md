# TransComparator

TransComparator 是一个本地、文件型的文本对齐与翻译校对工作台。它把一份原文和一到两份同级译文/版本文本整理成可浏览的 HTML 工作台，并同时输出 CSV 与 JSON，方便逐段校对、比较差异和记录备注。

项目默认在本机运行：源文本路径、清洗后的段落、对齐结果和备注数据都留在本地，公开仓库只提交程序代码与文档。

## 功能

- 双语 / 三语模式：一份原文加一到两份同级非原文文本（不同译本、校订本或地区版本）。
- 支持 TXT、EPUB，以及 Pandoc 可读取的 DOCX、HTML、ODT、Markdown、RTF 等格式。
- Pandoc 转 plain text 后自动过滤目录、封面、后记、版权页、特典、媒体占位等非正文块。
- OpenCC 中文简繁归一化，方便比较不同中文版本。
- 跨语言语义模型生成原文与非原文文本之间的段落组，并对齐两份非原文文本、高亮差异。
- 输出本地 HTML 工作台，人工备注保存在浏览器 `localStorage`。
- 可选接入 OpenAI-compatible 或 Ollama 本地接口，按行辅助校对并写入工作台备注。

## 文本语义

比较入口是一份原文和一到两份非原文文本。非原文文本是同级材料，可以是不同译本、校订本或地区版本；程序内部可能选择其中一份作为技术 pivot，但这不表示它更权威。原文是准入边界：不存在于原文的内容（例如特典、附录、版权页、后记、译注）不应进入最终比较。

## 环境要求

- Node.js 18+、Python 3.12、Pandoc。
- 可选：CUDA/ROCm 可用的 PyTorch（加速对齐）；本地模型服务（AI 校对，如 Ollama）。

一键初始化全部依赖：

```powershell
npm run setup:env
```

该命令执行 `npm install`、创建 `.venv` 并安装 Python 依赖、安装/检查 Pandoc。需要跳过自动安装或重建环境时，可带参数运行脚本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-env.ps1 -NoInstallPython   # 跳过自动安装 Python
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-env.ps1 -NoInstallPandoc   # 跳过自动安装 Pandoc
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-env.ps1 -RecreateVenv      # 重建 .venv
```

可选安装 GPU 加速版 PyTorch（自动按本机显卡、驱动和 CUDA/ROCm 支持情况选择）：

```powershell
npm run detect:accelerator
npm run setup:accelerator
```

无 GPU 时可在 CPU 上运行对齐：

```powershell
$env:TRANS_COMPARATOR_ALLOW_CPU = "1"
npm run align:jp
```

## 快速开始

```powershell
npm run setup:env   # 仅首次
npm run setup
```

在浏览器打开终端显示的地址（通常为 `http://127.0.0.1:4317/`），为每个角色导入文件（点击或拖拽），保存选择后点击“生成”。本地服务会依次运行段落导出、跨语言对齐和工作台构建，完成后归档项目并提供工作台入口，之后可在控制台切换已生成项目。

角色：双语模式 `A` 为原文、`B` 为译文；三语模式 `A` 为原文，`B`、`C` 为同级译文/版本。源文本建议放在仓库外部，不要把真实作品文本、个人路径或生成结果提交到公开仓库。

## 命令行用法

```powershell
npm run export:paragraphs            # 导出清洗后的段落
npm run align:jp                      # 跨语言对齐（先检查加速环境并重新导出）
npm run build                         # 构建 HTML、CSV、JSON 工作台
npm run align:jp && npm run build     # 完整流程
```

命令行可从目录推断或显式指定文件：

```powershell
npm run export:paragraphs -- --input-dir "C:\path\to\texts"
npm run export:paragraphs -- --jp "C:\path\source.epub" --cn "C:\path\version-a.epub" --tw "C:\path\version-b.epub"
```

若 Pandoc 不在 `PATH` 中，可设置 `PANDOC_BIN` 指向 `pandoc.exe`；EPUB 在 Pandoc 不可用时自动回退到内置 reader。

## 输出文件

输出目录 `out/` 默认不提交到 Git，按职责分区：

- `out/runtime/`：当前输入选择、浏览器导入文件、命令行临时工作目录。
- `out/projects/<projectKey>/snapshots/<snapshotId>/`：不可变项目快照，含 `paragraphs.json`、`jp-align.json` 与三种 `translation-compare.*` 输出。
- `out/active-project.json`：当前活动项目的小型指针文件。

每个项目默认保留最近两个快照；切换项目只更新指针与输入选择，不复制大型生成物。备注保存在浏览器 `localStorage`，不会写回源文本。

## 预筛选与 AI 校对

预筛选是独立模块，不调用模型：先按确定性规则统一繁简、全半角、空白与不可见字符，再对足够长度的正文做相似度预筛，结果写入备注并统计。

AI 校对需通过 `npm run setup` 打开的本地服务访问（直接双击 HTML 只能使用人工备注）。支持 OpenAI-compatible（Ollama、LM Studio、vLLM、llama.cpp 等）、Claude 原生 Messages API 和本地默认三类服务；启动前选择校对目标列与并发数，调用前会先跑预筛，只对剩余行调用模型。所有自动结果实时写入当前项目快照的备注空间。EPUB 注释标记（`noteref`）会逐字原位保留，不参与翻译语义判断。

## 开源致谢

TransComparator 的实现参考并借助了多个开源项目和开放生态组件：

- [Pandoc](https://pandoc.org/)：格式转换。
- [OpenCC.js](https://github.com/nk2028/opencc-js)：中文简繁归一化。
- [jsdiff](https://github.com/kpdecker/jsdiff)：非原文文本之间的词级差异高亮。
- [JSZip](https://github.com/Stuk/jszip)、[fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser)、[html-to-text](https://github.com/html-to-text/node-html-to-text)：内置 EPUB 诊断/fallback 路径。
- [Sentence Transformers](https://www.sbert.net/) 与 `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`：跨语言段落对齐。
- [PyTorch](https://pytorch.org/)、[NumPy](https://numpy.org/)：模型推理与向量计算。
- [Claude API](https://platform.claude.com/docs/en/api/overview)、[Ollama](https://ollama.com/) 及 OpenAI-compatible 生态：可选 AI 辅助校对。
- [CC Switch](https://github.com/farion1231/cc-switch)：接口与本地模型服务接入思路参考。
- [Transformers.js](https://github.com/xenova/transformers.js)：本地文本向量化实验与后续推理方向的基础组件。

## 常见问题

- **Pandoc 未安装**：运行 `npm run check:pandoc`，或设置 `PANDOC_BIN` 指向 `pandoc.exe`。
- **输出里出现后记、特典或版权页**：调整 `scripts/text-utils.js` 的正文结束规则后重新运行 `npm run align:jp && npm run build`。
- **章节标题进入正文**：补充 `scripts/text-utils.js` 的章节/行间标题识别规则后重新生成。
- **对齐发生连锁错位**：先检查快照中 `paragraphs.json` 是否混入图片占位、页码、脚注或元信息，再重新运行对齐与构建。

## 公开仓库注意事项

提交前确认以下内容没有被纳入版本控制：

- `.venv/`、`node_modules/`、`out/`、`.codegraph/` 等本地目录。
- 源文本文件（TXT、EPUB、DOCX、PDF、ODT、RTF 等）。
- `out/runtime/input-selection.json`（含本机绝对路径）。
- README、脚本或页面中的个人目录、真实作品名、API Key 或模型密钥。

可用 `git status --short` 和 `git ls-files --others --exclude-standard` 检查将被 Git 追踪的文件。
