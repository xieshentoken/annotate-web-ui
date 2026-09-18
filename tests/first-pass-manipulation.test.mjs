// First-pass manipulation.
//
// The load-bearing assertion is that `window.__SYMBUI_KEY_FOR__(el)` returns
// exactly the key the inventory assigns to that same element: a first-pass drag
// that recorded a different key would produce an annotation that silently fails
// to align against the next revision.
//
// Everything runs against real Chrome and the fixture page served by this
// skill's own loopback static server. Read it with:
//
//     node --test tests/first-pass-manipulation.test.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CdpClient,
  evaluate,
  findPageTarget,
  waitForVersion,
} from "../annotate-web-ui/scripts/lib/cdp.mjs";
import {
  resolveStaticSite,
  startStaticSite,
} from "../annotate-web-ui/scripts/static-site.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FIXTURE = path.join(HERE, "fixture");
const SKILL = path.join(ROOT, "annotate-web-ui");

const CHROME_CANDIDATES = [
  process.env.SYMBUI_CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

const VIEWPORT = { width: 1280, height: 900 };

async function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next well-known executable.
    }
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      const port = typeof address === "object" ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(client, expression, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(client, expression).catch(() => false);
    if (value) return value;
    await sleep(80);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

// Headless Chrome on the fixture page with `bootstrap` injected before any page
// script runs. Messages the overlay sends over the native binding are
// collected; `request-capture` is answered with a real screenshot, the way
// scripts/start-session.mjs answers it.
async function launch(bootstrap) {
  const chromePath = await findChrome();
  if (!chromePath) return null;

  const site = await resolveStaticSite({
    repoPath: ROOT,
    staticPath: FIXTURE,
  });
  const runtime = await startStaticSite(site);
  const debugPort = await freePort();
  const profileDir = await mkdtemp(
    path.join(os.tmpdir(), "symbui-first-pass-"),
  );

  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      `--remote-debugging-port=${debugPort}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--hide-scrollbars",
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  const messages = [];
  const errors = [];
  let client = null;

  const close = async () => {
    try {
      client?.close();
    } catch {
      // The socket is already gone.
    }
    chrome.kill("SIGTERM");
    await runtime.close().catch(() => {});
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    await waitForVersion(debugPort);
    const target = await findPageTarget(debugPort, "about:blank");
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await client.send("Runtime.addBinding", { name: "__symbuiNative" });
    client.on("Runtime.bindingCalled", (params) => {
      let message;
      try {
        message = JSON.parse(params.payload);
      } catch {
        return;
      }
      messages.push(message);
      if (message.type !== "request-capture") return;
      const stateId = message.payload?.state?.id || "S1";
      (async () => {
        const shot = await client.send("Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: false,
        });
        const reply = {
          type: "capture-ready",
          beforeImage: `before-${stateId}.png`,
          dataUrl: `data:image/png;base64,${shot.data}`,
        };
        await evaluate(
          client,
          `window.__SYMBUI_RECEIVE__ && window.__SYMBUI_RECEIVE__(${JSON.stringify(reply)})`,
        );
      })().catch((error) => errors.push(error));
    });
    await client.send("Page.addScriptToEvaluateOnNewDocument", {
      source:
        typeof bootstrap === "function" ? bootstrap(runtime.url) : bootstrap,
    });
    await client.send("Page.navigate", { url: runtime.url });
    await waitFor(client, "document.readyState === 'complete'");
  } catch (error) {
    await close();
    throw error;
  }

  return { client, messages, errors, url: runtime.url, close };
}

async function withBrowser(bootstrap, run) {
  const session = await launch(bootstrap);
  if (!session) return { skipped: "Chrome is not installed" };
  try {
    await run(session);
    if (session.errors.length > 0) throw session.errors[0];
    return {};
  } finally {
    await session.close();
  }
}

function probeSource() {
  return readFile(path.join(SKILL, "assets/inventory-probe.js"), "utf8");
}

const SHADOW = 'document.querySelector("#__symbui-host").shadowRoot';

// Real input events, so pointer capture behaves the way it does under a hand.
async function drag(client, from, to, steps = 3) {
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: from.x,
    y: from.y,
  });
  await sleep(40);
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    buttons: 1,
    clickCount: 1,
    x: from.x,
    y: from.y,
  });
  for (let index = 1; index <= steps; index += 1) {
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      button: "left",
      buttons: 1,
      x: from.x + ((to.x - from.x) * index) / steps,
      y: from.y + ((to.y - from.y) * index) / steps,
    });
    await sleep(20);
  }
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    buttons: 0,
    clickCount: 1,
    x: to.x,
    y: to.y,
  });
  await sleep(60);
}

test("the probe answers with the inventory's own key for the same element", async (t) => {
  const outcome = await withBrowser(await probeSource(), async ({ client }) => {
    const result = await evaluate(
      client,
      `(() => {
        const inventory = window.__SYMBUI_INVENTORY__({ stateId: "S1", includeAncestry: false });
        const entries = inventory.elements;
        // A button the fixture marks up with its own test id and source anchor.
        const anchored = document.querySelector("#upgrade-plan");
        // A button the fixture only gives an id.
        const identified = document.querySelector("#count-button");
        return {
          anchoredKey: window.__SYMBUI_KEY_FOR__(anchored),
          anchoredInventoryKey: entries.find((element) => element.testId === "upgrade-plan")?.key || null,
          identifiedKey: window.__SYMBUI_KEY_FOR__(identified),
          identifiedInventoryKey: entries.find((element) => element.id === "count-button")?.key || null,
          anchoredAnchor: entries.find((element) => element.testId === "upgrade-plan")?.anchor || null,
        };
      })()`,
    );

    assert.equal(typeof result.anchoredKey, "string");
    assert.ok(result.anchoredKey.length > 0);
    assert.equal(
      result.anchoredKey,
      result.anchoredInventoryKey,
      "__SYMBUI_KEY_FOR__ must return the inventory's key, not a re-derived one",
    );
    assert.equal(
      result.identifiedKey,
      result.identifiedInventoryKey,
      "__SYMBUI_KEY_FOR__ must agree with the inventory for an id-only element",
    );
    // The key really is the anchor-derived one, so the two sides are not both
    // degrading to the same fallback.
    assert.match(result.anchoredKey, /#UpgradeButton\[upgrade-plan\]$/);
    assert.equal(result.anchoredAnchor.file, "tests/fixture/index.html");
  });
  if (outcome.skipped) return t.skip(outcome.skipped);
});

test("the probe falls back to the nearest captured ancestor, then to null", async (t) => {
  const outcome = await withBrowser(await probeSource(), async ({ client }) => {
    const result = await evaluate(
      client,
      `(() => {
        const signature = () => [...document.body.querySelectorAll("*")]
          .map((node) => node.tagName + "|" + node.getAttributeNames().sort().join(",") + "|" + node.childElementCount + "|" + (node.textContent || "").length)
          .join(";");
        const before = signature();
        const inventory = window.__SYMBUI_INVENTORY__({ stateId: "S1", includeAncestry: false });
        const entries = inventory.elements;
        // The closed menu has no box, so the collector skips it; its header is
        // captured and is the nearest captured ancestor.
        const skipped = document.querySelector("#menu");
        const keys = [...document.body.querySelectorAll("*")].map((node) => window.__SYMBUI_KEY_FOR__(node));
        const after = signature();
        return {
          mutated: before !== after,
          queried: keys.length,
          resolvedKeys: keys.filter(Boolean).length,
          menuCaptured: entries.some((element) => element.id === "menu"),
          skippedKey: window.__SYMBUI_KEY_FOR__(skipped),
          parentKey: window.__SYMBUI_KEY_FOR__(skipped.parentElement),
          headerKey: entries.find((element) => element.tag === "header")?.key || null,
          headerIsAncestor: document.querySelector("header").contains(skipped),
          scriptKey: window.__SYMBUI_KEY_FOR__(document.querySelector("script:last-of-type")),
          bodyKey: window.__SYMBUI_KEY_FOR__(document.body),
          nullKey: window.__SYMBUI_KEY_FOR__(null),
        };
      })()`,
    );

    assert.equal(result.mutated, false, "the probe must not modify the page");
    assert.equal(result.menuCaptured, false);
    assert.equal(result.headerIsAncestor, true);
    assert.equal(typeof result.headerKey, "string");
    assert.equal(
      result.skippedKey,
      result.headerKey,
      "a skipped element resolves to its nearest captured ancestor",
    );
    assert.equal(result.parentKey, result.headerKey);
    assert.equal(
      result.scriptKey,
      null,
      "a script at the end of body has no captured ancestor above it, because body itself is never collected",
    );
    assert.equal(
      result.bodyKey,
      null,
      "body itself is never collected, so nothing is left to fall back to",
    );
    assert.equal(result.nullKey, null);
    assert.ok(result.resolvedKeys > 0);
  });
  if (outcome.skipped) return t.skip(outcome.skipped);
});

test("a first-pass move and resize record the probe key, a name, and named groups", async (t) => {
  const [probe, overlay] = await Promise.all([
    probeSource(),
    readFile(path.join(SKILL, "assets/overlay.js"), "utf8"),
  ]);
  const outcome = await withBrowser(
    (url) =>
      [
        `window.__SYMBUI_CONFIG__ = ${JSON.stringify({
          sessionId: "20260101-000000-test",
          createdAt: "2026-01-01T00:00:00.000Z",
          repoPath: ROOT,
          targetUrl: url,
        })};`,
        probe,
        overlay,
      ].join("\n"),
    async ({ client, messages }) => {
      await waitFor(
        client,
        `Boolean(${SHADOW}?.querySelector(".panel"))`,
      );
      await evaluate(client, `(${SHADOW}).querySelector(".freeze").click(), true`);
      await waitFor(
        client,
        `(${SHADOW}).querySelector(".status").textContent === "已冻结"`,
      );

      // The two tools exist and only work on the real page.
      const tools = await evaluate(
        client,
        `[...(${SHADOW}).querySelectorAll("[data-tool]")].map((button) => button.dataset.tool)`,
      );
      assert.deepEqual(tools, [
        "box",
        "point",
        "arrow",
        "redact",
        "move",
        "resize",
      ]);

      // Measure both targets and both inventory keys before any gesture.
      const target = await evaluate(
        client,
        `(() => {
          const inventory = window.__SYMBUI_INVENTORY__({ stateId: "S1", includeAncestry: false });
          const entries = inventory.elements;
          const measured = (selector) => {
            const rect = document.querySelector(selector).getBoundingClientRect();
            return {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              centerX: rect.x + rect.width / 2,
              centerY: rect.y + rect.height / 2,
            };
          };
          const moved = document.querySelector("#upgrade-plan");
          const resized = document.querySelector("#count-button");
          const movedKey = entries.find((element) => element.testId === "upgrade-plan")?.key || null;
          const resizedKey = entries.find((element) => element.id === "count-button")?.key || null;
          const byKey = new Map(entries.map((element) => [element.key, element]));
          return {
            moved: measured("#upgrade-plan"),
            resized: measured("#count-button"),
            movedKey,
            resizedKey,
            // The nearest captured ancestor of the moved button, walked through
            // the inventory's own parentKey links.
            containerKey: byKey.get(movedKey)?.parentKey || null,
            probeKeyForMoved: window.__SYMBUI_KEY_FOR__(moved),
            probeKeyForResized: window.__SYMBUI_KEY_FOR__(resized),
          };
        })()`,
      );
      assert.equal(target.probeKeyForMoved, target.movedKey);
      assert.equal(target.probeKeyForResized, target.resizedKey);
      assert.equal(typeof target.containerKey, "string");

      // Move: drag the real button 40px right and 24px down.
      await evaluate(
        client,
        `(${SHADOW}).querySelector('[data-tool="move"]').click(), true`,
      );
      await drag(
        client,
        { x: target.moved.centerX, y: target.moved.centerY },
        { x: target.moved.centerX + 40, y: target.moved.centerY + 24 },
      );
      await waitFor(
        client,
        `(${SHADOW}).querySelectorAll(".annotation-item").length === 1`,
      );
      const moveNote = await evaluate(
        client,
        `(${SHADOW}).querySelector(".manipulation-note").textContent`,
      );
      assert.match(moveNote, /移动/);

      // The drag is an instruction, not an applied change: the page has not moved.
      const afterMove = await evaluate(
        client,
        `(() => {
          const rect = document.querySelector("#upgrade-plan").getBoundingClientRect();
          return { x: Math.round(rect.x), y: Math.round(rect.y) };
        })()`,
      );
      assert.deepEqual(afterMove, { x: target.moved.x, y: target.moved.y });

      // Resize: grab the bottom-right quadrant of the second button and pull in.
      await evaluate(
        client,
        `(${SHADOW}).querySelector('[data-tool="resize"]').click(), true`,
      );
      await drag(
        client,
        {
          x: target.resized.x + target.resized.width * 0.75,
          y: target.resized.y + target.resized.height * 0.75,
        },
        {
          x: target.resized.x + target.resized.width * 0.75 - 30,
          y: target.resized.y + target.resized.height * 0.75 - 10,
        },
      );
      await waitFor(
        client,
        `(${SHADOW}).querySelectorAll(".annotation-item").length === 2`,
      );

      // A bare delta is a measurement, not an instruction: saving must stop.
      await evaluate(
        client,
        `(${SHADOW}).querySelector(".finish").click(), true`,
      );
      await sleep(250);
      const toast = await evaluate(
        client,
        `(${SHADOW}).querySelector(".toast").textContent`,
      );
      assert.match(toast, /测量值，不是指令/);
      assert.equal(
        messages.filter((message) => message.type === "finish-session").length,
        0,
        "a manipulating annotation without an expected result must not be exported",
      );

      // Name the first annotation, then answer both expected results.
      await evaluate(
        client,
        `(() => {
          const root = ${SHADOW};
          root.querySelectorAll(".annotation-item")[0].click();
          const alias = root.querySelector(".alias");
          alias.value = "升级按钮";
          alias.dispatchEvent(new Event("input", { bubbles: true }));
          const expected = root.querySelector(".expected");
          expected.value = "把升级按钮移到主操作区右侧，保留点击打开弹窗的行为。";
          expected.dispatchEvent(new Event("input", { bubbles: true }));
          root.querySelectorAll(".annotation-item")[1].click();
          const secondExpected = root.querySelector(".expected");
          secondExpected.value = "把计数按钮宽度缩小 30px、高度缩小 10px，文字不换行。";
          secondExpected.dispatchEvent(new Event("input", { bubbles: true }));
        })(), true`,
      );
      const listText = await evaluate(
        client,
        `[...(${SHADOW}).querySelectorAll(".annotation-item")].map((item) => item.textContent)`,
      );
      assert.match(listText.join(" | "), /A1升级按钮/);

      // The pre-existing tools still work, and they still capture a real
      // target: point, box, and redaction used to share the hit test that the
      // manipulation tools now use too.
      await evaluate(
        client,
        `(${SHADOW}).querySelector('[data-tool="point"]').click(), true`,
      );
      const heading = await evaluate(
        client,
        `(() => {
          const rect = document.querySelector("main h1").getBoundingClientRect();
          return { x: rect.x + 12, y: rect.y + 12 };
        })()`,
      );
      await drag(client, heading, heading);
      await waitFor(
        client,
        `(${SHADOW}).querySelectorAll(".annotation-item").length === 3`,
      );
      await evaluate(
        client,
        `(${SHADOW}).querySelector('[data-tool="box"]').click(), true`,
      );
      await drag(client, { x: 150, y: 420 }, { x: 450, y: 560 });
      await waitFor(
        client,
        `(${SHADOW}).querySelectorAll(".annotation-item").length === 4`,
      );
      await evaluate(
        client,
        `(${SHADOW}).querySelector('[data-tool="redact"]').click(), true`,
      );
      await drag(client, { x: 600, y: 620 }, { x: 660, y: 680 });
      await waitFor(
        client,
        `(${SHADOW}).querySelectorAll(".annotation-item").length === 5`,
      );
      // Point and box annotations need an operation and an expected result too.
      await evaluate(
        client,
        `(() => {
          const root = ${SHADOW};
          for (const index of [2, 3]) {
            root.querySelectorAll(".annotation-item")[index].click();
            root.querySelector('[data-operation="layout"]').click();
            const expected = root.querySelector(".expected");
            expected.value = "示例预期 " + (index + 1) + "：这一条由既有工具创建。";
            expected.dispatchEvent(new Event("input", { bubbles: true }));
          }
        })(), true`,
      );

      // Group both annotations, then rename the group.
      const groupState = await evaluate(
        client,
        `(() => {
          const root = ${SHADOW};
          // Only the two manipulation annotations join the group.
          for (const box of [...root.querySelectorAll(".group-member input")].slice(0, 2)) {
            box.checked = true;
            box.dispatchEvent(new Event("change", { bubbles: true }));
          }
          const name = root.querySelector(".group-name");
          name.value = "主操作区";
          name.dispatchEvent(new Event("input", { bubbles: true }));
          root.querySelector(".group-create").click();
          const row = root.querySelector(".group-item");
          const rename = row.querySelector(".group-item-name");
          rename.value = "主操作区（改名）";
          rename.dispatchEvent(new Event("input", { bubbles: true }));
          return {
            meta: row.querySelector(".group-item-meta").textContent,
            groups: root.querySelectorAll(".group-item").length,
          };
        })()`,
      );
      assert.equal(groupState.groups, 1);
      assert.match(groupState.meta, /^G1 · 2 条 · 同一容器$/);

      // Now the payload may go out.
      await evaluate(
        client,
        `(${SHADOW}).querySelector(".finish").click(), true`,
      );
      const deadline = Date.now() + 15000;
      while (
        Date.now() < deadline &&
        !messages.some((message) => message.type === "finish-session")
      ) {
        await sleep(120);
      }
      const finished = messages.find(
        (message) => message.type === "finish-session",
      );
      assert.ok(finished, "the session payload was never sent");
      const session = finished.payload.session;

      assert.equal(session.schemaVersion, "1.3");
      const moved = session.annotations.find(
        (annotation) => annotation.manipulation?.mode === "move",
      );
      const resized = session.annotations.find(
        (annotation) => annotation.manipulation?.mode === "resize",
      );
      assert.ok(moved, "no move annotation in the payload");
      assert.ok(resized, "no resize annotation in the payload");

      assert.equal(session.annotations.length, 5);
      const point = session.annotations.find(
        (annotation) => annotation.kind === "point",
      );
      const box = session.annotations.find(
        (annotation) => annotation.kind === "box",
      );
      const redaction = session.annotations.find(
        (annotation) => annotation.kind === "redact",
      );
      assert.ok(point?.target?.selector, "the point tool must capture a target");
      assert.ok(
        box?.target?.selector,
        "the box tool must capture the element at its centre",
      );
      assert.ok(box.target.rect.width > 0 && box.target.rect.height > 0);
      assert.equal(redaction.target, null);
      assert.equal(redaction.intent, null);

      assert.deepEqual(moved.manipulation.before, {
        x: target.moved.x,
        y: target.moved.y,
        width: target.moved.width,
        height: target.moved.height,
      });
      assert.deepEqual(moved.manipulation.delta, {
        x: 40,
        y: 24,
        width: 0,
        height: 0,
      });
      assert.equal(moved.manipulation.key, target.movedKey);
      assert.equal(moved.alias, "升级按钮");
      assert.equal(
        moved.intent.expected,
        "把升级按钮移到主操作区右侧，保留点击打开弹窗的行为。",
      );

      assert.deepEqual(resized.manipulation.delta, {
        x: 0,
        y: 0,
        width: -30,
        height: -10,
      });
      assert.equal(resized.manipulation.key, target.resizedKey);
      assert.equal(
        resized.manipulation.before.width,
        target.resized.width,
      );
      assert.equal(resized.alias, undefined);

      assert.equal(session.groups.length, 1);
      assert.deepEqual(session.groups[0], {
        id: "G1",
        name: "主操作区（改名）",
        annotationIds: [moved.id, resized.id],
        cohesion: "container",
        containerKey: target.containerKey,
        container: { anchor: null },
      });

      // Deleting the group prunes it from the session state.
      const afterDelete = await evaluate(
        client,
        `(() => {
          const root = ${SHADOW};
          root.querySelector(".group-delete").click();
          return {
            groups: root.querySelectorAll(".group-item").length,
            empty: root.querySelector(".group-list .empty")?.textContent || "",
          };
        })()`,
      );
      assert.equal(afterDelete.groups, 0);
      assert.equal(afterDelete.empty, "尚无分组");
    },
  );
  if (outcome.skipped) return t.skip(outcome.skipped);
});

/* ------------------------------------------------------------------ helpers */

// The overlay plus the probe, wired the way a real session injects them.
async function overlayBootstrap() {
  const [probe, overlay] = await Promise.all([
    probeSource(),
    readFile(path.join(SKILL, "assets/overlay.js"), "utf8"),
  ]);
  return (url) =>
    [
      `window.__SYMBUI_CONFIG__ = ${JSON.stringify({
        sessionId: "20260101-000000-test",
        createdAt: "2026-01-01T00:00:00.000Z",
        repoPath: ROOT,
        targetUrl: url,
      })};`,
      probe,
      overlay,
    ].join("\n");
}

async function freezeOverlay(client) {
  await waitFor(client, `Boolean(${SHADOW}?.querySelector(".panel"))`);
  await evaluate(client, `(${SHADOW}).querySelector(".freeze").click(), true`);
  await waitFor(
    client,
    `(${SHADOW}).querySelector(".status").textContent === "已冻结"`,
  );
}

async function selectTool(client, tool) {
  await evaluate(
    client,
    `(${SHADOW}).querySelector('[data-tool="${tool}"]').click(), true`,
  );
}

// A point inside an element's own padding, so the hit test lands on the
// element itself rather than on one of its children.
function pointInside(selector, index = 0) {
  return `(() => {
    const rect = document.querySelectorAll(${JSON.stringify(selector)})[${index}].getBoundingClientRect();
    return { x: rect.x + 8, y: rect.y + 8 };
  })()`;
}

async function createGroup(client, memberIds, groupName) {
  return evaluate(
    client,
    `(() => {
      const root = ${SHADOW};
      for (const id of ${JSON.stringify(memberIds)}) {
        const box = root.querySelector('.group-member input[value="' + id + '"]');
        if (!box) throw new Error("no group member checkbox for " + id);
        box.checked = true;
        box.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const field = root.querySelector(".group-name");
      field.value = ${JSON.stringify(groupName)};
      field.dispatchEvent(new Event("input", { bubbles: true }));
      root.querySelector(".group-create").click();
      return [...root.querySelectorAll(".group-item-meta")].map((meta) => meta.textContent);
    })()`,
  );
}

// One gesture, dispatched page-side so a cancel can be inserted between the
// presses: real input events cannot express `pointercancel`.
function gesture(script) {
  return `(() => {
    const root = ${SHADOW};
    const stage = root.querySelector(".stage");
    const draft = () => stage.querySelector(".draft").style.display;
    const fire = (type, x, y) => stage.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
      pointerId: 9,
      isPrimary: true,
      pointerType: "touch",
    }));
    ${script}
  })()`;
}

/* ------------------------------------------------------ cohesion coverage */

test("group cohesion follows the captured tree and degrades to mixed rather than guessing a container", async (t) => {
  const bootstrap = await overlayBootstrap();
  const outcome = await withBrowser(bootstrap, async ({ client }) => {
    await freezeOverlay(client);
    await selectTool(client, "point");

    // Two members inside the same captured container, the `.grid` section.
    const cardA = await evaluate(client, pointInside(".grid .card", 0));
    const cardB = await evaluate(client, pointInside(".grid .card", 1));
    await drag(client, cardA, cardA);
    await drag(client, cardB, cardB);
    await waitFor(
      client,
      `(${SHADOW}).querySelectorAll(".annotation-item").length === 2`,
    );
    const together = await createGroup(client, ["A1", "A2"], "同一容器");
    assert.deepEqual(together, ["G1 · 2 条 · 同一容器"]);

    // Two elements in different containers share one test id. The identity
    // alone cannot tell them apart, so the captured rect has to. Resolving by
    // first match made both members land on the header instance and cohesion
    // wrongly claimed a shared container.
    await evaluate(
      client,
      `(() => {
        document.querySelector("header strong").setAttribute("data-testid", "dup-item");
        document.querySelector("#count-button").setAttribute("data-testid", "dup-item");
        return true;
      })()`,
    );
    const header = await evaluate(client, pointInside("header strong"));
    const button = await evaluate(client, pointInside("#count-button"));
    await drag(client, header, header);
    await drag(client, button, button);
    await waitFor(
      client,
      `(${SHADOW}).querySelectorAll(".annotation-item").length === 4`,
    );
    const scattered = await createGroup(client, ["A3", "A4"], "分散跨容器");
    assert.deepEqual(scattered, ["G1 · 2 条 · 同一容器", "G2 · 2 条 · 混合"]);

    // No probe at all: the container question is unanswerable, so it is mixed.
    const withoutProbe = await evaluate(
      client,
      `(() => {
        const root = ${SHADOW};
        const stashed = window.__SYMBUI_INVENTORY__;
        window.__SYMBUI_INVENTORY__ = null;
        try {
          for (const id of ["A1", "A2"]) {
            const box = root.querySelector('.group-member input[value="' + id + '"]');
            box.checked = true;
            box.dispatchEvent(new Event("change", { bubbles: true }));
          }
          const field = root.querySelector(".group-name");
          field.value = "无探针";
          field.dispatchEvent(new Event("input", { bubbles: true }));
          root.querySelector(".group-create").click();
        } finally {
          window.__SYMBUI_INVENTORY__ = stashed;
        }
        return [...root.querySelectorAll(".group-item-meta")].map((meta) => meta.textContent);
      })()`,
    );
    assert.equal(withoutProbe.length, 3);
    assert.match(withoutProbe[2], /^G3 · 2 条 · 混合$/);

    // A member with no key at all: the probe skips this element, so nothing in
    // the captured table can answer for it and the container question is
    // unanswerable.
    await evaluate(
      client,
      `(() => {
        const orphan = document.createElement("div");
        orphan.id = "orphan-target";
        orphan.setAttribute("data-symbui-skip", "");
        orphan.style.cssText =
          "position:fixed;left:600px;top:800px;width:80px;height:40px;background:#123;z-index:1";
        document.body.append(orphan);
        return true;
      })()`,
    );
    const orphan = await evaluate(client, pointInside("#orphan-target"));
    await drag(client, orphan, orphan);
    await waitFor(
      client,
      `(${SHADOW}).querySelectorAll(".annotation-item").length === 5`,
    );
    const memberWithoutKey = await createGroup(client, ["A1", "A5"], "无 key");
    assert.equal(memberWithoutKey.length, 4);
    assert.match(memberWithoutKey[3], /^G4 · 2 条 · 混合$/);
  });
  if (outcome.skipped) return t.skip(outcome.skipped);
});

/* --------------------------------------------- manipulation key coverage */

test("a gesture is refused, and the page left alone, when the element has no key of its own", async (t) => {
  const bootstrap = await overlayBootstrap();
  const outcome = await withBrowser(bootstrap, async ({ client }) => {
    // `data-symbui-skip` keeps the element out of the inventory, so it never
    // earns a key of its own while the ancestor fallback still answers — the
    // exact split the manipulation path has to reject.
    await evaluate(
      client,
      `document.querySelector("#count-button").setAttribute("data-symbui-skip", ""), true`,
    );
    await freezeOverlay(client);

    const before = await evaluate(
      client,
      `(() => {
        const button = document.querySelector("#count-button");
        const inventory = window.__SYMBUI_INVENTORY__({ stateId: "S1", includeAncestry: false });
        const rect = button.getBoundingClientRect();
        return {
          info: window.__SYMBUI_KEY_INFO__(button),
          captured: inventory.elements.some((element) => element.id === "count-button"),
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      })()`,
    );
    assert.equal(before.captured, false, "the fixture element must stay outside the inventory");
    assert.equal(before.info.exact, false, "a skipped element has no key of its own");
    assert.equal(
      typeof before.info.key,
      "string",
      "the ancestor fallback still answers, which is what grouping needs",
    );

    await selectTool(client, "move");
    const start = {
      x: before.rect.x + Math.round(before.rect.width / 2),
      y: before.rect.y + 6,
    };
    await drag(client, start, { x: start.x + 40, y: start.y });
    await sleep(300);

    const after = await evaluate(
      client,
      `(() => {
        const root = ${SHADOW};
        const rect = document.querySelector("#count-button").getBoundingClientRect();
        return {
          annotations: root.querySelectorAll(".annotation-item").length,
          toast: root.querySelector(".toast").textContent,
          tone: root.querySelector(".toast").dataset.tone,
          rect: { x: Math.round(rect.x), y: Math.round(rect.y) },
        };
      })()`,
    );
    assert.equal(after.annotations, 0, "a gesture without its own key must not be recorded");
    assert.match(after.toast, /没有稳定身份/);
    assert.equal(after.tone, "error");
    assert.deepEqual(
      after.rect,
      { x: before.rect.x, y: before.rect.y },
      "a refused gesture leaves the page unmodified",
    );
  });
  if (outcome.skipped) return t.skip(outcome.skipped);
});

/* ------------------------------------------------------ cancellation path */

test("pointercancel cancels a drawing or a manipulation, and only pointerup commits", async (t) => {
  const bootstrap = await overlayBootstrap();
  const outcome = await withBrowser(bootstrap, async ({ client }) => {
    await freezeOverlay(client);

    await selectTool(client, "box");
    const cancelledBox = await evaluate(
      client,
      gesture(`
        fire("pointerdown", 150, 420);
        fire("pointermove", 450, 560);
        const draftDuringGesture = draft();
        fire("pointercancel", 450, 560);
        return { draftDuringGesture, draftAfter: draft(), annotations: root.querySelectorAll(".annotation-item").length };
      `),
    );
    assert.notEqual(cancelledBox.draftDuringGesture, "none");
    assert.equal(cancelledBox.draftAfter, "none");
    assert.equal(cancelledBox.annotations, 0, "a cancelled box must not become an annotation");

    const committedBox = await evaluate(
      client,
      gesture(`
        fire("pointerdown", 150, 420);
        fire("pointermove", 450, 560);
        fire("pointerup", 450, 560);
        return { draftAfter: draft(), annotations: root.querySelectorAll(".annotation-item").length };
      `),
    );
    assert.equal(committedBox.annotations, 1, "pointerup still commits the box");

    await selectTool(client, "move");
    const upgrade = await evaluate(
      client,
      `(() => {
        const rect = document.querySelector("#upgrade-plan").getBoundingClientRect();
        return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
      })()`,
    );
    const cancelledMove = await evaluate(
      client,
      gesture(`
        fire("pointerdown", ${upgrade.x}, ${upgrade.y});
        fire("pointermove", ${upgrade.x + 40}, ${upgrade.y});
        const draftDuringGesture = draft();
        fire("pointercancel", ${upgrade.x + 40}, ${upgrade.y});
        return { draftDuringGesture, draftAfter: draft(), annotations: root.querySelectorAll(".annotation-item").length };
      `),
    );
    assert.notEqual(cancelledMove.draftDuringGesture, "none");
    assert.equal(cancelledMove.draftAfter, "none");
    assert.equal(cancelledMove.annotations, 1, "a cancelled move must not become an annotation");

    const committedMove = await evaluate(
      client,
      gesture(`
        fire("pointerdown", ${upgrade.x}, ${upgrade.y});
        fire("pointermove", ${upgrade.x + 40}, ${upgrade.y});
        fire("pointerup", ${upgrade.x + 40}, ${upgrade.y});
        return { annotations: root.querySelectorAll(".annotation-item").length };
      `),
    );
    assert.equal(committedMove.annotations, 2, "pointerup still records the move");
  });
  if (outcome.skipped) return t.skip(outcome.skipped);
});
