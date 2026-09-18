// Floating panel.
//
// Three things are being asserted, in order of how much they can hide:
//
//   1. The relay only answers with the session token, and it never sends a CORS
//      header, so a web page that finds the port cannot use it.
//   2. The panel page is a real second view of one session: it renders the
//      page's state, and clicking and typing in it drives the page — through the
//      same functions the in-page panel calls.
//   3. The native macOS window really shows that page: a floating NSPanel whose
//      WKWebView loads the loopback URL and runs its JavaScript.
//
// Everything runs against real Chrome and the fixture page this skill serves.
//
//     node --test tests/floating-panel.test.mjs

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
import { startPanelHost } from "../annotate-web-ui/scripts/panel-host.mjs";
import {
  resolveStaticSite,
  startStaticSite,
} from "../annotate-web-ui/scripts/static-site.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FIXTURE = path.join(HERE, "fixture");
const SKILL = path.join(ROOT, "annotate-web-ui");
const BUILD_PANEL = path.join(SKILL, "scripts/native/build-panel.mjs");

const CHROME_CANDIDATES = [
  process.env.SYMBUI_CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

const VIEWPORT = { width: 1280, height: 900 };
const BOX_DRAG = { from: { x: 320, y: 260 }, to: { x: 470, y: 360 } };

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

// The third argument is a message, not a timeout: passing a string where a
// millisecond count was expected would make the deadline NaN, which fails the
// wait on its first tick even while the condition is already true.
async function waitFor(client, expression, message = "") {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await evaluate(client, expression).catch(() => false);
    if (value) return value;
    await sleep(80);
  }
  throw new Error(
    `Timed out waiting for: ${expression}${message ? ` — ${message}` : ""}`,
  );
}

// Headless Chrome on the fixture page with the overlay injected before any page
// script runs. `onMessage` sees every message the overlay sends over the native
// binding, which is how this harness plays the part of start-session.mjs — it
// answers captures and relays the panel toasts the way the real one does.
async function launch({ onMessage = null } = {}) {
  const chromePath = await findChrome();
  if (!chromePath) return null;

  const [probe, overlay] = await Promise.all([
    readFile(path.join(SKILL, "assets/inventory-probe.js"), "utf8"),
    readFile(path.join(SKILL, "assets/overlay.js"), "utf8"),
  ]);
  const site = await resolveStaticSite({ repoPath: ROOT, staticPath: FIXTURE });
  const runtime = await startStaticSite(site);
  const debugPort = await freePort();
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "symbui-floating-"));

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
      // The panel is a second tab: without these, Chrome may background it and
      // its stream never opens, which is an artefact of the harness rather than
      // of the panel (the real window is always frontmost).
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  const errors = [];
  let client = null;
  let pageTargetId = null;

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
    pageTargetId = target.id;
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
      if (typeof onMessage === "function") onMessage(message);
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
      source: [
        `window.__SYMBUI_CONFIG__ = ${JSON.stringify({
          sessionId: "20260101-000000-test",
          createdAt: "2026-01-01T00:00:00.000Z",
          repoPath: ROOT,
          targetUrl: runtime.url,
        })};`,
        probe,
        overlay,
      ].join("\n"),
    });
    await client.send("Page.navigate", { url: runtime.url });
    await waitFor(client, "document.readyState === 'complete'");
    await waitFor(client, "Boolean(window.__SYMBUI_PANEL_STATE__)");
  } catch (error) {
    await close();
    throw error;
  }

  return { client, debugPort, targetId: pageTargetId, errors, close };
}

// The panel gets its own browser. As a background tab of the annotated browser
// it stops getting frames and stops re-rendering, which is an artefact of the
// harness: the real panel is a separate window that is always frontmost.
async function launchPanelBrowser(url) {
  const chromePath = await findChrome();
  if (!chromePath) return null;
  const debugPort = await freePort();
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "symbui-panel-ui-"));
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
      "--hide-scrollbars",
      "--window-size=420,760",
      url,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const close = async () => {
    chrome.kill("SIGTERM");
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  };
  try {
    await waitForVersion(debugPort);
    const target = await findPageTarget(debugPort, url);
    const client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    await waitFor(client, "document.readyState === 'complete'");
    await waitFor(client, "location.search.includes('token=')");
    return { client, close };
  } catch (error) {
    await close();
    throw error;
  }
}

// Scrolls the target into view first: the panel body scrolls, and a control in
// the footer has no on-screen coordinates until it is brought on screen.
async function centerIn(client, selector) {
  const point = await evaluate(
    client,
    `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      node.scrollIntoView({ block: "center", inline: "center" });
      const box = node.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`,
  );
  if (!point) throw new Error(`No element for ${selector} in the panel page`);
  return point;
}

async function clickAt(client, point) {
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
  });
  await sleep(30);
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
  await sleep(80);
}

async function withBrowser(run, options = {}) {
  const session = await launch(options);
  if (!session) return { skipped: "Chrome is not installed" };
  try {
    await run(session);
    if (session.errors.length > 0) throw session.errors[0];
    return {};
  } finally {
    await session.close();
  }
}

test("the relay answers only with the session token", async (t) => {
  const outcome = await withBrowser(async ({ client }) => {
    const host = await startPanelHost({ client });
    try {
      const bare = await fetch(`http://127.0.0.1:${host.port}/panel.html`);
      assert.equal(bare.status, 403, "no token, no page");

      const wrong = await fetch(
        `http://127.0.0.1:${host.port}/panel.html?token=not-the-token`,
      );
      assert.equal(wrong.status, 403, "a guessed token is not a token");

      const allowed = await fetch(host.url);
      assert.equal(allowed.status, 200);
      assert.match(
        allowed.headers.get("content-type") || "",
        /text\/html/,
        "the panel is served as a page",
      );
      assert.equal(
        allowed.headers.get("access-control-allow-origin"),
        null,
        "no CORS header: a web page that finds the port cannot read this",
      );
      assert.match(await allowed.text(), /<html/i);

      const nameless = await fetch(`http://127.0.0.1:${host.port}/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "freeze" }),
      });
      assert.equal(nameless.status, 403, "the route that mutates needs the token");

      const command = await fetch(
        `http://127.0.0.1:${host.port}/command?token=${host.token}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ command: "no-such-command" }),
        },
      );
      assert.equal(command.status, 200, "a refused command is not an HTTP error");
      const body = await command.json();
      assert.equal(body.ok, false);
      assert.match(String(body.error), /未知指令/);
    } finally {
      await host.close();
    }
  });
  if (outcome.skipped) return t.skip(outcome.skipped);
});

test("the floating panel is a second view that drives the page", async (t) => {
  // The production path relays the page's toasts to the panel; this harness
  // stands in for start-session.mjs and does exactly the same thing, so the
  // panel is never a surface that silently swallows a refusal.
  const relay = { host: null };
  const outcome = await withBrowser(
    async ({ client, debugPort, targetId }) => {
      const host = await startPanelHost({ client });
      relay.host = host;
      const panelBrowser = await launchPanelBrowser(host.url);
      const panel = panelBrowser.client;
      try {
      await waitFor(
        panel,
        `document.querySelectorAll("#tool-grid button[data-tool]").length === 6`,
      );
      const tools = await evaluate(
        panel,
        `[...document.querySelectorAll("#tool-grid button[data-tool]")].map((b) => b.dataset.tool)`,
      );
      assert.deepEqual(tools, [
        "box",
        "point",
        "arrow",
        "redact",
        "move",
        "resize",
      ]);
      assert.equal(
        await evaluate(panel, `document.getElementById("status").textContent`),
        "实时",
        "the panel opens on the state the page is in",
      );

      // Freeze from the panel; the overlay in the page has to follow, and the
      // panel's own status has to follow with it.
      await clickAt(panel, await centerIn(panel, "#freeze"));
      await waitFor(client, `window.__SYMBUI_PANEL_STATE__().mode === "frozen"`);
      await waitFor(
        panel,
        `document.getElementById("status").textContent === "已冻结"`,
        "the panel follows the page's mode",
      );

      // Draw in the page; the panel has to catch up on its own.
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: BOX_DRAG.from.x,
        y: BOX_DRAG.from.y,
      });
      await client.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "left",
        buttons: 1,
        clickCount: 1,
        x: BOX_DRAG.from.x,
        y: BOX_DRAG.from.y,
      });
      for (let index = 1; index <= 3; index += 1) {
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          button: "left",
          buttons: 1,
          x: BOX_DRAG.from.x + ((BOX_DRAG.to.x - BOX_DRAG.from.x) * index) / 3,
          y: BOX_DRAG.from.y + ((BOX_DRAG.to.y - BOX_DRAG.from.y) * index) / 3,
        });
        await sleep(20);
      }
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        button: "left",
        buttons: 0,
        clickCount: 1,
        x: BOX_DRAG.to.x,
        y: BOX_DRAG.to.y,
      });
      await waitFor(
        client,
        `window.__SYMBUI_PANEL_STATE__().annotations.length === 1`,
      );

      await waitFor(
        panel,
        `document.querySelectorAll("#annotation-list button").length === 1`,
        "the panel learns about a page-side change on its own",
      );
      // Clicking in the panel selects in the page.
      await clickAt(panel, await centerIn(panel, "#annotation-list button"));
      await waitFor(
        client,
        `window.__SYMBUI_PANEL_STATE__().annotations[0].selected === true`,
      );
      assert.equal(
        await evaluate(
          panel,
          `!document.getElementById("editor").classList.contains("hidden")`,
        ),
        true,
        "the editor opens for the selected annotation",
      );

      // The gate refuses a finish without an explanation, and that refusal has
      // to reach the surface the user is looking at.
      await clickAt(panel, await centerIn(panel, "#finish"));
      // Whichever gate refuses first, the refusal has to be readable on the
      // surface the user is looking at: the page says it, the panel says it too.
      const refusal = await evaluate(
        client,
        `document.querySelector("#__symbui-host").shadowRoot.querySelector(".toast").textContent`,
      );
      assert.match(
        refusal,
        /请至少选择|还没有填写预期结果/,
        "the page must refuse the empty finish with its own gate message",
      );
      await waitFor(
        panel,
        `document.getElementById("toast").textContent === ${JSON.stringify(refusal)}`,
        `the page's refusal ("${refusal}") shows up on the floating panel`,
      );

      // Typing in the panel writes the page's intent, and the snapshot that
      // comes back must not eat the text.
      await clickAt(panel, await centerIn(panel, "#expected"));
      await panel.send("Input.insertText", { text: "按钮应右对齐" });
      await evaluate(panel, `document.getElementById("expected").blur(), true`);
      await waitFor(
        client,
        `window.__SYMBUI_PANEL_STATE__().editor.expected.trim() === "按钮应右对齐"`,
      );
      await sleep(700);
      assert.equal(
        await evaluate(panel, `document.getElementById("expected").value`),
        "按钮应右对齐",
        "the round-tripped snapshot must not clobber what was typed",
      );
      } finally {
        await panelBrowser.close();
        await host.close();
      }
    },
    {
      onMessage(message) {
        if (message.type !== "panel-toast" || !relay.host) return;
        relay.host.push({
          type: "toast",
          tone: message.payload?.tone || "info",
          message: String(message.payload?.message || ""),
        });
      },
    },
  );
  if (outcome.skipped) return t.skip(outcome.skipped);
});

test("the native window loads the panel page", async (t) => {
  if (process.platform !== "darwin") {
    return t.skip("the floating window is a macOS feature");
  }
  const build = spawnSync(process.execPath, [BUILD_PANEL], {
    encoding: "utf8",
  });
  if (build.status !== 0) {
    return t.skip(
      `the native panel did not build: ${(build.stderr || "").trim().split("\n").pop()}`,
    );
  }
  const binary = (build.stdout || "").trim().split("\n").filter(Boolean).pop();
  assert.ok(binary, "the build must print the binary path");

  const outcome = await withBrowser(async ({ client }) => {
    const host = await startPanelHost({ client });
    const shell = spawn(binary, ["--url", host.url, "--title", "SymbUI"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    shell.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    shell.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    const exited = new Promise((resolve) => {
      shell.once("exit", (code, signal) => resolve({ code, signal }));
    });

    try {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && !/SYMBUI_PANEL_READY/.test(stdout)) {
        if (/SYMBUI_PANEL_ERROR/.test(stdout) || /SYMBUI_PANEL_ERROR/.test(stderr)) {
          break;
        }
        await sleep(200);
      }
      assert.match(
        stdout,
        /SYMBUI_PANEL_READY \S+ level=3/,
        `the window must report a floating level: ${stdout}${stderr}`,
      );
      // The page being loaded is not enough: /hello is the panel page's own
      // JavaScript running inside the WKWebView.
      const helloDeadline = Date.now() + 10000;
      while (Date.now() < helloDeadline && host.helloCount() === 0) {
        await sleep(100);
      }
      assert.ok(
        host.helloCount() >= 1,
        "the native window must actually run the panel page",
      );

      shell.kill("SIGTERM");
      const result = await Promise.race([
        exited,
        sleep(5000).then(() => null),
      ]);
      assert.ok(result, "the window must exit when the session ends");
      assert.equal(result.code, 0, `clean exit, got ${JSON.stringify(result)}`);
    } finally {
      if (shell.exitCode == null) shell.kill("SIGKILL");
      await host.close();
    }
  });
  if (outcome.skipped) return t.skip(outcome.skipped);
});

test("deleting a frozen page from the panel takes two clicks", async (t) => {
  const outcome = await withBrowser(
    async ({ client }) => {
      const host = await startPanelHost({ client });
      const panelBrowser = await launchPanelBrowser(host.url);
      const panel = panelBrowser.client;
      try {
        await waitFor(
          panel,
          `document.querySelectorAll("#tool-grid button[data-tool]").length === 6`,
        );
        await clickAt(panel, await centerIn(panel, "#freeze"));
        await waitFor(client, `window.__SYMBUI_PANEL_STATE__().states.length === 1`);
        // The panel is up to a poll behind the page: a disabled button swallows
        // the click, so wait for the button, not only for the page's state.
        await waitFor(
          panel,
          `document.getElementById("delete-state").disabled === false`,
        );

        // The first click only arms: the dialog that used to ask lives in the
        // page, and a modal there blocks the renderer this panel is talking to,
        // so the question has to be asked on this side.
        await clickAt(panel, await centerIn(panel, "#delete-state"));
        assert.equal(
          await evaluate(client, `window.__SYMBUI_PANEL_STATE__().states.length`),
          1,
          "one click must not delete a frozen page",
        );
        assert.equal(
          await evaluate(
            panel,
            `document.getElementById("delete-state").textContent.trim()`,
          ),
          "再点一次删除",
          "the armed state has to say so",
        );

        await clickAt(panel, await centerIn(panel, "#delete-state"));
        await waitFor(client, `window.__SYMBUI_PANEL_STATE__().states.length === 0`);
        await waitFor(
          panel,
          `document.getElementById("delete-state").disabled === true`,
          "no frozen page is left to delete",
        );
      } finally {
        await panelBrowser.close();
        await host.close();
      }
    },
  );
  if (outcome.skipped) return t.skip(outcome.skipped);
});
