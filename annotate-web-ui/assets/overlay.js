(() => {
  "use strict";

  if (window.__SYMBUI_ACTIVE__) return;
  window.__SYMBUI_ACTIVE__ = true;

  const config = window.__SYMBUI_CONFIG__ || {};
  const nativeSend = window.__symbuiNative;
  if (typeof nativeSend !== "function") {
    console.error("SymbUI: native browser binding is unavailable.");
    return;
  }

  const COLORS = {
    element: "#38bdf8",
    box: "#fbbf24",
    point: "#fb7185",
    arrow: "#a78bfa",
    redact: "#050505",
  };

  const CHANGE_OPERATIONS = [
    {
      value: "layout",
      label: "布局",
      help: "调整位置、间距、尺寸、对齐或层级，不改变现有内容和业务规则。",
      example: "例如：将按钮与输入框间距改为 12px，并保持按钮右对齐。",
    },
    {
      value: "style",
      label: "样式",
      help: "调整颜色、字体、边框、圆角、阴影和视觉状态。",
      example: "例如：将主按钮改为蓝绿色实心，悬停时颜色略加深。",
    },
    {
      value: "content",
      label: "内容",
      help: "调整文案、数字、图标、字段或占位提示，不改变未说明的业务逻辑。",
      example: "例如：将标题改为“薄膜反射率”，并保留现有计算逻辑。",
    },
    {
      value: "interaction",
      label: "交互",
      help: "调整点击、悬停、输入、显示隐藏、加载反馈或跳转行为。",
      example: "例如：点击“开始计算”后显示加载状态，完成后滚动至结果。",
    },
    {
      value: "add",
      label: "新增",
      help: "添加控件、区域、操作入口或补充信息。",
      example: "例如：在图表右上角新增“导出 CSV”按钮，点击下载当前数据。",
    },
    {
      value: "remove",
      label: "删除",
      help: "移除或隐藏控件、内容或入口；请说明需要保留的功能。",
      example: "例如：移除不常用的高级选项入口，但保留现有计算功能。",
    },
    {
      value: "fix",
      label: "问题修复",
      help: "修正现有显示或行为与预期不一致的问题，并写清当前现象。",
      example: "例如：选择材料后膜层表应立即更新；当前不会更新。",
    },
  ];

  const CHANGE_OPERATION_BY_VALUE = new Map(
    CHANGE_OPERATIONS.map((operation) => [operation.value, operation]),
  );

  const app = {
    mode: "live",
    tool: "box",
    states: [],
    activeStateId: null,
    annotations: [],
    selectedId: null,
    annotationCounter: 0,
    stateCounter: 0,
    pendingCapture: null,
    pendingTarget: null,
    drawing: null,
    panelDrag: null,
    host: null,
    shadow: null,
    ui: {},
  };

  function nowIso() {
    return new Date().toISOString();
  }

  function idFor(prefix) {
    const value =
      prefix === "A" ? ++app.annotationCounter : ++app.stateCounter;
    return `${prefix}${String(value)}`;
  }

  function send(type, payload = {}) {
    nativeSend(JSON.stringify({ type, payload }));
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function setPanelPosition(left, top) {
    const panel = app.ui.panel;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    panel.style.right = "auto";
    panel.style.left = `${clamp(left, margin, maxLeft)}px`;
    panel.style.top = `${clamp(top, margin, maxTop)}px`;
  }

  function clampCurrentPanel() {
    const panel = app.ui.panel;
    if (!panel?.style.left) return;
    const rect = panel.getBoundingClientRect();
    setPanelPosition(rect.left, rect.top);
  }

  function startPanelDrag(event) {
    if (
      event.button !== 0 ||
      event.target.closest("button, input, textarea, select, a")
    ) {
      return;
    }
    const panel = app.ui.panel;
    const rect = panel.getBoundingClientRect();
    app.panelDrag = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    panel.classList.add("dragging");
    setPanelPosition(rect.left, rect.top);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function movePanelDrag(event) {
    if (!app.panelDrag || app.panelDrag.pointerId !== event.pointerId) return;
    setPanelPosition(
      event.clientX - app.panelDrag.offsetX,
      event.clientY - app.panelDrag.offsetY,
    );
  }

  function endPanelDrag(event) {
    if (!app.panelDrag || app.panelDrag.pointerId !== event.pointerId) return;
    const header = event.currentTarget;
    if (header.hasPointerCapture?.(event.pointerId)) {
      header.releasePointerCapture(event.pointerId);
    }
    app.ui.panel.classList.remove("dragging");
    app.panelDrag = null;
  }

  function shortText(value, limit = 240) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  }

  function normalizedOperations(intent = {}) {
    const values = Array.isArray(intent.operations)
      ? intent.operations
      : typeof intent.operation === "string"
        ? [intent.operation]
        : [];
    return [...new Set(values)].filter((value) =>
      CHANGE_OPERATION_BY_VALUE.has(value),
    );
  }

  function operationLabels(operations) {
    return operations
      .map((value) => CHANGE_OPERATION_BY_VALUE.get(value)?.label)
      .filter(Boolean)
      .join("、");
  }

  function expectedPlaceholder(operations) {
    if (operations.length === 0) {
      return "例如：先选择“想改什么”，再描述修改完成后应看到或发生什么";
    }
    if (operations.length === 1) {
      return CHANGE_OPERATION_BY_VALUE.get(operations[0]).example;
    }
    return (
      "例如：同时调整" +
      operationLabels(operations) +
      "；请分别说明修改完成后应看到或发生什么。"
    );
  }

  function maskSensitiveText(value) {
    return shortText(value)
      .replace(
        /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
        "[email redacted]",
      )
      .replace(/\b(?:\d[ -]*?){12,19}\b/g, "[number redacted]")
      .replace(
        /\b(?:token|secret|password|passwd|api[_-]?key)\s*[:=]\s*\S+/gi,
        "$1=[redacted]",
      );
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
  }

  function inferredRole(element) {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "img") return "img";
    if (tag === "nav") return "navigation";
    if (tag === "main") return "main";
    if (tag === "form") return "form";
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      return "textbox";
    }
    return "";
  }

  function accessibleName(element) {
    const aria = element.getAttribute("aria-label");
    if (aria) return maskSensitiveText(aria);
    if (element.labels?.length) {
      return maskSensitiveText(element.labels[0].innerText);
    }
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const label = document.getElementById(labelledBy.split(/\s+/)[0]);
      if (label) return maskSensitiveText(label.innerText);
    }
    const alt = element.getAttribute("alt");
    if (alt) return maskSensitiveText(alt);
    const title = element.getAttribute("title");
    if (title) return maskSensitiveText(title);
    const type = (element.getAttribute("type") || "").toLowerCase();
    if (type === "password") return "[password field]";
    return maskSensitiveText(element.innerText || element.textContent || "");
  }

  function stableSelector(element) {
    const testId =
      element.getAttribute("data-testid") ||
      element.getAttribute("data-test") ||
      element.getAttribute("data-cy");
    if (testId) {
      const attribute = element.hasAttribute("data-testid")
        ? "data-testid"
        : element.hasAttribute("data-test")
          ? "data-test"
          : "data-cy";
      return `[${attribute}="${cssEscape(testId)}"]`;
    }
    if (element.id) return `#${cssEscape(element.id)}`;

    const parts = [];
    let node = element;
    for (let depth = 0; node && node.nodeType === 1 && depth < 5; depth += 1) {
      let part = node.tagName.toLowerCase();
      const role = node.getAttribute("role");
      if (role) part += `[role="${cssEscape(role)}"]`;
      const parent = node.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter(
          (child) => child.tagName === node.tagName,
        );
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
      }
      parts.unshift(part);
      if (node === document.body) break;
      node = parent;
    }
    return parts.join(" > ");
  }

  function sanitizedOuterHtml(element) {
    const clone = element.cloneNode(true);
    const nodes = [clone, ...clone.querySelectorAll("*")];
    for (const node of nodes) {
      for (const attribute of [...node.attributes]) {
        if (
          attribute.name === "value" ||
          attribute.name.startsWith("on") ||
          ["srcdoc", "nonce"].includes(attribute.name)
        ) {
          node.removeAttribute(attribute.name);
        }
      }
      if (["INPUT", "TEXTAREA", "SELECT"].includes(node.tagName)) {
        node.textContent = "";
      }
      if (node.hasAttribute("contenteditable")) {
        node.textContent = "[editable content removed]";
      }
    }
    for (const unsafe of clone.querySelectorAll("script, style, template")) {
      unsafe.remove();
    }
    return maskSensitiveText(clone.outerHTML).slice(0, 2000);
  }

  function ancestryFor(element) {
    const result = [];
    let node = element.parentElement;
    for (let depth = 0; node && depth < 4; depth += 1) {
      result.push({
        tag: node.tagName.toLowerCase(),
        id: node.id || "",
        role: inferredRole(node),
        className: shortText(
          typeof node.className === "string" ? node.className : "",
          120,
        ),
      });
      node = node.parentElement;
    }
    return result;
  }

  function sourceMetadata(element) {
    const raw =
      element.getAttribute("data-ui-source") ||
      element.getAttribute("data-source-file") ||
      "";
    const lineAttribute =
      element.getAttribute("data-source-line") ||
      element.getAttribute("data-ui-source-line") ||
      "";
    let sourceFile = raw;
    let sourceLine = Number(lineAttribute) || null;
    const match = raw.match(/^(.*?):(\d+)(?::\d+)?$/);
    if (match) {
      sourceFile = match[1];
      sourceLine = Number(match[2]);
    }
    return {
      sourceFile: sourceFile || "",
      sourceLine,
      componentName:
        element.getAttribute("data-component") ||
        element.getAttribute("data-component-name") ||
        "",
    };
  }

  function captureElement(element) {
    if (!element || element === app.host || app.host.contains(element)) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    const allowedAttributes = [
      "name",
      "type",
      "href",
      "placeholder",
      "aria-label",
      "role",
      "data-testid",
      "data-test",
      "data-cy",
      "data-component",
      "data-source-file",
      "data-source-line",
      "data-ui-source",
    ];
    const attributes = {};
    for (const name of allowedAttributes) {
      if (element.hasAttribute(name)) {
        attributes[name] = maskSensitiveText(element.getAttribute(name));
      }
    }
    const metadata = sourceMetadata(element);
    return {
      tag: element.tagName.toLowerCase(),
      id: element.id || "",
      role: inferredRole(element),
      accessibleName: accessibleName(element),
      text:
        (element.getAttribute("type") || "").toLowerCase() === "password"
          ? "[password field]"
          : maskSensitiveText(element.innerText || element.textContent || ""),
      testId:
        element.getAttribute("data-testid") ||
        element.getAttribute("data-test") ||
        element.getAttribute("data-cy") ||
        "",
      selector: stableSelector(element),
      attributes,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      ancestry: ancestryFor(element),
      domExcerpt: sanitizedOuterHtml(element),
      ...metadata,
    };
  }

  function targetAt(x, y) {
    const previousDisplay = app.host.style.display;
    app.host.style.display = "none";
    const element = document.elementFromPoint(x, y);
    app.host.style.display = previousDisplay;
    return captureElement(element);
  }

  function stateById(id) {
    return app.states.find((item) => item.id === id);
  }

  function annotationsForState(id) {
    return app.annotations.filter((item) => item.stateId === id);
  }

  function activeState() {
    return stateById(app.activeStateId);
  }

  function showToast(message, tone = "info") {
    const toast = app.ui.toast;
    toast.textContent = message;
    toast.dataset.tone = tone;
    toast.classList.add("visible");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove("visible"), 3200);
  }

  function setCaptureUiHidden(hidden) {
    if (hidden) {
      app.ui.panel.style.display = "none";
      app.ui.toast.classList.remove("visible");
      app.ui.toast.style.display = "none";
      app.ui.pickerHighlight.style.display = "none";
      return;
    }
    app.ui.panel.style.display = "";
    app.ui.toast.style.display = "";
  }

  function setMode(mode) {
    app.mode = mode;
    const frozen = mode === "frozen";
    app.ui.stage.classList.toggle("visible", frozen);
    app.ui.status.textContent =
      mode === "live"
        ? "实时"
        : mode === "picking"
          ? "选择元素"
          : mode === "capturing"
            ? "正在冻结"
            : "已冻结";
    app.ui.status.dataset.mode = mode;
    app.ui.freeze.textContent = frozen ? "返回实时页面" : "冻结当前画面";
    app.ui.pick.classList.toggle("active", mode === "picking");
    app.ui.toolButtons.forEach((button) => {
      button.disabled = !frozen;
    });
    app.ui.stateSelect.disabled = app.states.length === 0;
    app.ui.deleteState.disabled = app.states.length === 0;
  }

  function updateStateSelector() {
    const select = app.ui.stateSelect;
    select.innerHTML = "";
    for (const [index, state] of app.states.entries()) {
      const option = document.createElement("option");
      option.value = state.id;
      option.textContent = `${index + 1}. ${state.description || state.title || state.url}`;
      select.append(option);
    }
    select.value = app.activeStateId || "";
    select.disabled = app.states.length === 0;
    app.ui.deleteState.disabled = app.states.length === 0;
  }

  function selectState(id) {
    const state = stateById(id);
    if (!state) return;
    app.activeStateId = id;
    app.ui.stateSelect.value = id;
    app.ui.stateDescription.value = state.description || "";
    app.ui.screenshot.src = state.screenshotDataUrl;
    renderAnnotations();
    renderAnnotationList();
  }

  function annotationLabel(annotation) {
    if (annotation.kind === "redact") return `${annotation.id} 隐私遮挡`;
    const expected = shortText(annotation.intent?.expected, 34);
    return expected || `${annotation.id} ${annotation.kind}`;
  }

  function svgElement(name, attributes = {}) {
    const element = document.createElementNS(
      "http://www.w3.org/2000/svg",
      name,
    );
    for (const [key, value] of Object.entries(attributes)) {
      element.setAttribute(key, String(value));
    }
    return element;
  }

  function addSvgLabel(svg, annotation, x, y) {
    const group = svgElement("g");
    const label = svgElement("rect", {
      x: clamp(x, 4, window.innerWidth - 48),
      y: clamp(y - 24, 4, window.innerHeight - 24),
      width: 42,
      height: 22,
      rx: 5,
      fill: COLORS[annotation.kind] || COLORS.box,
    });
    const text = svgElement("text", {
      x: clamp(x + 21, 25, window.innerWidth - 27),
      y: clamp(y - 9, 19, window.innerHeight - 9),
      "text-anchor": "middle",
      fill: "#08111f",
      "font-size": 12,
      "font-weight": 800,
      "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace",
    });
    text.textContent = annotation.id;
    group.append(label, text);
    svg.append(group);
  }

  function renderAnnotations() {
    const svg = app.ui.svg;
    svg.innerHTML = `
      <defs>
        <marker id="symbui-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
          <path d="M0,0 L0,6 L9,3 z" fill="#a78bfa"></path>
        </marker>
      </defs>
    `;
    const current = activeState();
    if (!current) return;

    for (const annotation of annotationsForState(current.id)) {
      const geometry = annotation.geometry;
      const selected = annotation.id === app.selectedId;
      const color = COLORS[annotation.kind] || COLORS.box;
      if (annotation.kind === "point") {
        svg.append(
          svgElement("circle", {
            cx: geometry.x,
            cy: geometry.y,
            r: selected ? 11 : 8,
            fill: color,
            stroke: "#ffffff",
            "stroke-width": selected ? 3 : 2,
          }),
        );
        addSvgLabel(svg, annotation, geometry.x + 12, geometry.y);
      } else if (annotation.kind === "arrow") {
        svg.append(
          svgElement("line", {
            x1: geometry.x1,
            y1: geometry.y1,
            x2: geometry.x2,
            y2: geometry.y2,
            stroke: color,
            "stroke-width": selected ? 5 : 3,
            "marker-end": "url(#symbui-arrow)",
          }),
        );
        addSvgLabel(svg, annotation, geometry.x1, geometry.y1);
      } else {
        svg.append(
          svgElement("rect", {
            x: geometry.x,
            y: geometry.y,
            width: geometry.width,
            height: geometry.height,
            rx: annotation.kind === "redact" ? 0 : 4,
            fill:
              annotation.kind === "redact"
                ? "#050505"
                : `${color}${selected ? "38" : "20"}`,
            stroke: color,
            "stroke-width": selected ? 4 : 2,
            "stroke-dasharray": annotation.kind === "box" ? "8 4" : "",
          }),
        );
        if (annotation.kind !== "redact") {
          addSvgLabel(svg, annotation, geometry.x, geometry.y);
        }
      }
    }
  }

  function renderAnnotationList() {
    const list = app.ui.annotationList;
    list.innerHTML = "";
    const current = activeState();
    const annotations = current ? annotationsForState(current.id) : [];
    if (annotations.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "尚无标注";
      list.append(empty);
      renderEditor();
      return;
    }

    for (const annotation of annotations) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "annotation-item";
      button.classList.toggle("selected", annotation.id === app.selectedId);
      button.innerHTML = `<strong>${annotation.id}</strong><span>${annotationLabel(annotation)}</span>`;
      button.addEventListener("click", () => {
        app.selectedId = annotation.id;
        renderAnnotationList();
        renderAnnotations();
        renderEditor();
      });
      list.append(button);
    }
    renderEditor();
  }

  function selectedAnnotation() {
    return app.annotations.find((item) => item.id === app.selectedId);
  }

  function renderEditor() {
    const annotation = selectedAnnotation();
    const editor = app.ui.editor;
    if (!annotation || annotation.kind === "redact") {
      editor.classList.add("hidden");
      return;
    }
    editor.classList.remove("hidden");
    app.ui.editorTitle.textContent = annotation.id + " 修改说明";
    const operations = normalizedOperations(annotation.intent);
    app.ui.operationButtons.forEach((button) => {
      const selected = operations.includes(button.dataset.operation);
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    app.ui.expected.value = annotation.intent.expected;
    app.ui.expected.placeholder = expectedPlaceholder(operations);
    app.ui.scope.value = annotation.intent.scope;
    app.ui.breakpoint.value = annotation.intent.breakpoint;
    app.ui.priority.value = annotation.intent.priority;
    app.ui.invariants.value = annotation.intent.invariants;
  }

  function updateSelectedIntent() {
    const annotation = selectedAnnotation();
    if (!annotation || annotation.kind === "redact") return;
    annotation.intent = {
      operations: normalizedOperations(annotation.intent),
      expected: app.ui.expected.value,
      scope: app.ui.scope.value,
      breakpoint: app.ui.breakpoint.value,
      priority: app.ui.priority.value,
      invariants: app.ui.invariants.value,
    };
    renderAnnotationList();
  }

  function toggleOperation(value) {
    const annotation = selectedAnnotation();
    if (
      !annotation ||
      annotation.kind === "redact" ||
      !CHANGE_OPERATION_BY_VALUE.has(value)
    ) {
      return;
    }
    const operations = normalizedOperations(annotation.intent);
    const next = operations.includes(value)
      ? operations.filter((operation) => operation !== value)
      : [...operations, value];
    annotation.intent = {
      ...annotation.intent,
      operations: next,
    };
    renderAnnotationList();
    renderEditor();
  }

  function createAnnotation(kind, geometry, target = null) {
    const current = activeState();
    if (!current) return null;
    const annotation = {
      id: idFor("A"),
      stateId: current.id,
      kind,
      geometry,
      target: kind === "redact" ? null : target,
      intent:
        kind === "redact"
          ? null
          : {
              operations: [],
              expected: "",
              scope: "element",
              breakpoint: "all",
              priority: "must",
              invariants: "",
            },
      createdAt: nowIso(),
    };
    app.annotations.push(annotation);
    app.selectedId = annotation.id;
    renderAnnotations();
    renderAnnotationList();
    if (kind !== "redact") {
      setTimeout(() => app.ui.expected.focus(), 0);
    }
    return annotation;
  }

  function deleteSelected() {
    if (!app.selectedId) return;
    const index = app.annotations.findIndex((item) => item.id === app.selectedId);
    if (index === -1) return;
    app.annotations.splice(index, 1);
    const remaining = annotationsForState(app.activeStateId);
    app.selectedId = remaining.at(-1)?.id || null;
    renderAnnotations();
    renderAnnotationList();
  }

  function deleteActiveState() {
    const state = activeState();
    if (!state) return;
    const annotationCount = annotationsForState(state.id).length;
    const detail =
      annotationCount > 0
        ? `，并同时删除其中 ${annotationCount} 条标注`
        : "";
    if (!window.confirm(`确定删除当前冻结页面${detail}吗？`)) return;

    send("delete-state", {
      stateId: state.id,
      beforeImage: state.beforeImage,
      annotatedImage: state.annotatedImage,
    });
    const index = app.states.findIndex((item) => item.id === state.id);
    app.states.splice(index, 1);
    app.annotations = app.annotations.filter(
      (annotation) => annotation.stateId !== state.id,
    );
    app.selectedId = null;

    const nextState = app.states[index] || app.states[index - 1] || null;
    app.activeStateId = nextState?.id || null;
    updateStateSelector();
    if (nextState) {
      selectState(nextState.id);
      setMode("frozen");
    } else {
      app.ui.stateDescription.value = "";
      app.ui.screenshot.removeAttribute("src");
      returnLive();
    }
    showToast(`已删除冻结页面 ${state.id}`, "success");
  }

  function undo() {
    const current = activeState();
    if (!current) return;
    for (let index = app.annotations.length - 1; index >= 0; index -= 1) {
      if (app.annotations[index].stateId !== current.id) continue;
      const [removed] = app.annotations.splice(index, 1);
      if (removed.id === app.selectedId) app.selectedId = null;
      renderAnnotations();
      renderAnnotationList();
      return;
    }
  }

  function chooseTool(tool) {
    app.tool = tool;
    for (const button of app.ui.toolButtons) {
      button.classList.toggle("active", button.dataset.tool === tool);
    }
  }

  async function requestCapture(target = null) {
    if (app.mode === "capturing") return;
    const stateId = idFor("S");
    app.pendingTarget = target;
    app.pendingCapture = {
      id: stateId,
      title: shortText(document.title, 160),
      description: shortText(document.title, 160),
      url: location.href,
      capturedAt: nowIso(),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        deviceScaleFactor: window.devicePixelRatio || 1,
      },
      scroll: {
        x: Math.round(window.scrollX),
        y: Math.round(window.scrollY),
      },
    };
    stopPicking();
    setMode("capturing");
    setCaptureUiHidden(true);
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    send("request-capture", { state: app.pendingCapture });
  }

  function returnLive() {
    app.selectedId = null;
    app.ui.stage.classList.remove("visible");
    setMode("live");
    stopPicking();
    renderAnnotationList();
  }

  function toggleFreeze() {
    if (app.mode === "frozen") {
      returnLive();
      return;
    }
    requestCapture().catch((error) => {
      setCaptureUiHidden(false);
      setMode("live");
      showToast(error.message || String(error), "error");
    });
  }

  function pickerMove(event) {
    if (app.mode !== "picking") return;
    if (event.composedPath().includes(app.host)) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const rect = target.getBoundingClientRect();
    Object.assign(app.ui.pickerHighlight.style, {
      display: "block",
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }

  function pickerClick(event) {
    if (app.mode !== "picking") return;
    if (event.composedPath().includes(app.host)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const target = event.target instanceof Element ? event.target : null;
    const evidence = captureElement(target);
    stopPicking();
    requestCapture(evidence).catch((error) => {
      setCaptureUiHidden(false);
      setMode("live");
      showToast(error.message || String(error), "error");
    });
  }

  function stopPicking() {
    document.removeEventListener("mousemove", pickerMove, true);
    document.removeEventListener("click", pickerClick, true);
    app.ui.pickerHighlight.style.display = "none";
  }

  function startPicking() {
    if (app.mode === "frozen") returnLive();
    if (app.mode === "picking") {
      stopPicking();
      setMode("live");
      return;
    }
    setMode("picking");
    document.addEventListener("mousemove", pickerMove, true);
    document.addEventListener("click", pickerClick, true);
    showToast("移动鼠标并点击需要修改的元素");
  }

  function viewportPoint(event) {
    return {
      x: clamp(event.clientX, 0, window.innerWidth),
      y: clamp(event.clientY, 0, window.innerHeight),
    };
  }

  function drawDraft(start, end, tool) {
    const draft = app.ui.draft;
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const width = Math.abs(end.x - start.x);
    const height = Math.abs(end.y - start.y);
    Object.assign(draft.style, {
      display: "block",
      left: `${x}px`,
      top: `${y}px`,
      width: `${width}px`,
      height: `${height}px`,
      borderColor: COLORS[tool] || COLORS.box,
      background:
        tool === "redact" ? "rgba(0,0,0,.78)" : "rgba(56,189,248,.08)",
    });
  }

  function stagePointerDown(event) {
    if (app.mode !== "frozen" || event.button !== 0) return;
    if (event.composedPath().includes(app.ui.panel)) return;
    const point = viewportPoint(event);
    if (app.tool === "point") {
      createAnnotation("point", point, targetAt(point.x, point.y));
      return;
    }
    app.drawing = { start: point, current: point, tool: app.tool };
    app.ui.stage.setPointerCapture(event.pointerId);
    drawDraft(point, point, app.tool);
    event.preventDefault();
  }

  function stagePointerMove(event) {
    if (!app.drawing) return;
    app.drawing.current = viewportPoint(event);
    drawDraft(app.drawing.start, app.drawing.current, app.drawing.tool);
  }

  function stagePointerUp(event) {
    if (!app.drawing) return;
    const drawing = app.drawing;
    app.drawing = null;
    app.ui.draft.style.display = "none";
    const end = viewportPoint(event);
    const width = Math.abs(end.x - drawing.start.x);
    const height = Math.abs(end.y - drawing.start.y);
    if (drawing.tool === "arrow") {
      if (Math.hypot(width, height) < 10) return;
      createAnnotation(
        "arrow",
        {
          x1: drawing.start.x,
          y1: drawing.start.y,
          x2: end.x,
          y2: end.y,
        },
        targetAt(end.x, end.y),
      );
      return;
    }
    if (width < 6 || height < 6) return;
    const geometry = {
      x: Math.min(drawing.start.x, end.x),
      y: Math.min(drawing.start.y, end.y),
      width,
      height,
    };
    const centerX = geometry.x + geometry.width / 2;
    const centerY = geometry.y + geometry.height / 2;
    createAnnotation(
      drawing.tool,
      geometry,
      drawing.tool === "redact" ? null : targetAt(centerX, centerY),
    );
  }

  function loadImage(source) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = source;
    });
  }

  function drawCanvasAnnotation(context, annotation) {
    const geometry = annotation.geometry;
    const color = COLORS[annotation.kind] || COLORS.box;
    context.save();
    context.lineWidth = 3;
    context.strokeStyle = color;
    context.fillStyle = color;
    context.font =
      "800 12px ui-monospace, SFMono-Regular, Menlo, monospace";

    if (annotation.kind === "redact") {
      context.fillStyle = "#050505";
      context.fillRect(
        geometry.x,
        geometry.y,
        geometry.width,
        geometry.height,
      );
      context.restore();
      return;
    }
    if (annotation.kind === "point") {
      context.beginPath();
      context.arc(geometry.x, geometry.y, 9, 0, Math.PI * 2);
      context.fill();
    } else if (annotation.kind === "arrow") {
      const angle = Math.atan2(
        geometry.y2 - geometry.y1,
        geometry.x2 - geometry.x1,
      );
      context.beginPath();
      context.moveTo(geometry.x1, geometry.y1);
      context.lineTo(geometry.x2, geometry.y2);
      context.stroke();
      context.beginPath();
      context.moveTo(geometry.x2, geometry.y2);
      context.lineTo(
        geometry.x2 - 14 * Math.cos(angle - Math.PI / 6),
        geometry.y2 - 14 * Math.sin(angle - Math.PI / 6),
      );
      context.lineTo(
        geometry.x2 - 14 * Math.cos(angle + Math.PI / 6),
        geometry.y2 - 14 * Math.sin(angle + Math.PI / 6),
      );
      context.closePath();
      context.fill();
    } else {
      context.fillStyle = `${color}24`;
      context.fillRect(
        geometry.x,
        geometry.y,
        geometry.width,
        geometry.height,
      );
      context.strokeRect(
        geometry.x,
        geometry.y,
        geometry.width,
        geometry.height,
      );
    }

    const labelX =
      annotation.kind === "point"
        ? geometry.x + 12
        : annotation.kind === "arrow"
          ? geometry.x1
          : geometry.x;
    const labelY =
      annotation.kind === "point"
        ? geometry.y - 22
        : annotation.kind === "arrow"
          ? geometry.y1 - 26
          : geometry.y - 26;
    context.fillStyle = color;
    context.fillRect(labelX, Math.max(2, labelY), 42, 22);
    context.fillStyle = "#08111f";
    context.textAlign = "center";
    context.fillText(annotation.id, labelX + 21, Math.max(17, labelY + 15));
    context.restore();
  }

  async function annotatedImageFor(state) {
    const image = await loadImage(state.screenshotDataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    context.save();
    context.scale(
      image.naturalWidth / state.viewport.width,
      image.naturalHeight / state.viewport.height,
    );
    for (const annotation of annotationsForState(state.id)) {
      drawCanvasAnnotation(context, annotation);
    }
    context.restore();
    return canvas.toDataURL("image/png");
  }

  async function finishSession() {
    const actionable = app.annotations.filter(
      (annotation) => annotation.kind !== "redact",
    );
    if (actionable.length === 0) {
      showToast("请至少添加一条修改标注", "error");
      return;
    }
    const missingOperations = actionable.find(
      (annotation) => normalizedOperations(annotation.intent).length === 0,
    );
    if (missingOperations) {
      selectState(missingOperations.stateId);
      app.selectedId = missingOperations.id;
      setMode("frozen");
      renderAnnotationList();
      renderAnnotations();
      showToast(
        missingOperations.id + " 请至少选择一项“想改什么”",
        "error",
      );
      app.ui.operationButtons[0]?.focus();
      return;
    }
    const incomplete = actionable.find(
      (annotation) => !annotation.intent.expected.trim(),
    );
    if (incomplete) {
      selectState(incomplete.stateId);
      app.selectedId = incomplete.id;
      setMode("frozen");
      renderAnnotationList();
      renderAnnotations();
      showToast(`${incomplete.id} 还没有填写预期结果`, "error");
      app.ui.expected.focus();
      return;
    }

    app.ui.finish.disabled = true;
    app.ui.finish.textContent = "正在生成…";
    try {
      for (const state of app.states) {
        const dataUrl = await annotatedImageFor(state);
        send("save-annotated", {
          stateId: state.id,
          fileName: state.annotatedImage,
          dataUrl,
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
      }

      const session = {
        schemaVersion: "1.1",
        sessionId: config.sessionId,
        createdAt: config.createdAt,
        completedAt: nowIso(),
        repoPath: config.repoPath,
        targetUrl: config.targetUrl,
        states: app.states.map((state) => ({
          id: state.id,
          title: state.title,
          description: state.description,
          url: state.url,
          capturedAt: state.capturedAt,
          viewport: state.viewport,
          scroll: state.scroll,
          beforeImage: state.beforeImage,
          annotatedImage: state.annotatedImage,
        })),
        annotations: app.annotations.map((annotation) =>
          JSON.parse(JSON.stringify(annotation)),
        ),
      };
      send("finish-session", { session });
      showToast("正在整理修改规格…");
    } catch (error) {
      app.ui.finish.disabled = false;
      app.ui.finish.textContent = "完成并生成";
      showToast(error.message || String(error), "error");
    }
  }

  function receive(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "capture-ready") {
      setCaptureUiHidden(false);
      const state = {
        ...app.pendingCapture,
        beforeImage: message.beforeImage,
        annotatedImage: `annotated-${app.pendingCapture.id}.png`,
        screenshotDataUrl: message.dataUrl,
      };
      app.states.push(state);
      app.activeStateId = state.id;
      app.pendingCapture = null;
      updateStateSelector();
      selectState(state.id);
      setMode("frozen");
      if (app.pendingTarget) {
        const target = app.pendingTarget;
        app.pendingTarget = null;
        const rect = target.rect;
        createAnnotation(
          "element",
          {
            x: clamp(rect.x, 0, window.innerWidth),
            y: clamp(rect.y, 0, window.innerHeight),
            width: clamp(rect.width, 1, window.innerWidth),
            height: clamp(rect.height, 1, window.innerHeight),
          },
          target,
        );
      }
      showToast("画面已冻结，可以开始标注");
      return;
    }
    if (message.type === "capture-error") {
      setCaptureUiHidden(false);
      app.pendingCapture = null;
      app.pendingTarget = null;
      setMode("live");
      showToast(message.message || "截图失败", "error");
      return;
    }
    if (message.type === "session-error") {
      app.ui.finish.disabled = false;
      app.ui.finish.textContent = "完成并生成";
      showToast(message.message || "生成失败", "error");
      return;
    }
    if (message.type === "session-complete") {
      app.ui.finish.textContent = "已生成";
      app.ui.output.classList.remove("hidden");
      app.ui.output.textContent = `输出目录：${message.sessionDir}`;
      showToast("修改规格已生成", "success");
    }
  }

  window.__SYMBUI_RECEIVE__ = receive;

  function installUi() {
    if (app.host) return;
    const host = document.createElement("div");
    host.id = "__symbui-host";
    host.setAttribute("data-symbui", "overlay");
    Object.assign(host.style, {
      position: "fixed",
      inset: "0",
      width: "100vw",
      height: "100vh",
      zIndex: "2147483647",
      pointerEvents: "none",
      fontFamily:
        'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    });
    document.documentElement.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    app.host = host;
    app.shadow = shadow;

    const style = document.createElement("style");
    style.textContent = `
      * { box-sizing: border-box; }
      button, input, textarea, select { font: inherit; }
      button { cursor: pointer; }
      .stage {
        display: none;
        position: fixed;
        inset: 0;
        width: 100vw;
        height: 100vh;
        overflow: hidden;
        pointer-events: auto;
        cursor: crosshair;
        background: #0b1020;
      }
      .stage.visible { display: block; }
      .stage > img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: fill;
        user-select: none;
        pointer-events: none;
      }
      .stage > svg {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
      }
      .draft {
        display: none;
        position: fixed;
        border: 2px dashed #38bdf8;
        pointer-events: none;
      }
      .picker-highlight {
        display: none;
        position: fixed;
        border: 2px solid #38bdf8;
        background: rgba(56,189,248,.12);
        box-shadow: 0 0 0 1px rgba(255,255,255,.75) inset;
        pointer-events: none;
      }
      .panel {
        position: fixed;
        top: 14px;
        right: 14px;
        width: 356px;
        max-height: calc(100vh - 28px);
        display: flex;
        flex-direction: column;
        color: #e5eefc;
        background: rgba(10,17,31,.97);
        border: 1px solid rgba(148,163,184,.28);
        border-radius: 16px;
        box-shadow: 0 24px 70px rgba(0,0,0,.42);
        overflow: hidden;
        pointer-events: auto;
        backdrop-filter: blur(18px);
      }
      .panel.collapsed { width: 188px; }
      .panel.collapsed .panel-body,
      .panel.collapsed .panel-footer { display: none; }
      .panel-header {
        min-height: 58px;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 14px;
        border-bottom: 1px solid rgba(148,163,184,.18);
        cursor: grab;
        touch-action: none;
        user-select: none;
      }
      .panel.dragging .panel-header { cursor: grabbing; }
      .brand {
        display: grid;
        place-items: center;
        width: 32px;
        height: 32px;
        border-radius: 9px;
        color: #07111f;
        background: linear-gradient(135deg,#67e8f9,#38bdf8);
        font-weight: 900;
      }
      .title { flex: 1; min-width: 0; }
      .title strong { display: block; font-size: 14px; letter-spacing: .02em; }
      .title span { display: block; margin-top: 2px; color: #8ea3bf; font-size: 11px; }
      .drag-hint {
        color: #60748f;
        font-size: 13px;
        letter-spacing: -3px;
        pointer-events: none;
      }
      .status[data-mode="live"] { color: #86efac; }
      .status[data-mode="frozen"] { color: #7dd3fc; }
      .status[data-mode="picking"],
      .status[data-mode="capturing"] { color: #fde68a; }
      .icon-button {
        width: 30px;
        height: 30px;
        border: 0;
        border-radius: 8px;
        color: #aabbd1;
        background: rgba(148,163,184,.1);
      }
      .panel-body {
        overflow: auto;
        scrollbar-color: #334155 transparent;
      }
      section { padding: 12px 14px; border-bottom: 1px solid rgba(148,163,184,.13); }
      .row { display: flex; gap: 8px; align-items: center; }
      .row + .row { margin-top: 8px; }
      .state-row .state-select { flex: 1; min-width: 0; }
      .delete-state { flex: 0 0 auto; white-space: nowrap; }
      .primary, .secondary, .danger, .tool {
        min-height: 34px;
        border: 1px solid transparent;
        border-radius: 9px;
        padding: 7px 10px;
        color: #dbeafe;
        background: rgba(51,65,85,.75);
      }
      .primary {
        flex: 1;
        color: #062132;
        background: #67e8f9;
        font-weight: 800;
      }
      .secondary { flex: 1; border-color: rgba(148,163,184,.2); }
      .secondary.active, .tool.active {
        color: #07111f;
        background: #fbbf24;
      }
      button:disabled { cursor: not-allowed; opacity: .38; }
      .tool-grid {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 6px;
      }
      .tool { min-width: 0; padding: 7px 4px; font-size: 12px; }
      .section-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
        color: #8ea3bf;
        font-size: 11px;
        font-weight: 800;
        letter-spacing: .08em;
        text-transform: uppercase;
      }
      select, input, textarea {
        width: 100%;
        border: 1px solid rgba(148,163,184,.26);
        border-radius: 8px;
        color: #e5eefc;
        background: #111c2f;
        outline: none;
      }
      select, input { height: 34px; padding: 0 9px; }
      textarea { min-height: 68px; padding: 8px 9px; resize: vertical; }
      select:focus, input:focus, textarea:focus {
        border-color: #38bdf8;
        box-shadow: 0 0 0 2px rgba(56,189,248,.14);
      }
      label { display: block; margin-top: 9px; color: #aabbd1; font-size: 11px; }
      label > span { display: block; margin-bottom: 5px; }
      .two-column { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .intent-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-top: 9px;
        color: #aabbd1;
        font-size: 11px;
      }
      .intent-heading strong { color: #dbeafe; font-size: 12px; }
      .intent-heading-note { color: #6f849f; font-size: 10px; }
      .change-type-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 6px;
        margin-top: 6px;
      }
      .change-type {
        min-width: 0;
        min-height: 30px;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        padding: 5px 4px;
        border: 1px solid rgba(148,163,184,.26);
        border-radius: 8px;
        color: #aabbd1;
        background: rgba(30,41,59,.72);
        font-size: 11px;
        line-height: 1.1;
        white-space: nowrap;
      }
      .change-type:hover {
        border-color: rgba(125,211,252,.72);
        color: #e5eefc;
      }
      .change-type.selected {
        border-color: #38bdf8;
        color: #cffafe;
        background: rgba(14,116,144,.35);
      }
      .change-type:focus-visible {
        outline: 2px solid #67e8f9;
        outline-offset: 2px;
      }
      .change-type-check {
        width: 11px;
        color: #67e8f9;
        font-weight: 900;
        opacity: 0;
      }
      .change-type.selected .change-type-check { opacity: 1; }
      .priority-field { width: min(156px, 100%); }
      .annotation-list { display: grid; gap: 6px; }
      .annotation-item {
        width: 100%;
        display: flex;
        align-items: center;
        gap: 8px;
        border: 1px solid rgba(148,163,184,.15);
        border-radius: 9px;
        padding: 7px 8px;
        color: #dbeafe;
        text-align: left;
        background: rgba(30,41,59,.66);
      }
      .annotation-item.selected { border-color: #38bdf8; background: rgba(14,116,144,.25); }
      .annotation-item strong { color: #67e8f9; font-size: 12px; }
      .annotation-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
      .empty { padding: 12px; color: #6f849f; text-align: center; font-size: 12px; }
      .editor.hidden, .output.hidden { display: none; }
      .danger { color: #fecaca; border-color: rgba(248,113,113,.25); background: rgba(127,29,29,.35); }
      .panel-footer {
        padding: 12px 14px;
        background: rgba(8,15,27,.98);
      }
      .finish {
        width: 100%;
        min-height: 40px;
        border: 0;
        border-radius: 10px;
        color: #07111f;
        background: linear-gradient(135deg,#67e8f9,#22d3ee);
        font-weight: 900;
      }
      .output {
        margin-top: 9px;
        padding: 8px;
        border-radius: 8px;
        color: #bbf7d0;
        background: rgba(20,83,45,.4);
        font-size: 11px;
        word-break: break-all;
      }
      .toast {
        position: fixed;
        left: 50%;
        bottom: 22px;
        max-width: 520px;
        transform: translate(-50%, 20px);
        padding: 10px 14px;
        border: 1px solid rgba(148,163,184,.24);
        border-radius: 10px;
        color: #e5eefc;
        background: rgba(15,23,42,.96);
        box-shadow: 0 14px 40px rgba(0,0,0,.35);
        opacity: 0;
        transition: .18s ease;
        pointer-events: none;
      }
      .toast.visible { opacity: 1; transform: translate(-50%, 0); }
      .toast[data-tone="error"] { color: #fecaca; border-color: rgba(248,113,113,.5); }
      .toast[data-tone="success"] { color: #bbf7d0; border-color: rgba(74,222,128,.5); }
      @media (max-width: 700px) {
        .panel { top: 8px; right: 8px; width: min(356px, calc(100vw - 16px)); max-height: calc(100vh - 16px); }
      }
    `;

    const stage = document.createElement("div");
    stage.className = "stage";
    stage.innerHTML = `<img alt=""><svg></svg><div class="draft"></div>`;

    const pickerHighlight = document.createElement("div");
    pickerHighlight.className = "picker-highlight";

    const panel = document.createElement("aside");
    panel.className = "panel";
    panel.innerHTML = `
      <header class="panel-header" title="按住顶部空白处拖动浮窗">
        <div class="brand">S</div>
        <div class="title">
          <strong>SymbUI</strong>
          <span class="status" data-mode="live">实时</span>
        </div>
        <span class="drag-hint" aria-hidden="true">⠿</span>
        <button class="icon-button collapse" type="button" title="折叠">—</button>
      </header>
      <div class="panel-body">
        <section>
          <div class="row">
            <button class="primary freeze" type="button">冻结当前画面</button>
            <button class="secondary pick" type="button">选择元素</button>
          </div>
          <div class="row state-row">
            <select class="state-select" aria-label="已捕获状态" disabled></select>
            <button class="danger delete-state" type="button" disabled>删除冻结页</button>
          </div>
          <label><span>当前状态／复现说明</span><input class="state-description" placeholder="例如：点击设置后打开账户弹窗"></label>
        </section>
        <section>
          <div class="section-title"><span>标注工具</span><span>⌘/Ctrl ⇧ A</span></div>
          <div class="tool-grid">
            <button class="tool active" type="button" data-tool="box">框选</button>
            <button class="tool" type="button" data-tool="point">点</button>
            <button class="tool" type="button" data-tool="arrow">箭头</button>
            <button class="tool" type="button" data-tool="redact">遮挡</button>
            <button class="tool undo" type="button">撤销</button>
          </div>
        </section>
        <section>
          <div class="section-title"><span>标注列表</span><button class="danger delete" type="button">删除所选</button></div>
          <div class="annotation-list"></div>
        </section>
        <section class="editor hidden">
          <div class="section-title"><span class="editor-title">修改说明</span></div>
          <div class="intent-heading">
            <strong>想改什么？（可多选）</strong>
            <span class="intent-heading-note">悬停查看说明</span>
          </div>
          <div class="change-type-grid" role="group" aria-label="想改什么，可多选">
            <button class="change-type" type="button" data-operation="layout" aria-pressed="false" title="布局：调整位置、间距、尺寸、对齐或层级。"><span class="change-type-check" aria-hidden="true">✓</span><span>布局</span></button>
            <button class="change-type" type="button" data-operation="style" aria-pressed="false" title="样式：调整颜色、字体、边框、圆角、阴影和视觉状态。"><span class="change-type-check" aria-hidden="true">✓</span><span>样式</span></button>
            <button class="change-type" type="button" data-operation="content" aria-pressed="false" title="内容：调整文案、数字、图标、字段或占位提示。"><span class="change-type-check" aria-hidden="true">✓</span><span>内容</span></button>
            <button class="change-type" type="button" data-operation="interaction" aria-pressed="false" title="交互：调整点击、悬停、输入、显示隐藏、加载反馈或跳转行为。"><span class="change-type-check" aria-hidden="true">✓</span><span>交互</span></button>
            <button class="change-type" type="button" data-operation="add" aria-pressed="false" title="新增：添加控件、区域、操作入口或补充信息。"><span class="change-type-check" aria-hidden="true">✓</span><span>新增</span></button>
            <button class="change-type" type="button" data-operation="remove" aria-pressed="false" title="删除：移除或隐藏控件、内容或入口；请说明需要保留的功能。"><span class="change-type-check" aria-hidden="true">✓</span><span>删除</span></button>
            <button class="change-type" type="button" data-operation="fix" aria-pressed="false" title="问题修复：修正现有显示或行为与预期不一致的问题。"><span class="change-type-check" aria-hidden="true">✓</span><span>问题修复</span></button>
          </div>
          <label class="priority-field"><span>优先级</span>
            <select class="priority">
              <option value="must">必须</option>
              <option value="should">建议</option>
            </select>
          </label>
          <label><span>希望改完后是什么样？（必填）</span><textarea class="expected" placeholder="例如：先选择“想改什么”，再描述修改完成后应看到或发生什么"></textarea></label>
          <div class="two-column">
            <label><span>作用范围</span>
              <select class="scope">
                <option value="element">仅此元素</option>
                <option value="repeated">同类组件</option>
                <option value="page">当前页面</option>
              </select>
            </label>
            <label><span>响应式范围</span>
              <select class="breakpoint">
                <option value="all">全部尺寸</option>
                <option value="current">仅当前尺寸</option>
                <option value="desktop">桌面端</option>
                <option value="tablet">平板端</option>
                <option value="mobile">移动端</option>
              </select>
            </label>
          </div>
          <label><span>保持不变</span><textarea class="invariants" placeholder="例如：保留点击行为和移动端布局"></textarea></label>
        </section>
      </div>
      <footer class="panel-footer">
        <button class="finish" type="button">完成并生成</button>
        <div class="output hidden"></div>
      </footer>
    `;

    const toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("role", "status");
    shadow.append(style, stage, pickerHighlight, panel, toast);

    app.ui = {
      stage,
      screenshot: stage.querySelector("img"),
      svg: stage.querySelector("svg"),
      draft: stage.querySelector(".draft"),
      pickerHighlight,
      panel,
      panelHeader: panel.querySelector(".panel-header"),
      status: panel.querySelector(".status"),
      freeze: panel.querySelector(".freeze"),
      pick: panel.querySelector(".pick"),
      stateSelect: panel.querySelector(".state-select"),
      deleteState: panel.querySelector(".delete-state"),
      stateDescription: panel.querySelector(".state-description"),
      toolButtons: [...panel.querySelectorAll("[data-tool]")],
      annotationList: panel.querySelector(".annotation-list"),
      editor: panel.querySelector(".editor"),
      editorTitle: panel.querySelector(".editor-title"),
      operationButtons: [...panel.querySelectorAll(".change-type")],
      expected: panel.querySelector(".expected"),
      scope: panel.querySelector(".scope"),
      breakpoint: panel.querySelector(".breakpoint"),
      priority: panel.querySelector(".priority"),
      invariants: panel.querySelector(".invariants"),
      finish: panel.querySelector(".finish"),
      output: panel.querySelector(".output"),
      toast,
    };

    panel.querySelector(".collapse").addEventListener("click", () => {
      panel.classList.toggle("collapsed");
      requestAnimationFrame(clampCurrentPanel);
    });
    app.ui.panelHeader.addEventListener("pointerdown", startPanelDrag);
    app.ui.panelHeader.addEventListener("pointermove", movePanelDrag);
    app.ui.panelHeader.addEventListener("pointerup", endPanelDrag);
    app.ui.panelHeader.addEventListener("pointercancel", endPanelDrag);
    app.ui.freeze.addEventListener("click", toggleFreeze);
    app.ui.pick.addEventListener("click", startPicking);
    app.ui.deleteState.addEventListener("click", deleteActiveState);
    app.ui.stateSelect.addEventListener("change", (event) => {
      selectState(event.target.value);
      setMode("frozen");
    });
    app.ui.stateDescription.addEventListener("input", (event) => {
      const current = activeState();
      if (!current) return;
      current.description = event.target.value;
      updateStateSelector();
    });
    for (const button of app.ui.toolButtons) {
      button.addEventListener("click", () => chooseTool(button.dataset.tool));
    }
    panel.querySelector(".undo").addEventListener("click", undo);
    panel.querySelector(".delete").addEventListener("click", deleteSelected);
    for (const button of app.ui.operationButtons) {
      const operation = button.dataset.operation;
      button.addEventListener("click", () => toggleOperation(operation));
    }
    for (const field of [
      app.ui.expected,
      app.ui.scope,
      app.ui.breakpoint,
      app.ui.priority,
      app.ui.invariants,
    ]) {
      field.addEventListener("input", updateSelectedIntent);
      field.addEventListener("change", updateSelectedIntent);
    }
    app.ui.finish.addEventListener("click", finishSession);
    stage.addEventListener("pointerdown", stagePointerDown);
    stage.addEventListener("pointermove", stagePointerMove);
    stage.addEventListener("pointerup", stagePointerUp);
    stage.addEventListener("pointercancel", stagePointerUp);
    window.addEventListener("resize", clampCurrentPanel);
    document.addEventListener(
      "keydown",
      (event) => {
        if (
          event.shiftKey &&
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "a"
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
          toggleFreeze();
        }
      },
      true,
    );

    chooseTool("box");
    setMode("live");
    renderAnnotationList();
    send("overlay-ready", {
      url: location.href,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        deviceScaleFactor: window.devicePixelRatio || 1,
      },
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installUi, { once: true });
  } else {
    installUi();
  }
})();

//# sourceURL=symbui-overlay.js
