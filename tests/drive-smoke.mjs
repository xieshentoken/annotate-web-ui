#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import path from "node:path";

const port = Number(process.argv[2] || 9333);
const screenshotDir = process.argv[3] || "/tmp";
const targetUrlPrefix =
  process.argv[4] || "http://127.0.0.1:8765";

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(
  (response) => response.json(),
);
const target = targets.find(
  (item) =>
    item.type === "page" &&
    item.url.startsWith(targetUrlPrefix),
);
if (!target) throw new Error("SymbUI fixture page target was not found.");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let counter = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id || !pending.has(message.id)) return;
  const item = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) item.reject(new Error(message.error.message));
  else item.resolve(message.result || {});
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++counter;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "Runtime evaluation failed.",
    );
  }
  return result.result?.value;
}

async function waitFor(expression, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function screenshot(name) {
  const result = await send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const outputPath = path.join(screenshotDir, name);
  await writeFile(outputPath, Buffer.from(result.data, "base64"));
  return outputPath;
}

await send("Runtime.enable");
await send("Page.enable");

const initial = await evaluate(`(() => {
  const host = document.querySelector("#__symbui-host");
  return {
    host: !!host,
    panel: !!host?.shadowRoot?.querySelector(".panel"),
    status: host?.shadowRoot?.querySelector(".status")?.textContent || "",
    count: document.querySelector("#count")?.textContent || "",
    staticCss: getComputedStyle(document.documentElement)
      .getPropertyValue("--symbui-static-asset")
      .trim(),
    staticJs: document.documentElement.dataset.staticFixture || ""
  };
})()`);
if (
  !initial.host ||
  !initial.panel ||
  initial.status !== "实时" ||
  initial.staticCss !== "loaded" ||
  initial.staticJs !== "loaded"
) {
  throw new Error(`Overlay did not render correctly: ${JSON.stringify(initial)}`);
}

const dragStart = await evaluate(`(() => {
  const root = document.querySelector("#__symbui-host").shadowRoot;
  const panel = root.querySelector(".panel").getBoundingClientRect();
  const header = root.querySelector(".panel-header").getBoundingClientRect();
  return {
    x: header.left + header.width / 2,
    y: header.top + header.height / 2,
    left: panel.left,
    top: panel.top
  };
})()`);
const dragEnd = {
  x: dragStart.x - 180,
  y: dragStart.y + 70,
};
await send("Input.dispatchMouseEvent", {
  type: "mouseMoved",
  x: dragStart.x,
  y: dragStart.y,
});
await send("Input.dispatchMouseEvent", {
  type: "mousePressed",
  button: "left",
  buttons: 1,
  clickCount: 1,
  x: dragStart.x,
  y: dragStart.y,
});
await send("Input.dispatchMouseEvent", {
  type: "mouseMoved",
  button: "left",
  buttons: 1,
  x: dragEnd.x,
  y: dragEnd.y,
});
await send("Input.dispatchMouseEvent", {
  type: "mouseReleased",
  button: "left",
  buttons: 0,
  clickCount: 1,
  x: dragEnd.x,
  y: dragEnd.y,
});
const dragResult = await evaluate(`(() => {
  const panel = document
    .querySelector("#__symbui-host")
    .shadowRoot.querySelector(".panel")
    .getBoundingClientRect();
  return {
    left: panel.left,
    top: panel.top,
    right: panel.right,
    bottom: panel.bottom,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight
  };
})()`);
if (
  dragStart.left - dragResult.left < 120 ||
  dragResult.left < 0 ||
  dragResult.top < 0 ||
  dragResult.right > dragResult.viewportWidth ||
  dragResult.bottom > dragResult.viewportHeight
) {
  throw new Error(
    `Panel drag or viewport clamping failed: ${JSON.stringify({dragStart, dragResult})}`,
  );
}

await evaluate(`document.querySelector("#count-button").click()`);
const count = await evaluate(`document.querySelector("#count").textContent`);
if (count !== "1") {
  throw new Error(`Original page button stopped working; count=${count}`);
}

await evaluate(`document.querySelector("#menu-button").click()`);
const menuOpen = await evaluate(
  `document.querySelector("#menu").classList.contains("open")`,
);
if (!menuOpen) throw new Error("Original page menu did not open.");

const liveScreenshot = await screenshot("symbui-live.png");

await evaluate(
  `document.querySelector("#__symbui-host").shadowRoot.querySelector(".pick").click()`,
);
const targetRect = await evaluate(`(() => {
  const rect = document.querySelector("#upgrade-plan").getBoundingClientRect();
  return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
})()`);
await send("Input.dispatchMouseEvent", {
  type: "mouseMoved",
  x: targetRect.x,
  y: targetRect.y,
});
await send("Input.dispatchMouseEvent", {
  type: "mousePressed",
  button: "left",
  buttons: 1,
  clickCount: 1,
  x: targetRect.x,
  y: targetRect.y,
});
await send("Input.dispatchMouseEvent", {
  type: "mouseReleased",
  button: "left",
  buttons: 0,
  clickCount: 1,
  x: targetRect.x,
  y: targetRect.y,
});

await waitFor(`(() => {
  const root = document.querySelector("#__symbui-host")?.shadowRoot;
  return root?.querySelector(".status")?.textContent === "已冻结" &&
    root?.querySelectorAll(".annotation-item").length === 1;
})()`);

const editorState = await evaluate(`(() => {
  const root = document.querySelector("#__symbui-host").shadowRoot;
  const style = root.querySelector('[data-operation="style"]');
  const content = root.querySelector('[data-operation="content"]');
  style.click();
  content.click();
  const expected = root.querySelector(".expected");
  const placeholder = expected.placeholder;
  return {
    operations: [...root.querySelectorAll(".change-type[aria-pressed=true]")].map(
      (button) => button.dataset.operation,
    ),
    styleTooltip: style.title,
    dynamicHelpPresent: !!root.querySelector(".change-type-help"),
    placeholder,
  };
})()`);

const intentScreenshot = await screenshot("symbui-intent.png");

await evaluate(`(() => {
  const root = document.querySelector("#__symbui-host").shadowRoot;
  const expected = root.querySelector(".expected");
  expected.value = "将升级方案按钮改为高对比度橙色，同时保留打开升级弹窗的交互。";
  expected.dispatchEvent(new Event("input", {bubbles: true}));
  const invariants = root.querySelector(".invariants");
  invariants.value = "保留按钮文字、点击事件和移动端可用性。";
  invariants.dispatchEvent(new Event("input", {bubbles: true}));
})()`);

if (
  editorState.operations.join(",") !== "style,content" ||
  !editorState.styleTooltip.includes("样式") ||
  editorState.dynamicHelpPresent ||
  !editorState.placeholder.includes("样式、内容")
) {
  throw new Error(
    `Multi-select intent controls did not update correctly: ${JSON.stringify(editorState)}`,
  );
}

await evaluate(
  `document.querySelector("#__symbui-host").shadowRoot.querySelector(".pick").click()`,
);
const secondTargetRect = await evaluate(`(() => {
  const rect = document.querySelector("#count-button").getBoundingClientRect();
  return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
})()`);
await send("Input.dispatchMouseEvent", {
  type: "mouseMoved",
  x: secondTargetRect.x,
  y: secondTargetRect.y,
});
await send("Input.dispatchMouseEvent", {
  type: "mousePressed",
  button: "left",
  buttons: 1,
  clickCount: 1,
  x: secondTargetRect.x,
  y: secondTargetRect.y,
});
await send("Input.dispatchMouseEvent", {
  type: "mouseReleased",
  button: "left",
  buttons: 0,
  clickCount: 1,
  x: secondTargetRect.x,
  y: secondTargetRect.y,
});
await waitFor(`(() => {
  const root = document.querySelector("#__symbui-host")?.shadowRoot;
  return root?.querySelector(".state-select")?.options.length === 2 &&
    root?.querySelector(".state-select")?.value === "S2" &&
    root?.querySelectorAll(".annotation-item").length === 1;
})()`);
await evaluate(`(() => {
  window.confirm = () => true;
  document
    .querySelector("#__symbui-host")
    .shadowRoot.querySelector(".delete-state")
    .click();
})()`);
await waitFor(`(() => {
  const root = document.querySelector("#__symbui-host")?.shadowRoot;
  return root?.querySelector(".state-select")?.options.length === 1 &&
    root?.querySelector(".state-select")?.value === "S1" &&
    root?.querySelectorAll(".annotation-item").length === 1 &&
    root?.querySelector(".status")?.textContent === "已冻结";
})()`);

const frozenScreenshot = await screenshot("symbui-frozen.png");

await evaluate(
  `document.querySelector("#__symbui-host").shadowRoot.querySelector(".finish").click()`,
);
await waitFor(
  `document.querySelector("#__symbui-host")?.shadowRoot?.querySelector(".finish")?.textContent === "已生成"`,
  15000,
);

console.log(
  JSON.stringify(
    {
      originalInteraction: "passed",
      overlayVisible: "passed",
      panelDragAndClamp: "passed",
      elementPickAndFreeze: "passed",
      deleteFrozenStateAndAnnotations: "passed",
      nativeCategoryTooltipWithoutDynamicHelp: "passed",
      export: "passed",
      liveScreenshot,
      intentScreenshot,
      frozenScreenshot,
    },
    null,
    2,
  ),
);
socket.close();
