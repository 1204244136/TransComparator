# AGENTS.md

本文档面向后续参与 TransComparator 的 agent。用户使用说明放在 `README.md`；这里记录实现边界、架构约束和修改后的验证纪律。

## 产品语义

TransComparator 是一个本地、文件型文本对齐与翻译校对工作台。它可以处理最多三份文本：

- 一份原文，通常是源语言文本。
- 一到两份非原文文本，可以是不同译本、校订本或地区版本。

非原文文本在产品语义上是同级材料。可以为了实现选择其中一份作为技术 pivot，但不要在 UI、文档或变量说明中暗示它比另一份更权威。

原文是准入边界：如果某段内容不存在于原文，哪怕某个译本或地区版本收录了它，也不应进入最终比较。典型例子是特典、电子书附录、版权页、后记、译注和制作信息。

## 不变量

- 原文段落不可拆分。原文只能以完整段落为单位参与 `1:1`、`1:2`、`2:1`、`2:2` 或更大合并组。
- 非原文段落可以为对齐、diff 和展示进行拆分或合并。
- 不要重新引入没有 reuse tracking 的 naive paragraph-number fallback。
- 不要让同一个原文长段落被 semantic groups 和 fallback 重复使用。
- 修改 text cleaning、heading detection 或正文过滤后，必须重新生成 `paragraphs.json`、`jp-align.json` 和最终工作台。
- 源文本文件和生成物不应提交到仓库，除非用户明确要求。

## 当前 Pipeline

1. `scripts/text-utils.js`
   - 集中配置输入文件路径和输入模式。
   - TXT 以 UTF-8 直接读取。
   - 非 TXT 优先通过 Pandoc 转成完整 linear plain text。
   - 对 Pandoc 输出执行正文范围过滤、媒体占位过滤和段落切分。
   - 识别章节/行间标题，并将其排除在正文段落之外。
   - 通过 OpenCC 在需要时做中文简繁归一化。

2. `scripts/pandoc-utils.js`
   - 封装 Pandoc 调用。
   - 将 EPUB、DOCX、HTML、ODT、Markdown、RTF 等 Pandoc 支持格式转为 plain text。
   - 只负责格式转换，不负责判断哪些内容应进入比较。

3. `scripts/epub-utils.js`
   - EPUB 默认走 Pandoc。
   - 内置 OPF/nav/spine reader 保留为诊断和 fallback 路径。
   - 不要把 EPUB 专用逻辑扩展成所有格式的主路径。

4. `scripts/export-paragraphs.js`
   - 加载最多三份源文件。
   - 写入 `out/paragraphs.json`。
   - 被 `npm run align:jp` 自动调用。

5. `scripts/align_jp.py`
   - 使用 `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` 做跨语言语义对齐。
   - 当 `torch.cuda.is_available()` 为 true 时使用 CUDA/ROCm 暴露的加速后端，否则使用 CPU，除非 accelerator guard 阻止。
   - 写入 `out/jp-align.json`，其中 `groups` 是主流程使用的数据。

6. `scripts/build-compare.js`
   - 对齐两份非原文文本。
   - 读取跨语言 `groups`。
   - 按技术 pivot interval 合并不同方向的对齐组。
   - 输出 HTML、CSV、JSON。

## 正文过滤原则

Pandoc 会忠实输出完整 linear text；过滤职责属于 TransComparator。

正文过滤应优先使用块级边界，而不是全文关键词扫描。正文中可能自然出现“版权”“特典”“图片”等词，不能因此截断。

常见应过滤内容：

- 后记、あとがき、後記。
- 特典、番外、电子书限定附录。
- 版权页、colophon、copyright、出版/发行信息。
- Pandoc 产生的媒体占位，例如 `[]`、`[图片]`、`[p051]`。
- 目录、封面、制作信息、译注等非正文块。

如果过滤规则不确定，宁可保留内容并让后续原文准入和 alignment 排除，也不要过早删除可能是真正文段的文本。

## 对齐标签

类似 `A-B 1:2 / C-B 2:2` 的标签含义：

- `A-B`：文本 A 到文本 B 的对齐。
- `C-B`：文本 C 到文本 B 的对齐。
- `1:2`：左侧 1 个段落对应右侧 2 个段落。
- `2:3` 等更大组表示相邻冲突被合并为稳定区间。

涉及原文时，任何组合都必须保留完整原文段落。

## 生成文件与重型文件

`.codegraph/` 是 CodeGraph 目录索引插件的本地索引依赖，不属于可清理生成物。不要删除、移动或重建该目录，除非用户明确要求重新生成 CodeGraph 索引。

除非用户明确要求，不要提交或复制：

- `.venv/`
- `node_modules/`
- `out/`
- `*.txt`、`*.epub`、`*.docx` 等源文本文件
- 下载的 model caches
- 本机安装脚本或临时环境文件

源文件路径应集中维护在 `scripts/text-utils.js`。公开发布前不要写入个人目录、真实作品名或其他隐私信息。

## 修改纪律

- 优先使用确定性的本地 scripts，不要手工改 spreadsheet。
- 变更输入格式、正文过滤、heading detection 或段落切分后，必须重新运行导出和对齐。
- 修改 alignment 后，必须验证空原文、重复长原文和行数异常。
- 不要把技术 pivot 描述成主从关系。
- commit 信息应使用中文并遵守 Conventional Commits 风格。
- 不要使用破坏性 git 命令，除非用户明确要求。
- 如果工作树已有用户或其他 agent 的改动，必须保留并与之协作。
- 修改后不要进行浏览器截图验证，因为本地 Playwright 运行时缺少 `playwright-core`。

## 验证清单

基础导出：

```powershell
npm run check:pandoc
npm run export:paragraphs
```

完整生成：

```powershell
npm run align:jp
npm run build
```

检查段落数量和末尾内容：

```powershell
node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('./out/paragraphs.json','utf8')); console.log(JSON.stringify({counts:{jp:p.jp.length,cn:p.cn.length,tw:p.tw.length}, last:{jp:p.jp.at(-1)?.text, cn:p.cn.at(-1)?.text, tw:p.tw.at(-1)?.text}}, null, 2));"
```

检查最终行：

```powershell
node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync('./out/translation-compare.json','utf8')); const map=new Map(); data.rows.forEach((r,i)=>{ if([...r.jp].length>=18){ if(!map.has(r.jp)) map.set(r.jp,[]); map.get(r.jp).push(i+1); }}); const dup=[...map.entries()].filter(([,v])=>v.length>1).slice(0,5).map(([jp,rows])=>({rows,jp:jp.slice(0,80)})); const counts={}; for(const r of data.rows){counts[r.relation]=(counts[r.relation]||0)+1} console.log(JSON.stringify({rows:data.rows.length, emptySource:data.rows.filter(r=>!r.jp).length, duplicateLongParagraphs:dup.length, counts, dup},null,2));"
```

一般期望：

- 原文列不应大量为空。
- 同一长原文段落不应意外重复。
- Pandoc 媒体占位不应成为正文段落。
- 特典、后记、版权页不应进入最终比较。

## 常见故障定位

原文重复：检查是否重新引入了无 reuse tracking 的 fallback，或技术 pivot interval 合并是否漏掉重叠组。

原文为空：检查 `out/jp-align.json` 是否过期，或正文过滤是否改变了段落索引。

章节标题污染正文：补充 `chapterPatterns`，然后重新生成全部输出。

插图附近错位：先确认 `splitParagraphs` 是否过滤了 media-only blocks，再看 grouped moves 是否需要扩大或加局部重对齐。

Pandoc 输出混入非正文：优先调整转换后的块级正文边界规则，不要回退到按整篇文本关键词扫描。

## 当前限制

- UI 是静态 HTML table，尚未针对超大型文本做虚拟滚动或分页。
- 备注按 row index 存储，大幅 alignment 改动可能让旧备注失去对应关系。
- 跨语言 embeddings 只是校对辅助，不是最终权威 alignment。
- OpenCC 有助于比较中文变体，但无法归一化翻译风格差异。
