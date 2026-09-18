// Panel pin.
//
// The panel is injected into the page, so every pixel it covers is a pixel the
// user cannot annotate. Pinned, it stays open exactly as it always has.
// Unpinned, it folds to its header as soon as the pointer goes back to the page.
//
// The fold is driven by the browser's own hover state and by pointer movement
// over the page, so this runs against real Chrome and the fixture page served by
// this skill's own loopback static server: a synthesized PointerEvent would not
// move the browser's hover state, and `setPointerCapture` throws on one.
//
//     node --test tests/panel-pin.test.mjs

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
const SHADOW = 'document.querySelector("#__symbui-host").shadowRoot';
// Comfortably clear of the panel, which sits at top:14 right:14.
const PAGE_POINT = { x: 220, y: 420 };
// Long enough for PANEL_COLLAPSE_DELAY_MS (420) to have fired and settled.
const AFTER_DELAY_MS = 700;

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

// Headless Chrome on the fixture page with the overlay injected before any page
// script runs. Messages the overlay sends over the native binding are collected;
// `request-capture` is answered with a real screenshot, the way
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
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "symbui-panel-pin-"));

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

  return { client, errors, close };
}

async function withBrowser(run) {
  const bootstrap = await overlayBootstrap();
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

async function overlayBootstrap() {
  const [probe, overlay] = await Promise.all([
    readFile(path.join(SKILL, "assets/inventory-probe.js"), "utf8"),
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

async function openPanel(client) {
  await waitFor(client, `Boolean(${SHADOW}?.querySelector(".panel"))`);
}

// The panel is `position: fixed` inside the page viewport, so its rect is
// already in the CSS pixels the Input domain expects.
async function rectOf(client, selector) {
  const rect = await evaluate(
    client,
    `(() => {
      const node = (${SHADOW}).querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return {
        x: box.left,
        y: box.top,
        width: box.width,
        height: box.height,
        cx: box.left + box.width / 2,
        cy: box.top + box.height / 2,
      };
    })()`,
  );
  if (!rect) throw new Error(`No element for ${selector} inside the panel`);
  return rect;
}

// The centre, not the corner: a 26px icon button's top-left pixel sits on its
// edge, where the click lands on the header padding instead of the button.
async function centerOf(client, selector) {
  const rect = await rectOf(client, selector);
  return { x: rect.cx, y: rect.cy };
}

async function moveTo(client, point) {
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
  });
  await sleep(40);
}

async function clickAt(client, point) {
  await moveTo(client, point);
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    buttons: 1,
    clickCount: 1,
    x: point.x,
    y: point.y,
  });
  await sleep(30);
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    buttons: 0,
    clickCount: 1,
    x: point.x,
    y: point.y,
  });
  await sleep(60);
}

// A real drag: press, move with the button held, release.
async function dragFrom(client, from, to, steps = 3) {
  await moveTo(client, from);
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
  await releaseAt(client, to);
}

// A press without its release, so a test can look at the frame in which the
// press landed. The fold is decided on pointerdown, not on the click.
async function pressAt(client, point) {
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    buttons: 1,
    clickCount: 1,
    x: point.x,
    y: point.y,
  });
}

async function releaseAt(client, point) {
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    buttons: 0,
    clickCount: 1,
    x: point.x,
    y: point.y,
  });
  await sleep(60);
}

// What a panel field actually holds, read straight from the shadow root.
async function fieldValue(client, selector) {
  return evaluate(
    client,
    `(${SHADOW}).querySelector(${JSON.stringify(selector)}).value`,
  );
}

// Reads the panel the way the user experiences it: how big it is, whether it is
// folded, what the pin says, and which glyph the pin is drawing.
async function panelState(client) {
  return evaluate(
    client,
    `(() => {
      const shadow = ${SHADOW};
      const panel = shadow.querySelector(".panel");
      const pin = shadow.querySelector(".pin-toggle");
      const box = panel.getBoundingClientRect();
      const active = shadow.activeElement;
      return {
        collapsed: panel.classList.contains("collapsed"),
        width: Math.round(box.width),
        height: Math.round(box.height),
        top: Math.round(box.top),
        pinned: pin.getAttribute("aria-pressed"),
        glyph: getComputedStyle(pin, "::before").content,
        focused: active && active.className ? String(active.className) : null,
      };
    })()`,
  );
}

// Whether the panel is the thing under a viewport point. The overlay host is
// `pointer-events: none`, so the host is only hit where the panel itself covers
// the point.
async function panelCoversPoint(client, point) {
  return evaluate(
    client,
    `document.elementFromPoint(${point.x}, ${point.y})?.id === "__symbui-host"`,
  );
}

test("the panel is pinned open by default and stays open over the page", async (t) => {
  const outcome = await withBrowser(async ({ client }) => {
    await openPanel(client);
    const opened = await panelState(client);
    assert.equal(opened.pinned, "true", "pinned is the default");
    assert.equal(opened.glyph, '"钉"', "the pin draws the state in force");
    assert.equal(opened.collapsed, false, "a pinned panel is never folded");
    assert.ok(opened.height > 300, `panel should be fully open: ${opened.height}`);

    await moveTo(client, PAGE_POINT);
    await sleep(AFTER_DELAY_MS);
    const after = await panelState(client);
    assert.equal(after.collapsed, false, "pinned must survive a move over the page");
    assert.equal(after.height, opened.height, "a pinned panel does not shrink");

    // Pinned, a press on the page is only a press on the page: the panel stays
    // open and keeps what it holds. The caret is the browser's business — a
    // press outside a field moves focus whether or not the panel is pinned — so
    // what is asserted here is the panel and its contents, not the caret.
    await clickAt(client, await centerOf(client, ".state-description"));
    await client.send("Input.insertText", { text: "钉扎时写下的说明" });
    await clickAt(client, PAGE_POINT);
    const pressed = await panelState(client);
    assert.equal(pressed.collapsed, false, "a press on the page leaves a pinned panel alone");
    assert.equal(pressed.height, opened.height, "and at the same size");
    assert.equal(
      await fieldValue(client, ".state-description"),
      "钉扎时写下的说明",
      "and holding the same text",
    );
  });
  if (outcome.skipped) return t.skip(outcome.skipped);
});

test("unpinning folds the panel to its header once the pointer is back on the page", async (t) => {
  const outcome = await withBrowser(async ({ client }) => {
    await openPanel(client);
    const pin = await centerOf(client, ".pin-toggle");
    await clickAt(client, pin);

    const unpinned = await panelState(client);
    assert.equal(unpinned.pinned, "false");
    assert.equal(unpinned.glyph, '"浮"');
    assert.equal(
      unpinned.collapsed,
      false,
      "unpinning arms the fold, it does not yank the panel away",
    );
    // …and it does not fold a moment later either, with the pointer still parked
    // on the pin it was just clicked with.
    await sleep(AFTER_DELAY_MS);
    assert.equal(
      (await panelState(client)).collapsed,
      false,
      "the panel stays put while the pointer is still on it",
    );

    // The point the panel covers while open: the same point must be free of it
    // once the pointer is back on the page, or the fold did nothing useful.
    const coveredPoint = { x: pin.x, y: unpinned.top + 320 };
    assert.equal(
      await panelCoversPoint(client, coveredPoint),
      true,
      "the open panel covers the page at that point",
    );

    // Movement over the page folds 420ms after the pointer got there — not
    // "420ms after the hand stops", which would leave the panel sitting on the
    // page for as long as someone keeps moving the mouse.
    const firstMoveAt = Date.now();
    let elapsed = 0;
    for (let index = 0; index < 4; index += 1) {
      await moveTo(client, { x: PAGE_POINT.x + index * 24, y: PAGE_POINT.y });
      elapsed = Date.now() - firstMoveAt;
      if (elapsed > 300) break;
    }
    await sleep(Math.max(0, 520 - elapsed));

    const folded = await panelState(client);
    assert.equal(folded.collapsed, true, "the panel folds when the pointer leaves");
    assert.ok(
      folded.height < unpinned.height - 200,
      `folded panel must be header only: ${folded.height} vs ${unpinned.height}`,
    );
    assert.equal(
      await panelCoversPoint(client, coveredPoint),
      false,
      "the folded panel gives the page back",
    );
  });
  if (outcome.skipped) return t.skip(outcome.skipped);
});

test("a focused field holds the panel open, and a press on the page folds at once", async (t) => {
  const outcome = await withBrowser(async ({ client }) => {
    await openPanel(client);
    await clickAt(client, await centerOf(client, ".pin-toggle"));

    const field = await centerOf(client, ".state-description");
    await clickAt(client, field);
    const typing = await panelState(client);
    assert.equal(
      typing.focused,
      "state-description",
      "the click must land in the field",
    );
    await client.send("Input.insertText", { text: "保留这段说明" });
    assert.equal(await fieldValue(client, ".state-description"), "保留这段说明");

    await moveTo(client, PAGE_POINT);
    await sleep(AFTER_DELAY_MS);
    assert.equal(
      (await panelState(client)).collapsed,
      false,
      "folding mid-sentence would take the caret with it",
    );

    // A press on the page is the user leaving the panel: no delay, so the panel
    // is already folded in the frame the press lands in.
    await pressAt(client, PAGE_POINT);
    await sleep(80);
    const pressed = await panelState(client);
    await releaseAt(client, PAGE_POINT);

    assert.equal(
      pressed.collapsed,
      true,
      "a press on the page folds immediately, without the 420ms grace",
    );
    assert.equal(
      pressed.focused,
      null,
      "leaving the panel drops the caret",
    );
    // The point of dropping the caret is that the field is gone from the screen,
    // not that the text is: what was typed has to survive the fold.
    assert.equal(
      await fieldValue(client, ".state-description"),
      "保留这段说明",
      "folding must not lose what was already typed",
    );
  });
  if (outcome.skipped) return t.skip(outcome.skipped);
});

test("pinning again reopens the folded panel and holds it open", async (t) => {
  const outcome = await withBrowser(async ({ client }) => {
    await openPanel(client);
    const opened = await panelState(client);

    await clickAt(client, await centerOf(client, ".pin-toggle"));
    await moveTo(client, PAGE_POINT);
    await sleep(AFTER_DELAY_MS);
    assert.equal((await panelState(client)).collapsed, true, "folded first");

    // The other explicit way back: the + button, which a folded panel keeps in
    // its header right next to the pin.
    await clickAt(client, await centerOf(client, ".collapse"));
    const reopened = await panelState(client);
    assert.equal(reopened.collapsed, false, "the + button reopens the panel");
    assert.equal(reopened.height, opened.height);
    await moveTo(client, PAGE_POINT);
    await sleep(AFTER_DELAY_MS);
    assert.equal((await panelState(client)).collapsed, true, "and it folds again");

    // The pin lives in the header, which is the one part a folded panel keeps.
    await clickAt(client, await centerOf(client, ".pin-toggle"));
    const repinned = await panelState(client);
    assert.equal(repinned.pinned, "true");
    assert.equal(repinned.collapsed, false, "pinning means fully shown");
    assert.equal(repinned.height, opened.height, "the same open panel comes back");

    await moveTo(client, PAGE_POINT);
    await sleep(AFTER_DELAY_MS);
    assert.equal(
      (await panelState(client)).collapsed,
      false,
      "a pinned panel stays open across the page",
    );
  });
  if (outcome.skipped) return t.skip(outcome.skipped);
});

test("unpinned, drawing an annotation reopens the panel and puts the caret in it", async (t) => {
  const outcome = await withBrowser(async ({ client }) => {
    await openPanel(client);
    await clickAt(client, await centerOf(client, ".pin-toggle"));

    // Freeze the page; the fixture's capture is answered by this harness.
    await clickAt(client, await centerOf(client, ".freeze"));
    await waitFor(
      client,
      `(${SHADOW}).querySelector(".status").textContent === "已冻结"`,
    );

    // Draw a box on the frozen canvas with the default tool. The press folds the
    // panel out of the way, which is the whole point of unpinning.
    const from = { x: 300, y: 300 };
    const to = { x: 430, y: 390 };
    await moveTo(client, from);
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      buttons: 1,
      clickCount: 1,
      x: from.x,
      y: from.y,
    });
    await sleep(60);
    assert.equal(
      (await panelState(client)).collapsed,
      true,
      "the panel gets out of the way while the box is being drawn",
    );
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      buttons: 0,
      clickCount: 1,
      x: to.x,
      y: to.y,
    });
    await sleep(30);
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: to.x, y: to.y });
    await sleep(250);

    // The annotation exists, so the panel has to come back: focus() on a field
    // inside a folded body is a no-op and the caret would land on the page.
    const after = await panelState(client);
    assert.equal(after.collapsed, false, "drawing an annotation reopens the panel");
    assert.equal(
      after.focused,
      "expected",
      "and the caret lands in the explanation field, not on the page",
    );
  });
  if (outcome.skipped) return t.skip(outcome.skipped);
});
