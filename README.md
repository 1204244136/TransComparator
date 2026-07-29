# TransComparator

TransComparator 是一个本地、文件型文本对齐与翻译校对工作台。它把一份原文和一到两份同级译文/版本文本整理成可浏览的 HTML 工作台，并同时输出 CSV 与 JSON，方便逐段校对、比较差异和记录备注。

项目默认在本机运行，不上传源文本。源文本路径、清洗后的段落、对齐结果和备注数据都应留在本地，公开仓库只提交程序代码与文档。

## 功能

- 支持双语和三语两种模式：双语为一份原文加一份译文；三语为一份原文加两份同级非原文文本。
- 支持 TXT、EPUB，以及 Pandoc 可读取的 DOCX、HTML、ODT、Markdown、RTF 等格式。
- 使用 Pandoc 把非 TXT 文件转换为 plain text，再过滤目录、封面、后记、版权页、特典、媒体占位等非正文块。
- 使用 OpenCC 做中文简繁归一化，方便比较不同中文版本。
- 使用跨语言语义模型生成原文与非原文文本之间的段落组。
- 对齐两份非原文文本并高亮差异。
- 输出本地 HTML 工作台，人工备注保存在浏览器 `localStorage`。
- 可连接 OpenAI-compatible 或 Ollama 本地接口，按行辅助校对并写入工作台备注。

## 文本语义

TransComparator 的比较入口是一份原文和一到两份非原文文本。两份非原文文本在产品语义上是同级材料，可以是不同译本、校订本或地区版本；程序内部可能选择其中一份作为技术 pivot，但这不表示它更权威。

原文是准入边界：如果某段内容不存在于原文，哪怕某个译本或版本收录了它，也不应进入最终比较。常见例子包括特典、电子书附录、版权页、后记、译注和制作信息。

## 项目模型

一次校对以“校对项目”为边界。校对项目由三份输入文件、输入模式、正文起始设置和内联标记设置共同确定；同名文件如果来自不同路径或使用不同设置，也属于不同项目。

EPUB 输入可以保留注音、加粗和注释标记。启用“保留注释标记”时，程序会原样保留 `epub:type="noteref"` 的完整 `<a ...><sup>…</sup></a>` 片段，包括属性和内部标签，便于后续查找替换；普通超链接仍只保留其可见文本。

每次生成会得到一个“项目快照”。快照包含输入选择、清洗段落、跨语言对齐、当前行表签名、生成时间和最终工作台，并归档到 `out/projects/<projectKey>/`。同一项目重新生成时更新原快照，不同输入或设置会形成不同项目。

控制台由 `npm run setup` 启动，负责选择输入、保存设置、运行生成流程、切换已生成项目和承载 AI 校对 API。切换项目时，控制台会把对应快照恢复为 `out/` 顶层的当前活动项目；生成或切换前会检查 AI 校对状态，避免运行态跨项目。

校对备注属于项目快照，保存在浏览器 `localStorage` 的独立空间中。当前版本不迁移旧备注空间，也不读取其它项目或其它快照的备注。AI 校对结果也必须携带与当前工作台一致的项目身份和行表签名，否则工作台会忽略这些结果。

## 环境要求

- Node.js 18 或更新版本。
- Python 3.12。
- Pandoc，用于读取 EPUB、DOCX、HTML、ODT、Markdown、RTF 等格式。
- 可选：CUDA/ROCm 可用的 PyTorch 环境，用于加速跨语言语义对齐。
- 可选：Ollama、LM Studio、vLLM、llama.cpp server 等本地模型服务，用于 AI 辅助校对。

一键初始化 Node 与 Python 依赖：

```powershell
npm run setup:env
```

这个命令会执行 `npm install`，创建项目内 `.venv`，安装 `requirements.txt` 中的 Python 依赖，并安装/检查 Pandoc。若 Windows 上找不到 Python 3.12 或 Pandoc，脚本会尝试通过 winget 安装 `Python.Python.3.12` 与 `JohnMacFarlane.Pandoc`；如果不希望脚本自动安装 Python，可以运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-env.ps1 -NoInstallPython
```

如果不希望脚本自动安装 Pandoc，可以运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-env.ps1 -NoInstallPandoc
```

如果本机已有其他 Python 版本，仍建议为本项目创建 Python 3.12 的 `.venv`。脚本不会用 3.11/3.13 等版本凑合创建环境，以免后续对齐依赖出现不稳定问题。

如果已经创建过旧版 `.venv`，可以显式重建：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-env.ps1 -RecreateVenv
```

也可以手动安装 Node dependencies：

```powershell
npm install
```

如果没有使用一键初始化，需手动安装 Pandoc。Windows 上可以使用 Scoop：

```powershell
scoop install pandoc
```

也可以使用 Pandoc 官方安装包，或 winget：

```powershell
winget install --source winget --exact --id JohnMacFarlane.Pandoc
```

检查 Pandoc：

```powershell
npm run check:pandoc
```

准备 Python 环境：

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -U pip setuptools wheel
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

`requirements.txt` 会安装 PyPI 默认 PyTorch。若要使用 GPU，请在初始化后运行 `npm run setup:accelerator`，让脚本按本机显卡、驱动和 CUDA/ROCm 支持情况安装匹配的 PyTorch。不要把某一台机器验证过的 GPU wheel 当作通用配置。

当前直接 Python 依赖保持在 `numpy`、`sentence-transformers` 和 `torch`，均支持 Python 3.12。未被现有脚本直接引用的实验性依赖不放入默认安装清单，需要相关功能时再单独引入。

检查加速环境：

```powershell
npm run detect:accelerator
npm run check:accelerator
```

可选安装显卡加速版 PyTorch：

```powershell
npm run setup:accelerator
```

这个命令只在用户主动执行时修改 `.venv` 里的 PyTorch。脚本会自动检测 NVIDIA/AMD 显卡，显示检测结果、选择的后端和将要安装的 wheel，然后询问是否继续安装。

NVIDIA 显卡默认安装 PyTorch 官方 CUDA 12.8 wheel；可通过 PowerShell 直接调用脚本选择其他 CUDA wheel：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-accelerator.ps1 -Backend cuda -CudaWheel cu126
```

AMD 显卡会按脚本内置支持矩阵判断。Windows 上若检测到 Radeon RX 9070 XT、RX 9070、RX 9060 XT、Radeon AI PRO R9700、RX 7900 XTX、PRO W7900 或 RX 7700 等 ROCm 7.2.1 支持型号，会安装 AMD 官方 ROCm 7.2.1 PyTorch wheel。该路径要求 Python 3.12，并建议安装 AMD Software: Adrenalin Edition 26.2.2 或更新驱动。未知或未列入支持矩阵的 AMD 型号不会自动安装 ROCm wheel。

通常不需要手动指定显卡型号。如果系统权限导致脚本无法枚举显卡，但你已确认型号在支持矩阵内，可以作为故障排查手段显式指定：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-accelerator.ps1 -Backend rocm -AmdGpuName "AMD Radeon RX 9070 XT"
```

如果确实想在 CPU 上运行对齐：

```powershell
$env:TRANS_COMPARATOR_ALLOW_CPU = "1"
npm run align:jp
```

## 快速开始

启动本地控制台：

```powershell
npm run setup
```

然后在浏览器打开终端显示的地址，通常是：

```text
http://127.0.0.1:4317/
```

在控制台中直接为每个角色导入文件：可以点击选择，也可以把文件拖到对应卡片。导入完成后再保存选择：

- 双语模式：`A` 为原文，`B` 为唯一译文和 AI 修改列；AI 只参考原文 A 修改 B。
- 三语模式：`A` 为原文，`B`、`C` 为同级译文、校订本或地区版本；AI 可选择修改 B 或 C，并参考原文 A 与另一个非原文版本。

控制台会在本地工作区暂存浏览器导入的文件，并在保存前验证文件类型、角色完整性和模式约束。命令行仍支持下面的目录或显式文件参数用法。

保存选择后，点击页面里的生成按钮。本地服务会依次运行段落导出、跨语言对齐和工作台构建，完成后归档项目并提供工作台入口。之后可以在控制台的“已生成项目”中选择旧项目并切换；切换会恢复当时的输入设置、对齐结果和工作台。

源文本建议放在仓库外部，不要把真实作品文本、个人路径或生成结果提交到公开仓库。

## 命令行用法

仅导出清洗后的段落：

```powershell
npm run export:paragraphs
```

从指定目录选择源文件。程序会按文件名做初步推断，并把当前选择保存到 `out/runtime/input-selection.json`：

```powershell
npm run export:paragraphs -- --input-dir "C:\path\to\texts"
```

显式指定三份文件，适合跳过交互：

```powershell
npm run export:paragraphs -- --jp "C:\path\source.epub" --cn "C:\path\version-a.epub" --tw "C:\path\version-b.epub"
```

运行跨语言对齐。这个命令会先检查加速环境，再重新导出段落：

```powershell
npm run align:jp
```

对齐进度条默认使用 ASCII 样式以兼容 Windows/npm 输出。如果仍不想显示进度条，可以关闭：

```powershell
$env:TRANS_COMPARATOR_PROGRESS = "0"
npm run align:jp
```

构建 HTML、CSV 和 JSON 工作台：

```powershell
npm run build
```

完整流程：

```powershell
npm run align:jp
npm run build
```

如 Pandoc 不在 `PATH` 中，可指定路径：

```powershell
$env:PANDOC_BIN = "C:\path\to\pandoc.exe"
npm run export:paragraphs
```

`setup:env` 会尝试安装 Pandoc，因此正常环境应优先使用 Pandoc。运行时如果 Pandoc 仍不可用，EPUB 输入会自动回退到内置 OPF/nav/spine reader；其他非 TXT 格式仍需要 Pandoc。若需要诊断内置 EPUB reader：

```powershell
$env:TRANSCOMPARATOR_EPUB_CONVERTER = "internal"
npm run export:paragraphs
```

若要强制 EPUB 必须使用 Pandoc，可设置：

```powershell
$env:TRANSCOMPARATOR_EPUB_CONVERTER = "pandoc"
```

## 输出文件

输出目录是 `out/`，默认不会提交到 Git。它按职责分为三个区域：

- `out/runtime/input-selection.json`：控制台和命令行当前使用的输入选择，包含源文件绝对路径。
- `out/runtime/imported-inputs/`：浏览器上传的源文件副本。
- `out/runtime/work/`：命令行生成时的临时工作目录；成功执行 `npm run build` 后会被发布为项目快照。
- `out/.staging/<runId>/`：控制台每次生成使用的隔离暂存目录。失败任务只清理自己的目录，不会覆盖已发布项目。
- `out/projects/<projectKey>/snapshots/<snapshotId>/`：不可变项目快照，包含 `input-selection.json`、`paragraphs.json`、`jp-align.json` 和三种 `translation-compare.*` 输出。
- `out/active-project.json`：当前活动项目与快照的小型指针文件。

切换项目只更新 `active-project.json` 和当前输入选择，不复制 HTML、JSON 或对齐结果。每个项目默认保留最近两个快照；AI 校对按 `projectKey` 与行签名读取对应快照，避免切换项目时串用数据。控制台通过 `/output/<projectKey>/translation-compare.html` 打开工作台；备注保存在浏览器本地，不会写回源文本。

## 预筛选

预筛选是一个独立模块，不依赖 AI 校对。它在不调用任何模型的前提下，对当前工作台的所有行依次执行两层预筛，把结果写入备注并统计：

- 确定性规则预筛会统一繁简、全半角、空白和不可见字符。归一化后完全一致或两列都为空的行直接标记为规则通过；纯数字、序号和短标识符等结构化内容不一致时，标记为规则冲突并保留给人工确认。
- 相似度预筛只处理有足够长度的正文。数字或英文标识符不同、文本过短、存在空列或长度差异明显时不会启用，避免把关键的小范围差异误判为无需校对。

预筛选模块的“相似度预筛”阈值控制相似度预筛的通过线（默认 92%）。预筛结果会实时写入当前项目快照的备注空间，保存在浏览器 `localStorage`；已人工确认的行会被跳过。运行 AI 校对时，AI 会跳过已通过预筛的行，只对剩余行调用模型。

## AI 辅助校对

AI 校对需要通过 `npm run setup` 打开的本地服务访问工作台。直接双击 `translation-compare.html` 只能使用人工备注功能。

工作台顶部的 AI 校对区域支持三类服务：

- `OpenAI-compatible`：适用于 Ollama、LM Studio、vLLM、llama.cpp server 等兼容 Chat Completions 的服务。地址可填写主机、带 `/v1` 的 Base URL，或完整的 `/v1/chat/completions` 地址；程序会识别已有版本段和端点，不会重复拼接。
- `Claude`：适用于 Claude 原生 Messages API。默认地址是 `https://api.anthropic.com`，也可以填写带 `/v1` 的 Base URL 或完整的 `/v1/messages` 地址；程序会识别已有版本段和端点。认证使用 `x-api-key`，并发送 `anthropic-version: 2023-06-01`。
- `本地默认`：预置 Ollama 的 OpenAI-compatible `/v1` 地址与模型，可按本机配置修改。

AI 校对范围与当前项目模式绑定。双语项目固定修改译文 B，并以原文 A 为依据；三语项目可以选择 B 或 C 作为修改列，模型同时参考原文 A 和另一份非原文文本。

系统提示词按项目独立保存在浏览器 `localStorage` 中：在一个项目里修改或恢复提示词，不会影响其它项目。双语项目和三语项目使用不同的内置默认提示词；接口地址、模型、API Key、并发等连接配置仍在工作台之间共用。此规则只写入之后新生成的工作台，不迁移或重建已有项目快照。

“推理强度”会始终显示在 AI 服务设置中。选择 `gpt-*` 系列模型时，可使用模型默认值，或选择 `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，所选值通过 Chat Completions 的 `reasoning_effort` 参数发送；各 GPT 模型支持的档位不同，不支持的值会由接口返回错误。选择非 GPT 模型时，默认使用“模型默认”，请求体不包含 `temperature`；手动选择 `0%` 至 `100%` 后，才会发送对应的 `temperature` 值 `0.0` 至 `1.0`。工作台会分别记住两类模型的选择。

EPUB 注释标记不参与翻译语义判断。无论使用默认还是自定义系统提示词，AI 返回的 `revisedText` 都必须逐字、原位保留目标列中的全部 `noteref` 注释标记，不得修改其属性、内部标签、数量或位置。

本地默认地址是 `http://127.0.0.1:11434/v1`，默认模型名是 `qwen2.5:14b-instruct`，可以在页面中改成你本机实际运行的模型。API Key 对本地服务通常可以留空；Claude 原生接口需要 Claude Console API Key。

启动前选择校对目标列和并发数。调用模型前会依次执行两层预筛（规则预筛与相似度预筛，规则同上节“预筛选”），通过预筛的行不调用模型。

工作台会分别统计规则跳过、结构化冲突、相似度跳过和实际 AI 调用数量。仅凭当前行不足以判断时，模型只需返回 `needsContext=true`；工作台后端会按当前项目快照每轮固定补充当前行前一行和后一行，最多 6 轮、12 行。所有自动结果会实时写入当前项目快照的备注空间，仍保存在当前浏览器 `localStorage`。

AI 判断目标列需要修改时，会按 MQM 风格追加问题严重程度，工作台可将它与“需改 / 不改 / 待判”等条件组合筛选：

- `轻微（minor）`：不改变原意、不影响使用的局部流畅度、语法、标点或文体问题。
- `严重（major）`：影响准确性、完整性或可用性的误译、漏译、增译、关键术语、语气或逻辑关系问题。
- `致命（critical）`：颠倒或严重歪曲核心意义，破坏关键人名、数值、否定或指令，或可能造成安全、法律、声誉等高风险后果。此等级应谨慎使用。

无需修改或仍待人工判断时不显示问题严重程度。模型漏填明确修改项的等级时，系统会按“严重（major）”保守归类，避免该问题从分级筛选中遗漏。

## 开源致谢

TransComparator 的实现参考并借助了多个开源项目和开放生态组件。以下列表来自当前代码、`package.json` 和本地 Python 环境中可以确认的依赖；各项目的版权和许可证以其原项目为准。

- [Pandoc](https://pandoc.org/)：用于把 EPUB、DOCX、HTML、ODT、Markdown、RTF 等格式转换为 plain text。
- [OpenCC.js](https://github.com/nk2028/opencc-js)：用于中文简繁归一化。
- [jsdiff](https://github.com/kpdecker/jsdiff)：用于非原文文本之间的词级差异高亮。
- [JSZip](https://github.com/Stuk/jszip)、[fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) 和 [html-to-text](https://github.com/html-to-text/node-html-to-text)：用于内置 EPUB 诊断/fallback 路径中的 ZIP、OPF/nav/XML 和 HTML 文本提取。
- [Sentence Transformers](https://www.sbert.net/) 与 Hugging Face 上的 `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` 模型：用于跨语言语义向量和原文到非原文文本的段落对齐。
- [PyTorch](https://pytorch.org/) 与 [NumPy](https://numpy.org/)：用于模型推理、向量计算和 CUDA/ROCm/CPU 后端支持。
- [Claude API](https://platform.claude.com/docs/en/api/overview)、[Ollama](https://ollama.com/) 以及 OpenAI-compatible Chat Completions 生态：用于可选的云端、本地或兼容接口 AI 辅助校对。
- [CC Switch](https://github.com/farion1231/cc-switch)：大模型接口、兼容服务配置和本地模型服务接入思路参考了该项目。
- [Transformers.js](https://github.com/xenova/transformers.js)：当前仍列在 Node 依赖中，作为本地文本向量化实验和后续浏览器/Node 推理方向的基础组件。

如果你知道还有其他被参考过的项目、文章、脚本或算法实现，建议补充到本节，尤其是对齐策略、正文过滤规则或界面设计的灵感来源。

## 常用检查

检查段落数量、尾部内容和是否混入非正文块：

```powershell
node -e "const fs=require('fs'); const {getActiveProject,resolveProjectArtifact}=require('./scripts/project-store'); const a=getActiveProject(); if(!a) throw Error('没有活动项目'); const p=JSON.parse(fs.readFileSync(resolveProjectArtifact(a.id,'paragraphs.json',{snapshotId:a.snapshotId}),'utf8')); console.log(JSON.stringify({counts:{jp:p.jp.length,cn:p.cn.length,tw:p.tw.length},last:{jp:p.jp.at(-1)?.text,cn:p.cn.at(-1)?.text,tw:p.tw.at(-1)?.text}},null,2));"
```

检查最终工作台是否出现大量空原文或重复长原文：

```powershell
node -e "const fs=require('fs'); const {getActiveProject,resolveProjectArtifact}=require('./scripts/project-store'); const a=getActiveProject(); if(!a) throw Error('没有活动项目'); const data=JSON.parse(fs.readFileSync(resolveProjectArtifact(a.id,'translation-compare.json',{snapshotId:a.snapshotId}),'utf8')); const map=new Map(); data.rows.forEach((r,i)=>{if([...r.jp].length>=18){if(!map.has(r.jp))map.set(r.jp,[]);map.get(r.jp).push(i+1)}}); const dup=[...map.entries()].filter(([,v])=>v.length>1).slice(0,5).map(([jp,rows])=>({rows,jp:jp.slice(0,80)})); const counts={}; for(const r of data.rows)counts[r.relation]=(counts[r.relation]||0)+1; console.log(JSON.stringify({rows:data.rows.length,emptySource:data.rows.filter(r=>!r.jp).length,duplicateLongParagraphs:dup.length,counts,dup},null,2));"
```

## 公开仓库注意事项

提交到 GitHub 前建议检查：

- `.codegraph/`、`.venv/`、`node_modules/`、`out/` 没有进入暂存区。
- 源文本文件没有进入暂存区，例如 TXT、EPUB、DOCX、PDF、ODT、RTF。
- `out/runtime/input-selection.json` 没有提交，因为它包含本机绝对路径。
- README、脚本和前端页面里没有个人目录、真实作品名、API Key 或模型服务密钥。

可以用下面的命令查看将被 Git 追踪的未忽略文件：

```powershell
git status --short
git ls-files --others --exclude-standard
```

## 常见问题

### Pandoc 未安装

运行：

```powershell
npm run check:pandoc
```

如果提示找不到 Pandoc，请安装 Pandoc，或设置 `PANDOC_BIN` 指向 `pandoc.exe`。

### 输出里出现后记、特典或版权页

通常需要调整 `scripts/text-utils.js` 中的正文结束规则。修改后重新运行：

```powershell
npm run align:jp
npm run build
```

### 章节标题进入正文

通常是 `scripts/text-utils.js` 中的章节/行间标题识别漏掉了某种格式。补充规则后重新生成段落和对齐结果。

### 对齐发生连锁错位

先检查活动项目快照中的 `paragraphs.json` 是否混入图片占位、页码、脚注或元信息。预处理稳定后再重新运行 `npm run align:jp` 和 `npm run build`。
