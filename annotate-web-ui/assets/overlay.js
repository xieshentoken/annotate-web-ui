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

  // Dia Browser palette: annotations land on pages we do not own, so an ink
  // outline and the lime wash carry the contrast, and only the manipulation
  // gestures keep a warm accent.
  const WASH_FILL = "#f2fcb3";
  const COLORS = {
    element: "#000000",
    box: "#000000",
    point: "#000000",
    arrow: "#000000",
    redact: "#020204",
    move: "#ffdc5c",
    resize: "#ffdc5c",
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
    groups: [],
    groupCounter: 0,
    groupSelection: [],
    pendingCapture: null,
    pendingTarget: null,
    drawing: null,
    manipulating: null,
    panelDrag: null,
    // Pinned: the panel stays fully open, exactly as it always has. Unpinned:
    // it folds to its header as soon as the pointer goes back to the page, so
    // the panel never covers the element being annotated.
    pinned: true,
    panelCollapseTimer: null,
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

  // The panel's auto-fold. Pinned, none of this fires: the panel stays exactly
  // as open as it has always been. Unpinned, the panel folds down to its header
  // the moment the pointer goes back to the page, so it cannot cover the element
  // being annotated. Expanding is always an explicit click — the + button or the
  // pin — never a hover: a hover rule that also repositions the panel can
  // oscillate against its own layout change.
  const PANEL_COLLAPSE_DELAY_MS = 420;

  function panelFieldHasFocus() {
    const active = app.shadow?.activeElement;
    if (!active || !app.ui.panel?.contains(active)) return false;
    return ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName);
  }

  // The browser's own hit-test state, not a flag we maintain from boundary
  // events: a cached flag drifts whenever an event is swallowed (pointer
  // capture during a panel drag, the panel hidden for a capture, the panel
  // repositioned out from under a stationary pointer), and a drifted flag
  // either disarms the fold for good or folds the panel out from under the hand.
  function panelHoldsPointer() {
    return Boolean(app.ui.panel?.matches(":hover"));
  }

  function panelShouldStayOpen() {
    if (app.pinned) return true;
    if (app.panelDrag) return true;
    if (panelHoldsPointer()) return true;
    // Typing outranks the pointer: folding mid-sentence would take the field and
    // the caret with it.
    return panelFieldHasFocus();
  }

  function cancelPanelCollapse() {
    if (app.panelCollapseTimer == null) return;
    clearTimeout(app.panelCollapseTimer);
    app.panelCollapseTimer = null;
  }

  function expandPanel() {
    cancelPanelCollapse();
    if (!app.ui.panel) return;
    app.ui.panel.classList.remove("collapsed");
    requestAnimationFrame(clampCurrentPanel);
  }

  function collapsePanel() {
    cancelPanelCollapse();
    if (app.pinned || !app.ui.panel) return;
    app.ui.panel.classList.add("collapsed");
    requestAnimationFrame(clampCurrentPanel);
  }

  // Apps that need the user to type have to reopen the panel first: focus() is a
  // no-op on a subtree inside the folded (display: none) body, so the caret would
  // land on the page instead and the user would type into the page. This is a
  // code-driven open on a state change, not the hover rule rejected above.
  function focusPanelField(field) {
    if (!field) return;
    if (app.ui.panel?.classList.contains("collapsed")) expandPanel();
    field.focus();
  }

  function schedulePanelCollapse(delay = PANEL_COLLAPSE_DELAY_MS) {
    // First trigger wins. Re-arming on every page pointermove would turn this
    // into "folds once the mouse stops", and the panel would keep sitting on top
    // of the page for as long as the hand keeps moving.
    if (app.panelCollapseTimer != null) return;
    if (panelShouldStayOpen()) return;
    app.panelCollapseTimer = setTimeout(() => {
      app.panelCollapseTimer = null;
      // Re-check: in the meantime the pointer may be back, or a field focused.
      if (panelShouldStayOpen()) return;
      collapsePanel();
    }, delay);
  }

  // A pointer event counts as "on the page" only when the panel is not in its
  // composed path — inside the shadow root, event.target is the host itself.
  function isPagePointerEvent(event) {
    return Boolean(app.ui.panel && !event.composedPath().includes(app.ui.panel));
  }

  function onPagePointerMove(event) {
    if (app.pinned || !isPagePointerEvent(event)) return;
    schedulePanelCollapse();
  }

  // A press on the page is the user leaving the panel, so it folds at once
  // instead of after the grace period. `collapsePanel` is what enforces pinned,
  // and the caret needs no help: a press elsewhere moves focus out of the field
  // on its own, and the folded body would drop it anyway.
  function onPagePointerDown(event) {
    if (!isPagePointerEvent(event)) return;
    collapsePanel();
  }

  // Page events arrive through the document rather than through a wrapper: the
  // page stays the page, and the overlay never takes a listener the page needs.
  function watchPageForPanelFocusLoss() {
    document.addEventListener("pointermove", onPagePointerMove, true);
    document.addEventListener("pointerdown", onPagePointerDown, true);
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

  /* --------------------------------------------- keys and real DOM geometry */

  // A first-pass gesture has to carry the same key the inventory will use for
  // that element, so the key is always asked of the probe and never rebuilt
  // here. The probe answers from the last collect() pass, so the first query
  // warms it.
  let inventoryWarm = false;

  function inventorySnapshot() {
    const collect = window.__SYMBUI_INVENTORY__;
    if (typeof collect !== "function") return null;
    try {
      const snapshot = collect({
        stateId: app.activeStateId || null,
        includeAncestry: false,
      });
      inventoryWarm = true;
      return snapshot;
    } catch (error) {
      return null;
    }
  }

  // The manipulation's `key` is an identity, not a hint: only a key the
  // inventory assigned to the element *itself* qualifies. The ancestor fallback
  // that grouping relies on would attribute the gesture to a container and the
  // next capture would measure the wrong box, so the probe's `exact` flag
  // decides. A fallback is retried once against a fresh capture before giving up.
  function exactKeyForElement(element) {
    if (!element || typeof window.__SYMBUI_KEY_INFO__ !== "function") return null;
    const read = () => {
      try {
        const info = window.__SYMBUI_KEY_INFO__(element);
        return info && info.exact && info.key ? info.key : null;
      } catch (error) {
        return null;
      }
    };
    if (!inventoryWarm && !inventorySnapshot()) return null;
    const warm = read();
    if (warm) return warm;
    // A timer, a poll, or an HMR swap can replace a node during the freeze and
    // leave the published mapping stale. One fresh capture gives the node a
    // chance to have its own key; if it still does not, the gesture is refused.
    if (!inventorySnapshot()) return null;
    return read();
  }

  // Real geometry, rounded to CSS pixels: the manipulation's `before` must be
  // the captured layout, never a screenshot pixel offset.
  function elementRect(element) {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }

  // The element the pointer is really over. The toolbar steps out of the hit
  // test for the length of the query: flipping the stage's pointer events keeps
  // the DOM (and any focused field) exactly where it was, which hiding the host
  // would not.
  function elementUnderPoint(x, y) {
    const stage = app.ui.stage;
    const previous = stage.style.pointerEvents;
    stage.style.pointerEvents = "none";
    const element = document.elementFromPoint(x, y);
    stage.style.pointerEvents = previous;
    if (!(element instanceof Element)) return null;
    if (element === app.host || app.host.contains(element)) return null;
    return element;
  }

  function targetAt(x, y) {
    return captureElement(elementUnderPoint(x, y));
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
    const gesture =
      annotation.manipulation?.mode === "move"
        ? "移动 "
        : annotation.manipulation?.mode === "resize"
          ? "缩放 "
          : "";
    return `${gesture}${expected || annotation.kind}`;
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
      rx: 11,
      fill: "#ffffff",
      stroke: "#000000",
      "stroke-width": 1,
    });
    const text = svgElement("text", {
      x: clamp(x + 21, 25, window.innerWidth - 27),
      y: clamp(y - 9, 19, window.innerHeight - 9),
      "text-anchor": "middle",
      fill: "#000000",
      "font-size": 12,
      "font-weight": 650,
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
          <path d="M0,0 L0,6 L9,3 z" fill="#000000"></path>
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
            fill: WASH_FILL,
            stroke: "#000000",
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
            "stroke-width": selected ? 3 : 2,
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
                ? COLORS.redact
                : annotation.kind === "move" ||
                    annotation.kind === "resize"
                  ? `${color}${selected ? "38" : "20"}`
                  : `${WASH_FILL}${selected ? "b3" : "66"}`,
            stroke:
              annotation.kind === "redact" ? COLORS.redact : color,
            "stroke-width": selected ? 3 : 2,
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
      renderGroups();
      renderEditor();
      return;
    }

    for (const annotation of annotations) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "annotation-item";
      button.classList.toggle("selected", annotation.id === app.selectedId);
      // The system id stays visible; a name is an addition, never a
      // replacement for it.
      const alias = annotation.alias
        ? `${escapeHtml(annotation.alias)} · `
        : "";
      button.innerHTML = `<strong>${annotation.id}</strong><span>${alias}${escapeHtml(annotationLabel(annotation))}</span>`;
      button.addEventListener("click", () => {
        app.selectedId = annotation.id;
        renderAnnotationList();
        renderAnnotations();
        renderEditor();
      });
      list.append(button);
    }
    renderGroups();
    renderEditor();
  }

  /* ---------------------------------------------------------------- groups */

  function escapeHtml(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character],
    );
  }

  function cohesionLabel(cohesion) {
    if (cohesion === "container") return "同一容器";
    if (cohesion === "component") return "同一组件";
    return "混合";
  }

  function groupMembersOf(annotationIds) {
    return annotationIds
      .map((id) => app.annotations.find((annotation) => annotation.id === id))
      .filter(Boolean);
  }

  // The nearest captured element to the annotation's own rect. One anchor is
  // rendered many times, and the first matching instance is not necessarily the
  // annotated one: two members each inside a different container would both
  // resolve to the first instance and the group would claim a container that
  // does not hold them. `null` means the rect cannot decide, and the caller must
  // degrade to `mixed` rather than name a container.
  function nearestElement(candidates, rect) {
    if (candidates.length === 1) return candidates[0];
    if (!rect) return null;
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    let best = null;
    let bestDistance = Infinity;
    let tied = false;
    for (const candidate of candidates) {
      const candidateRect = candidate.rect;
      if (!candidateRect) return null;
      const distance =
        (candidateRect.x + candidateRect.width / 2 - centerX) ** 2 +
        (candidateRect.y + candidateRect.height / 2 - centerY) ** 2;
      if (distance < bestDistance - 1e-9) {
        bestDistance = distance;
        best = candidate;
        tied = false;
      } else if (Math.abs(distance - bestDistance) <= 1e-9) {
        tied = true;
      }
    }
    return tied ? null : best;
  }

  // The element an annotation points at, expressed as the inventory's key for
  // it. A gesture already recorded that key; otherwise the target evidence is
  // matched against the inventory by the same identity that builds the key and
  // disambiguated with the rect `captureElement` recorded.
  function elementKeyForAnnotation(annotation, elements) {
    if (annotation.manipulation?.key) return annotation.manipulation.key;
    const target = annotation.target;
    if (!target || elements.length === 0) return null;
    const match = (predicate) => {
      const candidates = elements.filter(predicate);
      if (candidates.length === 0) return null;
      return nearestElement(candidates, target.rect)?.key || null;
    };
    if (target.testId) {
      const hit = match((element) => element.testId === target.testId);
      if (hit) return hit;
    }
    if (target.id) {
      const hit = match((element) => element.id === target.id);
      if (hit) return hit;
    }
    if (target.selector) {
      const hit = match((element) => element.selector === target.selector);
      if (hit) return hit;
    }
    if (target.sourceFile) {
      const hit = match(
        (element) =>
          element.anchor &&
          element.anchor.file === target.sourceFile &&
          element.anchor.line === target.sourceLine,
      );
      if (hit) return hit;
    }
    return null;
  }

  function anchorForAnnotation(annotation, element) {
    if (element && element.anchor) return element.anchor;
    const target = annotation.target;
    if (target && target.sourceFile) {
      return {
        file: target.sourceFile,
        line: target.sourceLine || 1,
        column: null,
        component: target.componentName || "",
      };
    }
    return null;
  }

  // "Do these members actually live together?" is a question about the captured
  // tree, not about where the boxes happen to sit on screen.
  function computeCohesion(annotationIds) {
    const members = groupMembersOf(annotationIds);
    if (members.length === 0) return { cohesion: "mixed" };
    const collect = window.__SYMBUI_INVENTORY__;
    if (
      typeof collect !== "function" ||
      typeof window.__SYMBUI_KEY_FOR__ !== "function"
    ) {
      return { cohesion: "mixed" };
    }
    let snapshot;
    try {
      snapshot = collect({
        stateId: app.activeStateId || null,
        includeAncestry: false,
      });
    } catch (error) {
      return { cohesion: "mixed" };
    }
    inventoryWarm = true;
    const elements = Array.isArray(snapshot?.elements) ? snapshot.elements : [];
    const byKey = new Map(elements.map((element) => [element.key, element]));
    const keys = members.map((annotation) =>
      elementKeyForAnnotation(annotation, elements),
    );
    // No key means no honest answer about the shared container; never guess one.
    if (keys.some((key) => !key)) return { cohesion: "mixed" };

    const ancestorChains = keys.map((key) => {
      const chain = [];
      let current = byKey.get(key);
      let hops = 0;
      while (current?.parentKey && hops < 40) {
        chain.push(current.parentKey);
        current = byKey.get(current.parentKey);
        hops += 1;
      }
      return chain;
    });
    const shared = ancestorChains[0].find((candidate) =>
      ancestorChains.every((chain) => chain.includes(candidate)),
    );
    if (shared) {
      return {
        cohesion: "container",
        containerKey: shared,
        container: { anchor: byKey.get(shared)?.anchor || null },
      };
    }

    const anchors = members.map((annotation, index) =>
      anchorForAnnotation(annotation, byKey.get(keys[index])),
    );
    const components = anchors.map((anchor) => anchor?.component || "");
    if (components.every(Boolean) && new Set(components).size === 1) {
      return { cohesion: "component" };
    }
    const files = anchors.map((anchor) => anchor?.file || "");
    if (files.every(Boolean) && new Set(files).size === 1) {
      return { cohesion: "component" };
    }
    return { cohesion: "mixed" };
  }

  function createGroup() {
    const memberIds = app.groupSelection.filter((id) =>
      app.annotations.some((annotation) => annotation.id === id),
    );
    if (memberIds.length === 0) {
      showToast("请先勾选要放进同一组的标注", "error");
      return;
    }
    const name = app.ui.groupName.value.trim().slice(0, 64);
    if (!name) {
      showToast("请先填写分组名称", "error");
      focusPanelField(app.ui.groupName);
      return;
    }
    const group = {
      id: `G${++app.groupCounter}`,
      name,
      annotationIds: memberIds,
      ...computeCohesion(memberIds),
    };
    app.groups.push(group);
    app.groupSelection = [];
    app.ui.groupName.value = "";
    renderGroups();
    showToast(`已建立分组 ${group.name}`, "success");
  }

  function deleteGroup(id) {
    app.groups = app.groups.filter((group) => group.id !== id);
    renderGroups();
    showToast(`已删除分组 ${id}`, "success");
  }

  // A group must never name an annotation that no longer exists: downstream
  // that is a validation error, not a group with fewer members. `cohesion` was
  // decided when the group was created and is never recomputed here.
  function pruneGroups() {
    const existing = new Set(
      app.annotations.map((annotation) => annotation.id),
    );
    const kept = [];
    for (const group of app.groups) {
      const annotationIds = group.annotationIds.filter((id) =>
        existing.has(id),
      );
      if (annotationIds.length === 0) continue;
      kept.push({ ...group, annotationIds });
    }
    app.groups = kept;
    app.groupSelection = app.groupSelection.filter((id) => existing.has(id));
    renderGroups();
  }

  function renderGroups() {
    const members = app.ui.groupMembers;
    members.innerHTML = "";
    const current = activeState();
    const candidates = current
      ? annotationsForState(current.id).filter(
          (annotation) => annotation.kind !== "redact",
        )
      : [];
    // A checkbox only ever represents an annotation this state shows. A
    // selection that survived a freeze switch would be invisible yet still
    // accepted, building a group whose members the user cannot see — and
    // cohesion would then be computed against a DOM that no longer holds them.
    const selectable = new Set(candidates.map((annotation) => annotation.id));
    if (app.groupSelection.some((id) => !selectable.has(id))) {
      app.groupSelection = app.groupSelection.filter((id) =>
        selectable.has(id),
      );
    }
    if (candidates.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "冻结页面并标注后，可把同一批标注建成一组";
      members.append(empty);
    }
    for (const annotation of candidates) {
      const label = document.createElement("label");
      label.className = "group-member";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = annotation.id;
      checkbox.checked = app.groupSelection.includes(annotation.id);
      checkbox.addEventListener("change", () => {
        app.groupSelection = checkbox.checked
          ? [...new Set([...app.groupSelection, annotation.id])]
          : app.groupSelection.filter((id) => id !== annotation.id);
      });
      const text = document.createElement("span");
      text.textContent = annotation.alias
        ? `${annotation.id} ${annotation.alias}`
        : annotation.id;
      label.append(checkbox, text);
      members.append(label);
    }
    renderGroupList();
  }

  function renderGroupList() {
    const list = app.ui.groupList;
    list.innerHTML = "";
    if (app.groups.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "尚无分组";
      list.append(empty);
      return;
    }
    for (const group of app.groups) {
      const row = document.createElement("div");
      row.className = "group-item";
      const name = document.createElement("input");
      name.className = "group-item-name";
      name.value = group.name;
      name.maxLength = 64;
      name.addEventListener("input", () => {
        group.name = name.value;
      });
      const meta = document.createElement("span");
      meta.className = "group-item-meta";
      meta.textContent = `${group.id} · ${group.annotationIds.length} 条 · ${cohesionLabel(group.cohesion)}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger group-delete";
      remove.textContent = "删除";
      remove.addEventListener("click", () => deleteGroup(group.id));
      row.append(name, meta, remove);
      list.append(row);
    }
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
    app.ui.alias.value = annotation.alias || "";
    const manipulation = annotation.manipulation;
    app.ui.manipulationNote.classList.toggle("hidden", !manipulation);
    if (manipulation) {
      const { before, after, delta } = manipulation;
      app.ui.manipulationNote.textContent =
        `${manipulation.mode === "move" ? "移动" : "缩放"}：` +
        `${before.x},${before.y} ${before.width}×${before.height} → ` +
        `${after.x},${after.y} ${after.width}×${after.height}（Δ ${delta.x},${delta.y} ${delta.width}×${delta.height} px）`;
    }
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
      setTimeout(() => focusPanelField(app.ui.expected), 0);
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
    pruneGroups();
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
    pruneGroups();
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
      pruneGroups();
      renderAnnotations();
      renderAnnotationList();
      return;
    }
  }

  function chooseTool(tool) {
    app.tool = tool;
    if (tool !== "move" && tool !== "resize") {
      cancelManipulation();
      app.ui.draft.style.display = "none";
    }
    app.ui.stage.style.cursor =
      tool === "move"
        ? "move"
        : tool === "resize"
          ? "nwse-resize"
          : "crosshair";
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
        tool === "redact" ? "rgba(2,2,4,.78)" : "rgba(242,252,179,.45)",
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
    if (app.tool === "move" || app.tool === "resize") {
      if (!startManipulation(point)) return;
      capturePointer(app.ui.stage, event.pointerId);
      event.preventDefault();
      return;
    }
    app.drawing = { start: point, current: point, tool: app.tool };
    capturePointer(app.ui.stage, event.pointerId);
    drawDraft(point, point, app.tool);
    event.preventDefault();
  }

  function stagePointerMove(event) {
    if (app.manipulating) {
      updateManipulation(viewportPoint(event));
      return;
    }
    if (!app.drawing) {
      previewManipulationTarget(event);
      return;
    }
    app.drawing.current = viewportPoint(event);
    drawDraft(app.drawing.start, app.drawing.current, app.drawing.tool);
  }

  function stagePointerUp(event) {
    if (app.manipulating) {
      updateManipulation(viewportPoint(event));
      finishManipulation();
      return;
    }
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

  /* -------------------------------------------------- move / resize gestures */

  const MIN_MANIPULATION_SIZE = 4;

  // Which corner a resize starts from: the quadrant of the element the pointer
  // went down in. review.html grows the same gesture into 8 explicit handles;
  // the first pass keeps the drag readable instead of adding a handle layer.
  function resizeHandleFor(rect, point) {
    const horizontal = point.x < rect.x + rect.width / 2 ? "w" : "e";
    const vertical = point.y < rect.y + rect.height / 2 ? "n" : "s";
    return vertical + horizontal;
  }

  function capturePointer(element, pointerId) {
    try {
      element.setPointerCapture?.(pointerId);
    } catch (error) {
      // A synthetic pointer has nothing to capture.
    }
  }

  function showManipulationDraft(rect, tool) {
    Object.assign(app.ui.draft.style, {
      display: "block",
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      borderStyle: "dashed",
      borderColor: COLORS[tool] || COLORS.box,
      background: "transparent",
    });
  }

  function startManipulation(point) {
    const element = elementUnderPoint(point.x, point.y);
    if (!element) return false;
    const before = elementRect(element);
    const mode = app.tool === "resize" ? "resize" : "move";
    app.manipulating = {
      mode,
      handle: mode === "resize" ? resizeHandleFor(before, point) : null,
      element,
      before,
      start: point,
      current: { ...before },
    };
    showManipulationDraft(before, app.tool);
    return true;
  }

  function updateManipulation(point) {
    const state = app.manipulating;
    if (!state) return;
    const dx = point.x - state.start.x;
    const dy = point.y - state.start.y;
    const before = state.before;
    let next;
    if (state.mode === "move") {
      next = { ...before, x: before.x + dx, y: before.y + dy };
    } else {
      const handle = state.handle || "se";
      const width = handle.includes("e")
        ? Math.max(MIN_MANIPULATION_SIZE, before.width + dx)
        : handle.includes("w")
          ? Math.max(MIN_MANIPULATION_SIZE, before.width - dx)
          : before.width;
      const height = handle.includes("s")
        ? Math.max(MIN_MANIPULATION_SIZE, before.height + dy)
        : handle.includes("n")
          ? Math.max(MIN_MANIPULATION_SIZE, before.height - dy)
          : before.height;
      next = {
        x: handle.includes("w") ? before.x + dx : before.x,
        y: handle.includes("n") ? before.y + dy : before.y,
        width,
        height,
      };
    }
    state.current = {
      x: Math.round(next.x),
      y: Math.round(next.y),
      width: Math.round(next.width),
      height: Math.round(next.height),
    };
    showManipulationDraft(state.current, app.tool);
  }

  function cancelManipulation() {
    if (!app.manipulating) return;
    app.manipulating = null;
    app.ui.draft.style.display = "none";
  }

  function cancelDrawing() {
    if (!app.drawing) return;
    app.drawing = null;
    app.ui.draft.style.display = "none";
  }

  // `pointercancel` is a cancel, not an up: a touch or trackpad gesture taking
  // over, or a lost pointer capture, must not commit the last coordinates as a
  // real annotation. Only `pointerup` finishes.
  function stagePointerCancel() {
    cancelManipulation();
    cancelDrawing();
  }

  function previewManipulationTarget(event) {
    if (app.mode !== "frozen") return;
    if (app.tool !== "move" && app.tool !== "resize") return;
    if (event.composedPath().includes(app.ui.panel)) return;
    const element = elementUnderPoint(event.clientX, event.clientY);
    if (!element) {
      app.ui.draft.style.display = "none";
      return;
    }
    showManipulationDraft(elementRect(element), app.tool);
  }

  function finishManipulation() {
    const state = app.manipulating;
    if (!state) return;
    app.manipulating = null;
    app.ui.draft.style.display = "none";
    const before = state.before;
    const after = state.current;
    const delta = {
      x: after.x - before.x,
      y: after.y - before.y,
      width: after.width - before.width,
      height: after.height - before.height,
    };
    if (!delta.x && !delta.y && !delta.width && !delta.height) return;
    // Contract rule 2: the key is the manipulation's identity, so an ancestor
    // fallback is never acceptable. Without the element's own key there is no
    // annotation to record — the gesture is dropped and the page stays as it is.
    const key = exactKeyForElement(state.element);
    if (!key) {
      showToast(
        "这个元素在本次页面捕获里没有稳定身份，未记录这次操作；请等页面稳定后重新冻结再试。",
        "error",
      );
      return;
    }
    const annotation = createAnnotation(
      "element",
      after,
      captureElement(state.element),
    );
    if (!annotation) return;
    annotation.manipulation = {
      mode: state.mode,
      key,
      // Real geometry from getBoundingClientRect, never screenshot pixels.
      before,
      after,
      delta,
    };
    annotation.intent = {
      ...annotation.intent,
      operations: ["layout"],
    };
    renderAnnotations();
    renderAnnotationList();
    showToast(
      state.mode === "move"
        ? "已记录移动量，请填写预期结果"
        : "已记录尺寸变化，请填写预期结果",
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
    context.lineWidth = 2;
    context.strokeStyle = color;
    context.fillStyle = color;
    context.font =
      "650 12px ui-monospace, SFMono-Regular, Menlo, monospace";

    if (annotation.kind === "redact") {
      context.fillStyle = COLORS.redact;
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
      context.fillStyle = WASH_FILL;
      context.fill();
      context.stroke();
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
      context.fillStyle =
        annotation.kind === "move" || annotation.kind === "resize"
          ? `${color}24`
          : "#f2fcb366";
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
    context.fillStyle = "#ffffff";
    context.fillRect(labelX, Math.max(2, labelY), 42, 22);
    context.lineWidth = 1;
    context.strokeStyle = "#000000";
    context.strokeRect(labelX + .5, Math.max(2, labelY) + .5, 41, 21);
    context.fillStyle = "#000000";
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
      focusPanelField(app.ui.operationButtons[0]);
      return;
    }
    // A raw delta is a measurement, not an instruction: without an expected
    // result there is nothing to implement and nothing to verify against.
    const bareManipulation = actionable.find(
      (annotation) =>
        annotation.manipulation && !annotation.intent.expected.trim(),
    );
    if (bareManipulation) {
      selectState(bareManipulation.stateId);
      app.selectedId = bareManipulation.id;
      setMode("frozen");
      renderAnnotationList();
      renderAnnotations();
      showToast(
        `${bareManipulation.id} 只记录了${bareManipulation.manipulation.mode === "move" ? "位移量" : "尺寸变化"}：位移是测量值，不是指令。请写清改完之后应该是什么样`,
        "error",
      );
      focusPanelField(app.ui.expected);
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
      focusPanelField(app.ui.expected);
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

      // A name is optional and is never written as an empty string; a
      // manipulation is written only when a gesture actually recorded one.
      const annotations = app.annotations.map((annotation) => {
        const copy = JSON.parse(JSON.stringify(annotation));
        if (typeof copy.alias !== "string" || copy.alias.trim().length === 0) {
          delete copy.alias;
        } else {
          copy.alias = copy.alias.trim();
        }
        if (!copy.manipulation) delete copy.manipulation;
        return copy;
      });
      const groups = app.groups.map((group) =>
        JSON.parse(JSON.stringify(group)),
      );
      const session = {
        // 1.3 is claimed only when the session carries a 1.3 field.
        schemaVersion:
          groups.length > 0 || annotations.some((annotation) => annotation.alias)
            ? "1.3"
            : "1.1",
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
        annotations,
        groups,
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
      // A new freeze is a new page state: the probe's key mapping has to be
      // rebuilt against the DOM as it is now, not as it was at the last drag.
      inventoryWarm = false;
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
        'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    });
    document.documentElement.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    app.host = host;
    app.shadow = shadow;

    const style = document.createElement("style");
    style.textContent = `
      :host {
        --bone: #f8f8f8;
        --paper: #ffffff;
        --linen: #efefef;
        --ink: #000000;
        --carbon: #636363;
        --slate: #888888;
        --silver: #c6c6c6;
        --graphite: #575757;
        --void: #020204;
        --wash: #f2fcb3;
        --saffron: #ffdc5c;
        --radius-card: 12px;
        --radius-cta: 20px;
        --radius-panel: 24px;
        --radius-pill: 9999px;
        --hairline: 1px solid var(--ink);
        --shadow-sm: rgba(0,0,0,.06) 0px 2px 8px 0px, rgba(0,0,0,.04) 0px 0px 2px 0px;
        --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        --ease: 0.2s ease;
      }
      * { box-sizing: border-box; }
      button, input, textarea, select { font: inherit; }
      button, input, textarea, select {
        font-family: var(--font-sans);
        transition:
          color var(--ease),
          background-color var(--ease),
          border-color var(--ease),
          opacity var(--ease);
      }
      button { cursor: pointer; }
      button:focus-visible,
      input:focus-visible,
      textarea:focus-visible,
      select:focus-visible {
        outline: 2px solid var(--ink);
        outline-offset: 2px;
      }
      .stage {
        display: none;
        position: fixed;
        inset: 0;
        width: 100vw;
        height: 100vh;
        overflow: hidden;
        pointer-events: auto;
        cursor: crosshair;
        background: var(--void);
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
        border: 2px dashed var(--ink);
        background: rgba(242,252,179,.45);
        pointer-events: none;
      }
      .picker-highlight {
        display: none;
        position: fixed;
        border: 2px solid var(--ink);
        background: rgba(242,252,179,.45);
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
        color: var(--ink);
        font-family: var(--font-sans);
        font-size: 16px;
        line-height: 1.5;
        background: var(--bone);
        border: var(--hairline);
        border-radius: var(--radius-panel);
        box-shadow: var(--shadow-sm);
        overflow: hidden;
        pointer-events: auto;
      }
      .panel::before {
        content: "";
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 3px;
        background: linear-gradient(270deg, #FD02F5, #FA3D1D 15.94%, #FFB005 42.76%, #E1E1FE 72.48%, #0358F7 100.02%, #340B05 150.75%);
        pointer-events: none;
      }
      .panel.collapsed { width: 296px; }
      .panel.collapsed .panel-body,
      .panel.collapsed .panel-footer { display: none; }
      /* Folded, the header is a status rail: the wordmark and the eyebrow are the
         first things to go. Keeping them wraps the title into a second row and
         nearly doubles the height of the one part of the panel that is meant to
         be out of the way. The status pill stays — that is the useful readout. */
      .panel.collapsed .title strong,
      .panel.collapsed .title .eyebrow { display: none; }
      .panel-header {
        min-height: 58px;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 15px 16px 13px;
        border-bottom: var(--hairline);
        cursor: grab;
        touch-action: none;
        user-select: none;
      }
      .panel.dragging .panel-header { cursor: grabbing; }
      .brand {
        flex: 0 0 auto;
        display: grid;
        place-items: center;
        width: 30px;
        height: 30px;
        border-radius: var(--radius-card);
        color: var(--wash);
        background: var(--ink);
        font-family: var(--font-mono);
        font-size: 14px;
        line-height: 1.25;
        letter-spacing: .02em;
        text-transform: uppercase;
      }
      .title { flex: 1; min-width: 0; }
      .title-top {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
      }
      .eyebrow {
        color: var(--carbon);
        font-family: var(--font-mono);
        font-size: 13px;
        line-height: 1.3;
        letter-spacing: 1.3px;
        text-transform: uppercase;
      }
      .title strong {
        display: block;
        margin-top: 2px;
        color: var(--ink);
        font-size: 24px;
        font-weight: 650;
        letter-spacing: -.72px;
        line-height: 1.25;
      }
      .status {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 3px 10px;
        border: var(--hairline);
        border-radius: var(--radius-pill);
        color: var(--ink);
        background: var(--linen);
        font-family: var(--font-sans);
        font-size: 12px;
        line-height: 1.35;
        white-space: nowrap;
        transition: color var(--ease), background-color var(--ease), border-color var(--ease);
      }
      .status::before {
        content: "";
        flex: 0 0 auto;
        width: 6px;
        height: 6px;
        border-radius: var(--radius-pill);
        background: currentColor;
      }
      .status[data-mode="live"] { background: var(--linen); }
      .status[data-mode="frozen"] { background: var(--wash); }
      .status[data-mode="picking"],
      .status[data-mode="capturing"] { background: var(--saffron); }
      .drag-hint {
        flex: 0 0 auto;
        color: var(--silver);
        font-size: 13px;
        line-height: 1.25;
        letter-spacing: -3px;
        pointer-events: none;
      }
      .icon-button {
        flex: 0 0 auto;
        display: grid;
        place-items: center;
        width: 28px;
        height: 28px;
        padding: 0;
        border: var(--hairline);
        border-radius: var(--radius-pill);
        color: var(--ink);
        background: var(--paper);
        font-size: 13px;
        line-height: 1.25;
      }
      .icon-button:hover { background: var(--linen); }
      .panel.collapsed .collapse { font-size: 0; }
      .panel.collapsed .collapse::before {
        content: "+";
        color: var(--ink);
        font-size: 14px;
        line-height: 1.25;
      }
      .panel-body {
        overflow: auto;
        scrollbar-color: var(--slate) transparent;
      }
      section { padding: 16px; border-bottom: var(--hairline); }
      .row { display: flex; gap: 8px; align-items: center; }
      .row + .row { margin-top: 8px; }
      .state-row .state-select { flex: 1; min-width: 0; }
      .delete-state { flex: 0 0 auto; white-space: nowrap; }
      .primary, .secondary, .danger, .tool {
        min-height: 36px;
        border: var(--hairline);
        border-radius: var(--radius-pill);
        padding: 7px 14px;
        color: var(--ink);
        background: transparent;
        font-size: 16px;
        line-height: 1.25;
      }
      .primary {
        flex: 1;
        border-radius: var(--radius-cta);
        color: var(--paper);
        background: var(--ink);
        font-weight: 650;
      }
      .primary:hover { background: var(--graphite); }
      .secondary { flex: 1; background: var(--linen); }
      .secondary:hover { background: var(--paper); }
      .secondary.active, .tool.active {
        color: var(--ink);
        background: var(--saffron);
        border-color: var(--ink);
      }
      button:disabled { cursor: not-allowed; opacity: .45; }
      .tool-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 8px;
      }
      .tool {
        min-width: 0;
        padding: 8px 6px;
        background: var(--linen);
        white-space: nowrap;
      }
      .tool:hover { background: var(--paper); }
      .tool.active:hover { background: var(--saffron); }
      .tool-hint {
        margin-top: 10px;
        color: var(--carbon);
        font-size: 13px;
        line-height: 1.5;
      }
      .manipulation-note {
        margin-top: 12px;
        padding: 10px 12px;
        border: var(--hairline);
        border-radius: var(--radius-card);
        color: var(--ink);
        background: var(--wash);
        font-size: 13px;
        line-height: 1.5;
      }
      .manipulation-note.hidden { display: none; }
      .group-hint,
      .section-title > span + span {
        color: var(--slate);
        font-family: var(--font-sans);
        font-size: 12px;
        letter-spacing: 0;
        text-transform: none;
      }
      .group-name { flex: 1; min-width: 0; }
      .group-members { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; margin-top: 10px; max-height: 132px; overflow: auto; }
      .group-member {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0;
        color: var(--ink);
        font-size: 16px;
        line-height: 1.5;
      }
      .group-member input { width: 15px; height: 15px; accent-color: var(--ink); }
      .group-member span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .group-list { display: grid; gap: 8px; margin-top: 10px; }
      .group-item {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto auto;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        border: var(--hairline);
        border-radius: var(--radius-card);
        background: var(--paper);
      }
      .group-item-name { min-width: 0; height: 32px; font-size: 14px; }
      .group-item-meta { color: var(--slate); font-size: 12px; line-height: 1.4; white-space: nowrap; }
      .group-delete { min-height: 28px; padding: 3px 12px; font-size: 13px; }
      .section-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 12px;
        color: var(--carbon);
        font-family: var(--font-mono);
        font-size: 13px;
        font-weight: 400;
        letter-spacing: 1.3px;
        line-height: 1.3;
        text-transform: uppercase;
      }
      .section-title > button {
        flex: 0 0 auto;
        min-height: 28px;
        padding: 3px 12px;
        font-family: var(--font-sans);
        font-size: 13px;
        letter-spacing: 0;
        text-transform: none;
      }
      select, input, textarea {
        width: 100%;
        border: var(--hairline);
        border-radius: var(--radius-card);
        color: var(--ink);
        background: var(--paper);
        outline: none;
        line-height: 1.5;
      }
      select, input { height: 36px; padding: 0 10px; }
      textarea { min-height: 76px; padding: 9px 10px; resize: vertical; }
      ::placeholder { color: var(--slate); opacity: 1; }
      option { line-height: 1.5; }
      select:focus, input:focus, textarea:focus {
        border-color: var(--ink);
        box-shadow: 0 0 0 3px rgba(242,252,179,.9);
      }
      label { display: block; margin-top: 12px; color: var(--carbon); font-size: 16px; line-height: 1.5; }
      label > span { display: block; margin-bottom: 6px; }
      .two-column { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
      .intent-heading {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 10px;
        margin-top: 12px;
        color: var(--carbon);
        font-size: 14px;
        line-height: 1.4;
      }
      .intent-heading strong { color: var(--ink); font-size: 16px; font-weight: 650; }
      .intent-heading-note { color: var(--slate); font-size: 12px; }
      .change-type-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 8px;
        margin-top: 8px;
      }
      .change-type {
        min-width: 0;
        min-height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        padding: 6px 4px;
        border: var(--hairline);
        border-radius: var(--radius-pill);
        color: var(--ink);
        background: var(--linen);
        font-size: 13px;
        line-height: 1.25;
        white-space: nowrap;
      }
      .change-type:hover { background: var(--paper); }
      .change-type.selected {
        border-color: var(--ink);
        color: var(--ink);
        background: var(--wash);
      }
      .change-type.selected:hover { background: var(--wash); }
      .change-type-check {
        width: 11px;
        color: var(--ink);
        font-size: 13px;
        line-height: 1.25;
        opacity: 0;
      }
      .change-type.selected .change-type-check { opacity: 1; }
      .priority-field { width: min(156px, 100%); }
      .annotation-list { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
      .annotation-item {
        width: 100%;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        border: var(--hairline);
        border-radius: var(--radius-card);
        color: var(--ink);
        background: var(--paper);
        text-align: left;
        font-size: 16px;
        line-height: 1.4;
      }
      .annotation-item:hover { background: var(--linen); }
      .annotation-item.selected,
      .annotation-item.selected:hover { background: var(--wash); }
      .annotation-item strong {
        flex: 0 0 auto;
        color: var(--ink);
        font-family: var(--font-mono);
        font-size: 13px;
        letter-spacing: .6px;
      }
      .annotation-item span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 16px; }
      .empty {
        padding: 14px 12px;
        border: 1px dashed var(--silver);
        border-radius: var(--radius-card);
        color: var(--slate);
        text-align: center;
        font-size: 16px;
        line-height: 1.5;
      }
      .editor.hidden, .output.hidden { display: none; }
      .danger { color: var(--ink); border-color: var(--ink); background: transparent; }
      .danger:hover { background: var(--linen); }
      .panel-footer {
        padding: 16px;
        background: var(--bone);
      }
      .finish {
        width: 100%;
        min-height: 44px;
        border: var(--hairline);
        border-radius: var(--radius-cta);
        color: var(--paper);
        background: var(--ink);
        font-size: 16px;
        font-weight: 650;
        line-height: 1.25;
      }
      .finish:hover { background: var(--graphite); }
      .finish:disabled {
        color: var(--slate);
        background: var(--linen);
        border-color: var(--silver);
        opacity: 1;
      }
      .output {
        margin-top: 12px;
        padding: 10px 12px;
        border: var(--hairline);
        border-radius: var(--radius-card);
        color: var(--ink);
        background: var(--paper);
        font-family: var(--font-mono);
        font-size: 12px;
        line-height: 1.5;
        word-break: break-all;
      }
      .toast {
        position: fixed;
        left: 50%;
        bottom: 24px;
        max-width: 520px;
        transform: translate(-50%, 0);
        padding: 12px 16px;
        border: var(--hairline);
        border-radius: var(--radius-card);
        color: var(--ink);
        background: var(--paper);
        box-shadow: var(--shadow-sm);
        font-size: 16px;
        line-height: 1.5;
        opacity: 0;
        transition:
          color var(--ease),
          background-color var(--ease),
          border-color var(--ease),
          opacity var(--ease);
        pointer-events: none;
      }
      .toast.visible { opacity: 1; }
      .toast[data-tone="error"] { color: var(--paper); background: var(--void); border-color: var(--void); }
      .toast[data-tone="success"] { color: var(--ink); background: var(--wash); border-color: var(--ink); }

      /* Density toggle: pressed (aria-pressed="true") means compact, the default.
         The glyph shows the density in force, the surface shows the pressed state. */
      .density-toggle { font-size: 0; }
      .density-toggle::before {
        content: "舒";
        color: var(--ink);
        font-size: 12px;
        line-height: 1.25;
      }
      .density-toggle[aria-pressed="true"] {
        border-color: var(--ink);
        background: var(--saffron);
      }
      .density-toggle[aria-pressed="true"]::before { content: "密"; }

      /* Pin toggle: pressed (aria-pressed="true") means the panel is pinned open,
         which is the default. Unpinned, the panel folds to this header as soon
         as the pointer goes back to the page. The glyph names the state in force
         — 钉 pinned, 浮 floating — the way the density toggle names its density. */
      .pin-toggle { font-size: 0; }
      .pin-toggle::before {
        content: "浮";
        color: var(--ink);
        font-size: 12px;
        line-height: 1.25;
      }
      .pin-toggle[aria-pressed="true"] {
        border-color: var(--ink);
        background: var(--saffron);
      }
      .pin-toggle[aria-pressed="true"]::before { content: "钉"; }

      /* Compact density — the default. It only tightens spacing and type; every
         control and section stays reachable. Expanded is the comfortable set above. */
      .panel.compact .panel-header {
        min-height: 48px;
        gap: 10px;
        padding: 10px 12px 9px;
      }
      .panel.compact .brand { width: 26px; height: 26px; font-size: 13px; }
      .panel.compact .title strong {
        font-size: 20px;
        letter-spacing: -.6px;
        line-height: 1.3;
      }
      .panel.compact .title .eyebrow { font-size: 13px; }
      .panel.compact .status { padding: 2px 8px; }
      .panel.compact .drag-hint { font-size: 12px; }
      .panel.compact .icon-button { width: 26px; height: 26px; }
      .panel.compact section { padding: 10px 12px; }
      .panel.compact .section-title { margin-bottom: 8px; }
      .panel.compact .row { gap: 5px; }
      .panel.compact .row + .row { margin-top: 5px; }
      .panel.compact .primary,
      .panel.compact .secondary,
      .panel.compact .danger,
      .panel.compact .tool {
        min-height: 30px;
        padding: 4px 10px;
        font-size: 14px;
        line-height: 1.35;
      }
      .panel.compact .tool { padding: 4px 4px; }
      .panel.compact .tool-grid { gap: 5px; }
      .panel.compact .tool-hint {
        margin-top: 5px;
        font-size: 12px;
        line-height: 1.45;
      }
      .panel.compact label {
        margin-top: 8px;
        font-size: 14px;
        line-height: 1.4;
      }
      .panel.compact label > span { margin-bottom: 4px; }
      .panel.compact select,
      .panel.compact input { height: 30px; padding: 0 8px; font-size: 14px; }
      .panel.compact textarea {
        min-height: 60px;
        padding: 5px 8px;
        font-size: 14px;
      }
      .panel.compact .empty {
        padding: 8px;
        font-size: 13px;
        line-height: 1.45;
      }
      .panel.compact .annotation-list { gap: 5px; }
      .panel.compact .annotation-item {
        gap: 5px;
        padding: 5px 8px;
        font-size: 14px;
        line-height: 1.4;
      }
      .panel.compact .annotation-item span { font-size: 14px; }
      .panel.compact .group-members {
        gap: 4px;
        margin-top: 5px;
        max-height: 96px;
      }
      .panel.compact .group-list { gap: 5px; margin-top: 5px; }
      .panel.compact .group-item { gap: 5px; padding: 5px 8px; }
      .panel.compact .group-item-name { height: 28px; font-size: 13px; }
      .panel.compact .group-delete { min-height: 26px; padding: 2px 8px; font-size: 12px; }
      .panel.compact .group-member { font-size: 14px; line-height: 1.4; }
      .panel.compact .group-member input { width: 13px; height: 13px; }
      .panel.compact .group-members .empty { padding: 5px; font-size: 12px; }
      .panel.compact .section-title > button {
        min-height: 26px;
        padding: 2px 10px;
        font-size: 12px;
      }
      .panel.compact .intent-heading { margin-top: 8px; }
      .panel.compact .intent-heading strong { font-size: 14px; }
      .panel.compact .intent-heading-note { font-size: 11px; }
      .panel.compact .change-type-grid { gap: 5px; margin-top: 5px; }
      .panel.compact .change-type {
        min-height: 26px;
        padding: 4px 3px;
        font-size: 12px;
        line-height: 1.3;
      }
      .panel.compact .change-type-check { width: 10px; font-size: 12px; }
      .panel.compact .manipulation-note {
        margin-top: 8px;
        padding: 5px 8px;
        font-size: 12px;
        line-height: 1.45;
      }
      .panel.compact .two-column { gap: 5px; }
      .panel.compact .panel-footer { padding: 10px 12px; }
      .panel.compact .finish { min-height: 36px; font-size: 14px; }
      .panel.compact .output {
        margin-top: 8px;
        padding: 5px 8px;
        font-size: 11px;
        line-height: 1.45;
      }
      @media (max-width: 700px) {
        .panel { top: 8px; right: 8px; width: min(356px, calc(100vw - 16px)); max-height: calc(100vh - 16px); }
        .panel.collapsed { width: min(296px, calc(100vw - 16px)); }
      }
      @media (prefers-reduced-motion: reduce) {
        button, input, textarea, select, .status, .toast { transition: none; }
      }
    `;

    const stage = document.createElement("div");
    stage.className = "stage";
    stage.innerHTML = `<img alt=""><svg></svg><div class="draft"></div>`;

    const pickerHighlight = document.createElement("div");
    pickerHighlight.className = "picker-highlight";

    const panel = document.createElement("aside");
    panel.className = "panel compact";
    panel.innerHTML = `
      <header class="panel-header" title="按住顶部空白处拖动浮窗">
        <div class="brand">S</div>
        <div class="title">
          <div class="title-top">
            <span class="eyebrow">SYMBUI</span>
            <span class="status" data-mode="live">实时</span>
          </div>
          <strong>SymbUI</strong>
        </div>
        <span class="drag-hint" aria-hidden="true">⠿</span>
        <button class="icon-button pin-toggle" type="button" title="钉扎：固定完整显示；取消钉扎后，鼠标一回到页面就自动收起" aria-pressed="true">钉扎</button>
        <button class="icon-button density-toggle" type="button" title="切换密度：紧凑／展开" aria-pressed="true">密度</button>
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
            <button class="tool" type="button" data-tool="move" title="拖动真实页面元素，记录位移量（CSS px）">移动</button>
            <button class="tool" type="button" data-tool="resize" title="从元素某个角拖动，记录尺寸变化（CSS px）">缩放</button>
            <button class="tool undo" type="button" title="删除最后一条标注">撤销</button>
          </div>
          <div class="tool-hint">移动／缩放作用于真实页面元素：before 取自 getBoundingClientRect()，位移量单位是 CSS px。</div>
        </section>
        <section>
          <div class="section-title"><span>标注列表</span><button class="danger delete" type="button">删除所选</button></div>
          <div class="annotation-list"></div>
        </section>
        <section>
          <div class="section-title"><span>命名分组</span><span class="group-hint">勾选要一起改的标注</span></div>
          <div class="row">
            <input class="group-name" maxlength="64" placeholder="分组名称，例如：主操作区">
            <button class="secondary group-create" type="button">建立分组</button>
          </div>
          <div class="group-members"></div>
          <div class="group-list"></div>
        </section>
        <section class="editor hidden">
          <div class="section-title"><span class="editor-title">修改说明</span></div>
          <label><span>名称（可选，给这条标注起个名字）</span><input class="alias" maxlength="64" placeholder="例如：UpgradeButton"></label>
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
          <div class="manipulation-note hidden"></div>
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
      pinToggle: panel.querySelector(".pin-toggle"),
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
      alias: panel.querySelector(".alias"),
      manipulationNote: panel.querySelector(".manipulation-note"),
      groupName: panel.querySelector(".group-name"),
      groupCreate: panel.querySelector(".group-create"),
      groupMembers: panel.querySelector(".group-members"),
      groupList: panel.querySelector(".group-list"),
      finish: panel.querySelector(".finish"),
      output: panel.querySelector(".output"),
      toast,
    };

    panel.querySelector(".collapse").addEventListener("click", () => {
      cancelPanelCollapse();
      panel.classList.toggle("collapsed");
      requestAnimationFrame(clampCurrentPanel);
    });

    const densityToggle = panel.querySelector(".density-toggle");
    densityToggle.addEventListener("click", () => {
      // Compact is the default: the toggle only swaps density, it never hides a
      // control, and it stays independent from the .collapsed panel state.
      const compact = panel.classList.toggle("compact");
      densityToggle.setAttribute("aria-pressed", String(compact));
      requestAnimationFrame(clampCurrentPanel);
    });

    app.ui.pinToggle.addEventListener("click", () => {
      app.pinned = !app.pinned;
      app.ui.pinToggle.setAttribute("aria-pressed", String(app.pinned));
      // Pinning means "fully shown", so it opens the panel. Unpinning only arms
      // the fold: the panel stays where it is until the pointer goes back to the
      // page, so the switch never yanks it out from under the click.
      if (app.pinned) expandPanel();
      else schedulePanelCollapse();
    });
    // No hover listener: the fold reads :hover directly (panelHoldsPointer), so
    // there is no cached pointer state to keep in sync, and a hover never opens
    // the panel — see the note above PANEL_COLLAPSE_DELAY_MS.
    watchPageForPanelFocusLoss();
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
    // A name is a display affordance: it never replaces the id or the target
    // evidence, and an empty box means the annotation simply has no name.
    app.ui.alias.addEventListener("input", () => {
      const annotation = selectedAnnotation();
      if (!annotation) return;
      const value = app.ui.alias.value.trim().slice(0, 64);
      if (value) annotation.alias = value;
      else delete annotation.alias;
    });
    app.ui.alias.addEventListener("change", renderAnnotationList);
    app.ui.groupCreate.addEventListener("click", createGroup);
    app.ui.groupName.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      createGroup();
    });
    app.ui.finish.addEventListener("click", finishSession);
    stage.addEventListener("pointerdown", stagePointerDown);
    stage.addEventListener("pointermove", stagePointerMove);
    stage.addEventListener("pointerup", stagePointerUp);
    stage.addEventListener("pointercancel", stagePointerCancel);
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
