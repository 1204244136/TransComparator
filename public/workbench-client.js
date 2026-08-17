    const pageLabels = pageMeta.pageLabels;
    const bilingualMode = pageMeta.comparisonMode === "bilingual";
    const aiConfigStorageKey = "translation-compare-ai-config-v1";
    const aiPromptStorageKey = "translation-compare-ai-prompt-v1:" + (pageMeta.projectKey || "unscoped");
    const gptReasoningOptions = [
      ["", "模型默认"],
      ["none", "无 (none)"],
      ["minimal", "最小 (minimal)"],
      ["low", "低 (low)"],
      ["medium", "中 (medium)"],
      ["high", "高 (high)"],
      ["xhigh", "极高 (xhigh)"],
      ["max", "最大 (max)"],
    ];
    const nonGptTemperatureOptions = [["", "模型默认"], ...Array.from({ length: 11 }, (_, index) => {
      const value = (index / 10).toFixed(1);
      const percent = index * 10 + "%";
      return [value, percent + "（" + value + "）"];
    })];
    let savedGptReasoningEffort = "";
    let savedNonGptTemperature = "";
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
    const keyboardScrollSpacer = document.getElementById("keyboardScrollSpacer");
    const query = document.getElementById("query");
    const severityButtons = Array.from(document.querySelectorAll("[data-severity]"));
    const aiResultButtons = Array.from(document.querySelectorAll("[data-ai-result]"));
    const issueSeverityButtons = Array.from(document.querySelectorAll("[data-issue-severity]"));
    const noteFilter = document.getElementById("noteFilter");
    const doneFilter = document.getElementById("doneFilter");
    const prefilterResultFilter = document.getElementById("prefilterResultFilter");
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
      monitorSection: document.getElementById("aiMonitorSection"),
      promptSection: document.getElementById("aiPromptSection"),
      serviceFields: document.getElementById("aiServiceFields"),
      baseUrl: document.getElementById("aiBaseUrl"),
      model: document.getElementById("aiModel"),
      reasoningField: document.getElementById("aiReasoningField"),
      reasoningEffort: document.getElementById("aiReasoningEffort"),
      refreshModels: document.getElementById("aiRefreshModels"),
      apiKey: document.getElementById("aiApiKey"),
      proofreadMode: document.getElementById("aiProofreadMode"),
      target: document.getElementById("aiTarget"),
      concurrency: document.getElementById("aiConcurrency"),
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
    const prefilterIds = {
      panel: document.getElementById("prefilterPanel"),
      similarity: document.getElementById("prefilterSimilarity"),
      stats: document.getElementById("prefilterStats"),
      start: document.getElementById("prefilterStart"),
      confirm: document.getElementById("prefilterConfirm"),
      stop: document.getElementById("prefilterStop"),
    };
    const appliedAiResults = new Set();
    const aiActiveIds = new Set();
    const aiRequestCache = new Map();
    const clearedAiRunIds = new Set();
    const manualNoteOpenIds = new Set();
    const selectedRevisionIds = new Set();
    const prefilterResultIds = new Set();
    const diffHtmlCache = new Map();
    let filteredRows = allRows;
    let currentPage = 1;
    let activeRowId = "";
    let lastAiRunId = "";
    let latestPrefilterRunId = "";
    let prefilterResultFilterActive = false;
    let prefilterResultsCatchingUp = false;
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
      const text = Number.isInteger(percent) ? String(percent) : percent.toFixed(1).replace(/\.0$/, "");
      return text + "%";
    }

    function normalizeSimilarityInput() {
      prefilterIds.similarity.value = formatPercentRatio(prefilterIds.similarity.value);
    }

    function updateProofreadModeHint() {
      aiIds.proofreadMode.value = bilingualMode ? "bilingual" : "trilingual";
      const hint = bilingualMode
        ? "目标固定为译文 B，参考原文 A；原文只作语义边界和上下文。"
        : "目标可选非原文 B 或 C，同时参考原文 A 和另一版本。";
      aiIds.proofreadMode.title = hint;
      aiIds.target.title = hint;
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
      const lines = String(note || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
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
      const parsedRevision = parseAutomatedNote(item.note)?.revision || "";
      item.revisionText = Object.prototype.hasOwnProperty.call(value || {}, "revisionText")
        ? String(value.revisionText || "")
        : parsedRevision;
      item.revisionTarget = normalizeRevisionTarget(value?.revisionTarget);
      cleanAiFailureState(item);
      return item;
    }

    function normalizeRevisionTarget(value) {
      return value === "tw" || value === "cn" ? value : "";
    }

    function revisionTextFor(item) {
      if (!item) return "";
      if (Object.prototype.hasOwnProperty.call(item, "revisionText")) return String(item.revisionText || "");
      return parseAutomatedNote(item.note || "")?.revision || "";
    }

    function revisionTargetFor(item) {
      return normalizeRevisionTarget(item?.revisionTarget) || "cn";
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
        manualNote: [manual, text.slice(0, markerIndex).trim()].filter(Boolean).join("\n\n"),
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
      return [item.note, item.manualNote].filter(Boolean).join("\n\n");
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

    function isGptModelName(model) {
      return /(?:^|\/)gpt(?:-|$)/i.test(String(model || "").trim());
    }

    function rememberInferenceSetting() {
      const value = aiIds.reasoningEffort.value;
      if (aiIds.reasoningEffort.dataset.mode === "gpt") {
        if (gptReasoningOptions.some(([optionValue]) => optionValue === value)) savedGptReasoningEffort = value;
      } else if (aiIds.reasoningEffort.dataset.mode === "temperature") {
        if (nonGptTemperatureOptions.some(([optionValue]) => optionValue === value)) savedNonGptTemperature = value;
      }
    }

    function updateInferenceSettingOptions() {
      const mode = isGptModelName(aiIds.model.value) ? "gpt" : "temperature";
      if (aiIds.reasoningEffort.dataset.mode !== mode) {
        rememberInferenceSetting();
        const options = mode === "gpt" ? gptReasoningOptions : nonGptTemperatureOptions;
        aiIds.reasoningEffort.replaceChildren(...options.map(([value, label]) => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = label;
          return option;
        }));
        aiIds.reasoningEffort.dataset.mode = mode;
      }
      aiIds.reasoningEffort.value = mode === "gpt" ? savedGptReasoningEffort : savedNonGptTemperature;
      aiIds.reasoningEffort.title = mode === "gpt"
        ? "GPT 模型通过 reasoning_effort 调整；不同模型支持的档位可能不同"
        : "非 GPT 模型通过 temperature 调整；选择模型默认时不发送该参数";
      aiIds.reasoningField.hidden = false;
      aiIds.reasoningEffort.disabled = false;
      aiIds.serviceFields.classList.add("has-reasoning");
      syncEnhancedSelect(aiIds.reasoningEffort);
    }

    function loadSavedAiPrompt() {
      try {
        return JSON.parse(localStorage.getItem(aiPromptStorageKey) || "{}");
      } catch {
        return {};
      }
    }

    function saveAiConfig() {
      rememberInferenceSetting();
      const config = {
        provider: aiIds.provider.value,
        baseUrl: aiIds.baseUrl.value,
        model: aiIds.model.value,
        reasoningEffort: aiIds.reasoningEffort.value,
        inferenceSettingVersion: 2,
        gptReasoningEffort: savedGptReasoningEffort,
        nonGptTemperature: savedNonGptTemperature,
        modelOptions: aiModelOptions,
        modelOptionsBaseUrl: aiModelOptions.length ? normalizeApiBaseUrl(aiIds.baseUrl.value) : "",
        apiKey: aiIds.apiKey.value,
        proofreadMode: aiIds.proofreadMode.value,
        target: aiIds.target.value,
        concurrency: aiIds.concurrency.value,
        similarity: formatPercentRatio(prefilterIds.similarity.value),
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
      const validGptValues = gptReasoningOptions.map(([value]) => value);
      const validTemperatureValues = nonGptTemperatureOptions.map(([value]) => value);
      if (validGptValues.includes(saved.gptReasoningEffort)) savedGptReasoningEffort = saved.gptReasoningEffort;
      if (saved.inferenceSettingVersion === 2 && validTemperatureValues.includes(String(saved.nonGptTemperature))) {
        savedNonGptTemperature = String(saved.nonGptTemperature);
      }
      if (isGptModelName(aiIds.model.value) && validGptValues.includes(saved.reasoningEffort)) {
        savedGptReasoningEffort = saved.reasoningEffort;
      }
      if (saved.target === "cn" || saved.target === "tw") aiIds.target.value = saved.target;
      if (bilingualMode) aiIds.target.value = "cn";
      if (saved.concurrency != null) aiIds.concurrency.value = saved.concurrency;
      if (saved.similarity != null) prefilterIds.similarity.value = formatPercentRatio(saved.similarity);
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
      updateInferenceSettingOptions();
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
      aiIds.status.title = message;
    }

    function setTemporaryStatus(message, durationMs = 8000) {
      statusMessageLockedUntil = Date.now() + durationMs;
      aiIds.status.dataset.runtimeMessage = "1";
      aiIds.status.textContent = message;
      aiIds.status.title = message;
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
      prefilterIds.start.disabled = false;
      prefilterIds.confirm.disabled = true;
      prefilterIds.stop.disabled = true;
      prefilterIds.stats.textContent = "尚未运行预筛选。";
      aiIds.status.dataset.cacheCleared = "1";
      setRuntimeStatus(message);
      aiIds.progress.style.width = "0%";
      aiIds.progressWrap.hidden = true;
      aiIds.monitorState.textContent = "尚未启动";
      aiIds.requestList.innerHTML = '<div class="ai-request-empty">启动 AI 校对后，这里会显示程序发给模型的问题和接口等待状态。</div>';
      aiMonitorRenderKey = "";
      aiActiveIds.clear();
      prefilterResultIds.clear();
      latestPrefilterRunId = "";
      prefilterResultFilterActive = false;
      prefilterResultsCatchingUp = false;
      prefilterResultFilter.disabled = true;
      prefilterResultFilter.classList.remove("is-active");
      prefilterResultFilter.setAttribute("aria-pressed", "false");
      updateRenderedAiActive();
      applyFilters({ reset: false });
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

    function renderDiffBlock(row, item) {
      const twDiffHtml = renderRowDiffHtml(row);
      const revision = revisionTextFor(item);
      const targetKey = revisionTargetFor(item);
      const targetText = targetKey === "tw" ? row.tw : row.cn;
      const revisionDiffHtml = targetText && revision ? inlineDiffHtml(targetText, revision) : "";
      const revisionMatchesTw = targetKey === "cn" && Boolean(twDiffHtml && revisionDiffHtml && twDiffHtml === revisionDiffHtml);
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
        const matchBadge = revisionMatchesTw
          ? '<span class="diff-match-badge" title="与' + escapeHtml(pageLabels.tw) + '简体化的差异完全相同">同' + escapeHtml(pageLabels.tw) + '简体化</span>'
          : "";
        comparisons.push({
          kind: "revision",
          html: '<div class="diff-comparison" data-diff-kind="revision">' +
          '<div class="version-label"><span>' + escapeHtml(pageLabels[targetKey] || targetKey) + ' -> 修改结果</span>' + matchBadge + '</div>' +
          '<div lang="' + (targetKey === "tw" ? "zh-Hant" : "zh-Hans") + '">' + revisionDiffHtml + '</div>' +
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
      const lines = String(note || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
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
          data.analysis = [data.analysis, "建议改法：" + line.slice("建议改法：".length).trim()].filter(Boolean).join("\n");
          currentField = "analysis";
        } else if (line.startsWith("分析：") || line.startsWith("原因：") || line.startsWith("问题：")) {
          data.analysis = line.replace(/^(分析|原因|问题)：/, "").trim();
          currentField = "analysis";
        } else if (line.startsWith("分析过程：")) {
          data.analysis = line.slice("分析过程：".length).trim();
          currentField = "analysis";
        } else if (currentField === "revision") {
          data.revision = [data.revision, line].filter(Boolean).join("\n");
        } else {
          data.analysis = [data.analysis, line].filter(Boolean).join("\n");
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

    function renderNoteSummary(item, id) {
      const noteText = item?.note || "";
      const note = parseAutomatedNote(noteText);
      if (!note) return '<div class="note-summary" hidden></div>';
      const analysis = note.analysis
        ? '<div class="note-detail note-reason"><div class="note-detail-head"><span class="note-summary-key">分析</span></div><div class="note-summary-value">' + escapeHtml(note.analysis) + '</div></div>'
        : "";
      const revisionText = revisionTextFor(item);
      const revisionTarget = revisionTargetFor(item);
      const revisionLabel = pageLabels[revisionTarget] || (revisionTarget === "tw" ? "非原文 C" : "非原文 B");
      const revision = revisionText
        ? '<div class="note-detail note-revision"><div class="note-detail-head"><label class="revision-select"><input type="checkbox" data-export-revision="' + escapeHtml(id || "") + '" aria-label="选择第 ' + escapeHtml(id || "") + ' 行修改结果"' + (selectedRevisionIds.has(String(id)) ? " checked" : "") + '><span class="note-summary-key">' + escapeHtml(revisionLabel) + '修改结果</span></label><button type="button" class="copy-revision" data-copy-text="' + escapeHtml(revisionText) + '" title="复制修改结果">复制</button></div><textarea class="revision-editor" data-revision="' + escapeHtml(id || "") + '" aria-label="第 ' + escapeHtml(id || "") + ' 行 AI 修改结果">' + escapeHtml(revisionText) + '</textarea></div>'
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
        revisionTextFor(notes[row.index]),
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
      const diffBlock = renderDiffBlock(row, note);
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
        renderNoteSummary(note, id),
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

    function syncRevisionEditorHeight(editor) {
      if (!editor) return;
      editor.classList.remove("is-overflowing");
      editor.style.height = "auto";
      const maxHeight = Math.max(120, Math.round(window.innerHeight * 0.4));
      const nextHeight = Math.min(editor.scrollHeight + 2, maxHeight);
      editor.style.height = nextHeight + "px";
      editor.classList.toggle("is-overflowing", editor.scrollHeight > maxHeight);
    }

    function syncVisibleRowLayout() {
      for (const editor of tbody.querySelectorAll(".note-editor")) syncNoteEditorHeight(editor);
      for (const editor of tbody.querySelectorAll(".revision-editor")) syncRevisionEditorHeight(editor);

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
      keyboardScrollSpacer.style.height = "0px";
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

    function writeNote(id, note, aiDone, { deferCommit = false } = {}, revisionTarget = "") {
      const current = notes[id] || { note: "", done: false };
      const previousNote = current.note || "";
      current.aiDone = Boolean(aiDone || current.aiDone || hasAutomatedDecisionNote(note));
      current.done = Boolean(current.manualDone);
      if (!current.note || isAutomatedNoteText(current.note)) {
        current.note = note || current.note;
      } else if (isAutomatedNoteText(note)) {
        current.manualNote = [current.manualNote, current.note].filter(Boolean).join("\n\n");
        current.note = note;
      } else if (note && !current.note.includes(note)) {
        current.note = current.note + "\n\n" + note;
      }
      const parsedRevision = parseAutomatedNote(current.note)?.revision || "";
      if (parsedRevision) {
        const sameAutomatedNote = isAutomatedNoteText(note) && note === previousNote;
        if (!sameAutomatedNote || !Object.prototype.hasOwnProperty.call(current, "revisionText")) {
          current.revisionText = parsedRevision;
        }
        current.revisionTarget = normalizeRevisionTarget(revisionTarget) || current.revisionTarget || "cn";
      } else if (isAutomatedNoteText(note)) {
        current.revisionText = "";
        current.revisionTarget = "";
        selectedRevisionIds.delete(String(id));
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
          wrapper.innerHTML = renderNoteSummary(notes[id], id);
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
      if (diffSlot && row) diffSlot.innerHTML = renderDiffBlock(row, notes[id]);
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

    function prefilterResultKind(row) {
      const marker = automatedNoteMarker(notes[String(row.index)]?.note || "");
      if (marker === "[规则预筛]") return "rule";
      if (marker === "[相似度预筛]") return "similarity";
      return "";
    }

    function currentPrefilterRows() {
      if (!prefilterResultFilterActive) return [];
      return filteredRows.filter((row) => {
        const id = String(row.index);
        return prefilterResultIds.has(id) && prefilterResultKind(row) && !notes[id]?.manualDone;
      });
    }

    function updatePrefilterConfirmButton(ai = null) {
      if (
        ai &&
        ai.kind === "prefilter" &&
        ai.runId === latestPrefilterRunId
      ) {
        prefilterResultsCatchingUp = Boolean(ai.running || ai.hasMoreResults);
      }
      prefilterIds.confirm.disabled = !prefilterResultFilterActive || prefilterResultsCatchingUp || currentPrefilterRows().length === 0;
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
      const matchesPrefilterResult = !prefilterResultFilterActive || prefilterResultIds.has(id);
      return matchesQuery && matchesSeverity && matchesAiResult && matchesIssueSeverity && matchesNotes && matchesDone && matchesPrefilterResult;
    }

    function applyFilters({ reset = true } = {}) {
      const q = query.value.trim().toLowerCase();
      filteredRows = allRows.filter((row) => matchesFilter(row, q));
      renderVisibleRows({ reset });
      updatePrefilterConfirmButton();
    }

    function scheduleFilter() {
      window.clearTimeout(filterTimer);
      filterTimer = window.setTimeout(() => applyFilters(), 120);
    }

    tbody.addEventListener("input", (event) => {
      const revisionEditor = event.target.closest("[data-revision]");
      if (revisionEditor) {
        syncRevisionEditorHeight(revisionEditor);
        const id = revisionEditor.dataset.revision;
        const current = notes[id] || { note: "", done: false, manualDone: false, aiDone: false };
        current.revisionText = revisionEditor.value;
        current.revisionTarget = revisionTargetFor(current);
        notes[id] = current;
        if (!revisionEditor.value.trim()) selectedRevisionIds.delete(id);
        const copyButton = revisionEditor.closest(".note-revision")?.querySelector(".copy-revision");
        if (copyButton) copyButton.dataset.copyText = revisionEditor.value;
        const row = rowsById.get(id);
        const diffSlot = renderedRow(id)?.querySelector('[data-diff-slot]');
        if (diffSlot && row) diffSlot.innerHTML = renderDiffBlock(row, current);
        saveNotes();
        updateDoneCount();
        return;
      }
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
          wrapper.innerHTML = renderNoteSummary(current, id);
          summary.replaceWith(wrapper.firstElementChild);
        }
        saveNotes();
        updateDoneCount();
      }
    });

    tbody.addEventListener("blur", (event) => {
      if (event.target.closest("[data-note], [data-revision]")) scheduleFilter();
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
    prefilterResultFilter.addEventListener("click", () => {
      prefilterResultFilterActive = !prefilterResultFilterActive;
      prefilterResultFilter.classList.toggle("is-active", prefilterResultFilterActive);
      prefilterResultFilter.setAttribute("aria-pressed", String(prefilterResultFilterActive));
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

    function visibleRevisionCheckboxes() {
      return Array.from(tbody.querySelectorAll("[data-export-revision]"))
        .filter((checkbox) => !checkbox.disabled && checkbox.getClientRects().length > 0);
    }

    function focusRevisionCheckbox(checkbox) {
      if (!checkbox) return false;
      const row = checkbox.closest("tr[data-index]");
      const previous = activeRowId ? renderedRow(activeRowId) : null;
      if (previous && previous !== row) previous.classList.remove("active-row");
      activeRowId = row?.dataset.index || "";
      if (row) row.classList.add("active-row");
      checkbox.focus({ preventScroll: true });
      if (row && !tableFrame.classList.contains("is-fit-content")) {
        const frameRect = tableFrame.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        const headerHeight = tableFrame.querySelector("thead")?.getBoundingClientRect().height || 0;
        const preferredTop = Math.max(headerHeight + 16, Math.round(tableFrame.clientHeight * 0.18));
        keyboardScrollSpacer.style.height = Math.max(0, tableFrame.clientHeight - preferredTop) + "px";
        const rowTop = tableFrame.scrollTop + rowRect.top - frameRect.top;
        const maxScrollTop = Math.max(0, tableFrame.scrollHeight - tableFrame.clientHeight);
        tableFrame.scrollTop = Math.max(0, Math.min(rowTop - preferredTop, maxScrollTop));
      }
      return true;
    }

    function revisionNavigationTargets() {
      const targets = [];
      filteredRows.forEach((row, filteredIndex) => {
        const id = String(row.index);
        const item = notes[id];
        const targetKey = revisionTargetFor(item);
        const revision = revisionTextFor(item);
        if (row[targetKey] && revision) targets.push({ id, filteredIndex });
      });
      return targets;
    }

    function focusRevisionTarget(target) {
      if (!target) return false;
      const size = Number(pageSize.value || 100);
      const targetPage = Math.floor(target.filteredIndex / size) + 1;
      if (targetPage !== currentPage) {
        currentPage = targetPage;
        renderVisibleRows();
      }
      const checkbox = tbody.querySelector('[data-export-revision="' + CSS.escape(target.id) + '"]');
      return visibleRevisionCheckboxes().includes(checkbox) && focusRevisionCheckbox(checkbox);
    }

    function focusAdjacentRevision(direction, currentCheckbox = null) {
      const checkboxes = visibleRevisionCheckboxes();
      const currentIndex = currentCheckbox ? checkboxes.indexOf(currentCheckbox) : -1;
      if (currentIndex >= 0) {
        const adjacent = checkboxes[currentIndex + direction];
        if (adjacent) return focusRevisionCheckbox(adjacent);
        const targets = revisionNavigationTargets();
        const targetIndex = targets.findIndex((target) => target.id === currentCheckbox.dataset.exportRevision);
        const target = targets[targetIndex + direction];
        return target ? focusRevisionTarget(target) : true;
      }

      const targets = revisionNavigationTargets();
      if (activeRowId) {
        const activeCheckbox = activeRowId
          ? checkboxes.find((checkbox) => checkbox.dataset.exportRevision === activeRowId)
          : null;
        if (activeCheckbox) return focusRevisionCheckbox(activeCheckbox);
        const activeIndex = filteredRows.findIndex((row) => String(row.index) === activeRowId);
        const target = direction > 0
          ? targets.find((item) => item.filteredIndex > activeIndex)
          : targets.filter((item) => item.filteredIndex < activeIndex).at(-1);
        if (target) return focusRevisionTarget(target);
      }

      const edge = direction > 0 ? checkboxes[0] : checkboxes.at(-1);
      if (edge) return focusRevisionCheckbox(edge);
      const size = Number(pageSize.value || 100);
      const pageStart = (currentPage - 1) * size;
      const pageEnd = currentPage * size;
      const target = direction > 0
        ? targets.find((item) => item.filteredIndex >= pageEnd)
        : targets.filter((item) => item.filteredIndex < pageStart).at(-1);
      return focusRevisionTarget(target);
    }

    function isKeyboardEditingTarget(target) {
      return Boolean(target.closest('input:not([type="checkbox"]), textarea, select, [contenteditable]:not([contenteditable="false"]), [role="combobox"]'));
    }

    document.addEventListener("keydown", (event) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      if (isKeyboardEditingTarget(event.target)) return;
      const currentCheckbox = event.target.closest("[data-export-revision]");
      const direction = event.key === "ArrowDown" ? 1 : -1;
      if (!focusAdjacentRevision(direction, currentCheckbox)) return;
      event.preventDefault();
    });

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
      prefilterResultFilterActive = false;
      for (const button of severityButtons) button.classList.toggle("is-active", button.dataset.severity === "all");
      for (const button of aiResultButtons) button.classList.toggle("is-active", button.dataset.aiResult === "all");
      for (const button of issueSeverityButtons) button.classList.toggle("is-active", button.dataset.issueSeverity === "all");
      noteFilter.classList.remove("is-active");
      noteFilter.setAttribute("aria-pressed", "false");
      prefilterResultFilter.classList.remove("is-active");
      prefilterResultFilter.setAttribute("aria-pressed", "false");
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
        const item = notes[id];
        const revision = revisionTextFor(item).trim();
        const targetKey = revisionTargetFor(item);
        const searchText = String(row[targetKey] || "");
        if (!searchText || !revision) continue;
        entries.push({ id, targetKey, searchText, replaceText: revision });
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
      const pairPattern = /(^[ \t]*)<searchtext>[\s\S]*?<\/searchtext>(\r?\n)\1<replacetext>[\s\S]*?<\/replacetext>/m;
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

    prefilterIds.confirm.addEventListener("click", () => {
      const rows = currentPrefilterRows();
      if (!rows.length) {
        setTemporaryStatus("当前筛选结果中没有待确认的预筛通过行。", 5000);
        updatePrefilterConfirmButton();
        return;
      }
      const counts = rows.reduce((result, row) => {
        const kind = prefilterResultKind(row);
        if (kind) result[kind] += 1;
        return result;
      }, { rule: 0, similarity: 0 });
      const message = "当前预筛结果共 " + rows.length + " 条：规则通过 " + counts.rule + " 条，相似度通过 " + counts.similarity + " 条。\n\n确认后将为这些行勾选“人工确认”。是否继续？";
      if (!confirm(message)) return;
      for (const row of rows) {
        const id = String(row.index);
        const current = notes[id] || { note: "", manualNote: "", done: false, manualDone: false, aiDone: false };
        current.manualDone = true;
        current.done = true;
        notes[id] = current;
      }
      saveNotes();
      updateDoneCount();
      applyFilters({ reset: false });
      setTemporaryStatus("已将 " + rows.length + " 条预筛结果标记为人工确认。", 7000);
      tableFrame.scrollTop = 0;
    });

    function aiConfig() {
      return {
        provider: aiIds.provider.value,
        baseUrl: aiIds.baseUrl.value,
        model: aiIds.model.value,
        reasoningEffort: aiIds.reasoningEffort.value,
        apiKey: aiIds.apiKey.value,
        proofreadMode: aiIds.proofreadMode.value,
        target: aiIds.target.value,
        concurrency: Number(aiIds.concurrency.value),
        similarityThreshold: parsePercentRatio(prefilterIds.similarity.value),
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
      aiIds.provider.title = defaults.note || "";
      if (!aiIds.status.dataset.runtimeMessage) {
        aiIds.status.textContent = "就绪";
        aiIds.status.title = defaults.note || "就绪";
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
            (request.reasoningEffort !== "" && request.reasoningEffort != null
              ? '<span>' + (isGptModelName(request.model) ? '推理 ' : '温度 ') + escapeHtml(request.reasoningEffort) + '</span>'
              : '') +
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
      prefilterIds.start.disabled = Boolean(ai.running);
      prefilterIds.stop.disabled = !ai.running;
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
      const isPrefilter = ai.kind === "prefilter";
      const queueText = done + "/" + aiTotal;
      const skipText = "人工确认跳过 " + skippedDone;
      const prefilterText = "规则跳过 " + rulePrefiltered + "，结构化冲突 " + structuredConflicts + "，相似度跳过 " + similarityPrefiltered;
      const pendingText = "待 AI 校对 " + aiTotal;
      prefilterIds.stats.textContent = aiRunId
        ? (ai.running ? "预筛选中：" : (ai.stopRequested ? "预筛选已终止：" : "预筛选完成：")) + prefilterText + "，" + skipText + "，" + pendingText
        : "尚未运行预筛选。";
      if (!isStatusMessageLocked()) {
        if (ai.running) {
          setRuntimeStatus((isPrefilter ? "预筛选中：" : "AI 校对中：实际调用 " + queueText + "，") + (isPrefilter ? "" : skipText + "，") + prefilterText + (isPrefilter ? "，" + pendingText : "，建议 " + (ai.suggested || 0) + "，错误 " + (ai.errors || 0)));
        } else if (ai.finishedAt) {
          setRuntimeStatus((isPrefilter ? (ai.stopRequested ? "预筛选已终止：" : "预筛选完成：") : (ai.stopRequested ? "AI 校对已终止：" : "AI 校对完成：") + "实际调用 " + queueText + "，") + (isPrefilter ? "" : skipText + "，") + prefilterText + (isPrefilter ? "，" + pendingText : "，建议 " + (ai.suggested || 0) + "，错误 " + (ai.errors || 0)));
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
          if (
            isPrefilter &&
            aiRunId === latestPrefilterRunId &&
            (result.status === "rule-prefilter" || result.status === "similarity-prefilter")
          ) {
            prefilterResultIds.add(String(result.index));
          }
        }
        for (const result of pendingResults) {
          writeNote(String(result.index), result.note || "", Boolean(result.done), { deferCommit: true }, result.targetKey || "");
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
      if (appliedResult && (prefilterResultFilterActive || query.value.trim() || notesOnly || doneMode !== "all" || aiResultFilter !== "all" || issueSeverityFilter !== "all")) {
        applyFilters({ reset: false });
      }
      updatePrefilterConfirmButton(ai);
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
      updateInferenceSettingOptions();
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
      updateInferenceSettingOptions();
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
      updateInferenceSettingOptions();
      saveAiConfig();
    });
    [aiIds.apiKey, aiIds.target, aiIds.concurrency, aiIds.proofreadMode, aiIds.reasoningEffort].forEach((input) => {
      input.addEventListener("input", saveAiConfig);
      input.addEventListener("change", saveAiConfig);
    });
    aiIds.proofreadMode.addEventListener("change", updateProofreadModeHint);
    prefilterIds.similarity.addEventListener("input", saveAiConfig);
    prefilterIds.similarity.addEventListener("change", () => {
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
    prefilterIds.start.addEventListener("click", async () => {
      statusMessageLockedUntil = 0;
      prefilterIds.start.disabled = true;
      prefilterIds.confirm.disabled = true;
      prefilterIds.panel.open = true;
      setRuntimeStatus("正在运行预筛选...");
      try {
        const response = await fetch("/api/prefilter/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            similarityThreshold: parsePercentRatio(prefilterIds.similarity.value),
            projectKey: pageMeta.projectKey || "",
            rowsSignature: pageMeta.rowsSignature || "",
            completedIndexes: [...new Set(Object.entries(notes)
              .filter(([, item]) => item?.manualDone)
              .map(([id]) => Number(id))
              .filter((id) => Number.isInteger(id) && id > 0))],
            labels: pageLabels,
          }),
        });
        const data = await response.json();
        if (!data.ok) throw new Error(data.error);
        latestPrefilterRunId = data.ai?.runId || "";
        prefilterResultIds.clear();
        prefilterResultFilterActive = true;
        prefilterResultsCatchingUp = true;
        prefilterResultFilter.disabled = false;
        prefilterResultFilter.classList.add("is-active");
        prefilterResultFilter.setAttribute("aria-pressed", "true");
        renderAiStatus(data.ai);
        applyFilters();
        refreshAiStatus();
      } catch (error) {
        setRuntimeStatus(error.message);
        prefilterIds.start.disabled = false;
        updatePrefilterConfirmButton();
      }
    });
    prefilterIds.stop.addEventListener("click", async () => {
      statusMessageLockedUntil = 0;
      prefilterIds.stop.disabled = true;
      setRuntimeStatus("正在终止预筛选...");
      try {
        const response = await fetch("/api/prefilter/stop", { method: "POST" });
        const data = await response.json();
        if (data.ok) {
          renderAiStatus(data.ai);
          refreshAiStatus();
        }
      } catch (error) {
        setRuntimeStatus(error.message);
      }
    });
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
  