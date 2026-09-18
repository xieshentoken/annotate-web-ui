#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildChangeSpec } from "./build-change-spec.mjs";
import { resolveStaticSite, startStaticSite } from "./static-site.mjs";
import { isAllowedLocalUrl, validateSessionData } from "./validate-session.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY_PATH = path.resolve(SCRIPT_DIR, "../assets/overlay.js");
const PROBE_PATH = path.resolve(SCRIPT_DIR, "../assets/inventory-probe.js");

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      result[key] = true;
    } else {
      result[key] = value;
      index += 1;
    }
  }
  return result;
}

function usage() {
  return [
    "Usage:",
    "  node start-session.mjs --url http://localhost:5173 --repo /absolute/project/path",
    "  node start-session.mjs --static /absolute/project/path --repo /absolute/project/path",
    "",
    "Options:",
    "  --static [path]       Serve a static directory or HTML file; defaults to <repo>",
    "  --output-root /path   Override <repo>/.symbui/sessions",
    "  --chrome /path        Override the Chrome executable",
    "  --debug-port 9333     Use a fixed loopback debugging port",
    "  --keep-browser        Keep the isolated browser open after export",
  ].join("\n");
}

function sessionId() {
  const date = new Date();
  const compact = date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .replace(/\.\d{3}Z$/, "");
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${compact}-${suffix}`;
}

async function getFreePort() {
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

async function findChrome(explicit) {
  const candidates = [
    explicit,
    process.env.SYMBUI_CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next well-known executable.
    }
  }
  throw new Error(
    "No supported Chrome/Chromium executable was found. Pass --chrome /absolute/path.",
  );
}

async function ensureRepository(rawPath) {
  if (!rawPath || !path.isAbsolute(rawPath)) {
    throw new Error("--repo must be an absolute project directory.");
  }
  const resolved = await realpath(rawPath);
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error("--repo must point to a directory.");
  return resolved;
}

async function assertReachableLocalUrl(rawUrl) {
  if (!isAllowedLocalUrl(rawUrl)) {
    throw new Error(
      "--url must use HTTP or HTTPS on localhost, 127.0.0.1, [::1], or *.localhost.",
    );
  }
  const response = await fetch(rawUrl, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(6000),
  }).catch((error) => {
    throw new Error(`Local page is not reachable: ${error.message}`);
  });
  if (!response.ok) {
    throw new Error(`Local page returned HTTP ${response.status}: ${rawUrl}`);
  }
  await response.body?.cancel();
  return new URL(rawUrl).href;
}

async function waitForJson(url, timeoutMs = 20000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
      if (response.ok) return await response.json();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  throw new Error(
    `Timed out waiting for Chrome debugging endpoint${
      lastError ? `: ${lastError.message}` : "."
    }`,
  );
}

async function waitForPageTarget(port, targetUrl, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const targets = await waitForJson(
      `http://127.0.0.1:${port}/json/list`,
      2500,
    );
    const exact = targets.find(
      (target) =>
        target.type === "page" &&
        target.webSocketDebuggerUrl &&
        target.url === targetUrl,
    );
    if (exact) return exact;
    const local = targets.find(
      (target) =>
        target.type === "page" &&
        target.webSocketDebuggerUrl &&
        isAllowedLocalUrl(target.url),
    );
    if (local) return local;
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  throw new Error("Chrome opened, but the local page target was not discovered.");
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.counter = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (event) => {
        cleanup();
        reject(new Error(event.message || "CDP WebSocket connection failed."));
      };
      const cleanup = () => {
        this.socket.removeEventListener("open", onOpen);
        this.socket.removeEventListener("error", onError);
      };
      this.socket.addEventListener("open", onOpen);
      this.socket.addEventListener("error", onError);
    });

    this.socket.addEventListener("message", async (event) => {
      let raw;
      if (typeof event.data === "string") raw = event.data;
      else if (event.data instanceof ArrayBuffer) {
        raw = Buffer.from(event.data).toString("utf8");
      } else if (event.data?.arrayBuffer) {
        raw = Buffer.from(await event.data.arrayBuffer()).toString("utf8");
      } else {
        raw = Buffer.from(event.data).toString("utf8");
      }
      const message = JSON.parse(raw);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(
            new Error(
              `${pending.method}: ${message.error.message || "CDP command failed"}`,
            ),
          );
        } else {
          pending.resolve(message.result || {});
        }
        return;
      }
      if (message.method) {
        for (const listener of this.listeners.get(message.method) || []) {
          listener(message.params || {});
        }
      }
    });

    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("Chrome debugging connection closed."));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Chrome debugging connection is not open."));
    }
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const list = this.listeners.get(method) || [];
    list.push(listener);
    this.listeners.set(method, list);
  }

  close() {
    if (
      this.socket &&
      [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.socket.readyState)
    ) {
      this.socket.close();
    }
  }
}

function dataUrlBuffer(dataUrl) {
  const match = /^data:image\/png;base64,([a-zA-Z0-9+/=\s]+)$/.exec(dataUrl);
  if (!match) throw new Error("Expected a PNG data URL.");
  return Buffer.from(match[1], "base64");
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const staticRequested = Object.prototype.hasOwnProperty.call(args, "static");
  if (args.help || !args.repo || (!args.url && !staticRequested)) {
    console.log(usage());
    if (!args.help) process.exitCode = 1;
    return;
  }
  if (args.url && staticRequested) {
    throw new Error("Use either --url or --static, not both.");
  }
  if (staticRequested && args["keep-browser"]) {
    throw new Error(
      "--keep-browser cannot be used with --static because the built-in server closes with the session.",
    );
  }

  const repoPath = await ensureRepository(args.repo);
  const staticSite = staticRequested
    ? await resolveStaticSite({ repoPath, staticPath: args.static })
    : null;
  const externalTargetUrl = args.url
    ? await assertReachableLocalUrl(args.url)
    : null;
  const chromePath = await findChrome(args.chrome);
  const debugPort = args["debug-port"]
    ? Number(args["debug-port"])
    : await getFreePort();
  if (!Number.isInteger(debugPort) || debugPort < 1024 || debugPort > 65535) {
    throw new Error("--debug-port must be an integer between 1024 and 65535.");
  }

  const id = sessionId();
  const outputRoot = path.resolve(
    args["output-root"] || path.join(repoPath, ".symbui", "sessions"),
  );
  const sessionDir = path.join(outputRoot, id);
  await mkdir(sessionDir, { recursive: true });
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "symbui-chrome-"));
  const overlaySource = await readFile(OVERLAY_PATH, "utf8");
  const probeSource = await readFile(PROBE_PATH, "utf8");
  const staticRuntime = staticSite ? await startStaticSite(staticSite) : null;
  const targetUrl = staticRuntime?.url || externalTargetUrl;
  const createdAt = new Date().toISOString();
  const bootstrap = [
    `window.__SYMBUI_CONFIG__ = ${JSON.stringify({
      sessionId: id,
      createdAt,
      repoPath,
      targetUrl,
    })};`,
    // The probe lands first: the overlay resolves element keys through the
    // mapping the probe publishes, and a first-pass drag has to record the
    // same key the inventory will use for that element.
    probeSource,
    overlaySource,
  ].join("\n");

  let chromeStderr = "";
  let completed = false;
  let shuttingDown = false;
  let client;
  let finishResolve;
  const finished = new Promise((resolve) => {
    finishResolve = resolve;
  });

  const chrome = spawn(
    chromePath,
    [
      `--remote-debugging-port=${debugPort}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-session-crashed-bubble",
      "--allow-insecure-localhost",
      "--new-window",
      targetUrl,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  chrome.stderr.on("data", (chunk) => {
    chromeStderr = `${chromeStderr}${chunk.toString("utf8")}`.slice(-6000);
  });
  chrome.once("error", (error) => {
    console.error(`Chrome failed to launch: ${error.message}`);
    finishResolve();
  });
  chrome.once("exit", (code) => {
    if (!shuttingDown && !completed) {
      console.error(
        `Chrome closed before the session completed${
          code == null ? "." : ` (exit ${code}).`
        }`,
      );
      finishResolve();
    }
  });

  async function sendToPage(message, executionContextId) {
    const expression = `window.__SYMBUI_RECEIVE__ && window.__SYMBUI_RECEIVE__(${JSON.stringify(
      message,
    )})`;
    await client.send("Runtime.evaluate", {
      expression,
      contextId: executionContextId,
      returnByValue: true,
    });
  }

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (client && !args["keep-browser"]) {
      await Promise.race([
        client.send("Browser.close").catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 700)),
      ]);
    }
    client?.close();
    if (args["keep-browser"]) {
      chrome.unref();
    } else if (chrome.exitCode == null) {
      chrome.kill("SIGTERM");
    }
    chrome.stderr?.destroy();
    chrome.unref();
    if (!args["keep-browser"]) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
    await staticRuntime?.close().catch(() => {});
  }

  const handleSignal = async () => {
    console.log("\nSymbUI session interrupted.");
    await shutdown();
    finishResolve();
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  try {
    await waitForJson(`http://127.0.0.1:${debugPort}/json/version`);
    const target = await waitForPageTarget(debugPort, targetUrl);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();

    let queue = Promise.resolve();
    let readyPrinted = false;
    const printReady = (url = targetUrl) => {
      if (readyPrinted) return;
      readyPrinted = true;
      console.log(`SYMBUI_READY=${url}`);
      console.log(`SYMBUI_SESSION_ID=${id}`);
      console.log(`SYMBUI_SESSION_DIR=${sessionDir}`);
      if (staticRuntime) {
        console.log(`SYMBUI_STATIC_ROOT=${staticRuntime.rootPath}`);
        console.log(`SYMBUI_STATIC_ENTRY=${staticRuntime.entryPath}`);
      }
      console.log(
        "Use the floating SymbUI panel. Click “完成并生成” when finished.",
      );
    };
    client.on("Runtime.bindingCalled", (event) => {
      queue = queue
        .then(async () => {
          if (event.name !== "__symbuiNative") return;
          let message;
          try {
            message = JSON.parse(event.payload);
          } catch {
            return;
          }
          const contextId = event.executionContextId;
          const type = message.type;
          const payload = message.payload || {};

          if (type === "overlay-ready") {
            if (isAllowedLocalUrl(payload.url)) printReady(payload.url);
            return;
          }

          if (type === "request-capture") {
            try {
              const screenshot = await client.send("Page.captureScreenshot", {
                format: "png",
                fromSurface: true,
                captureBeyondViewport: false,
              });
              const fileName = `before-${payload.state.id}.png`;
              await writeFile(
                path.join(sessionDir, fileName),
                Buffer.from(screenshot.data, "base64"),
              );
              await sendToPage(
                {
                  type: "capture-ready",
                  beforeImage: fileName,
                  dataUrl: `data:image/png;base64,${screenshot.data}`,
                },
                contextId,
              );
            } catch (error) {
              await sendToPage(
                {
                  type: "capture-error",
                  message: error instanceof Error ? error.message : String(error),
                },
                contextId,
              ).catch(() => {});
            }
            return;
          }

          if (type === "save-annotated") {
            const safeFile = path.basename(payload.fileName || "");
            if (!/^annotated-S\d+\.png$/.test(safeFile)) {
              throw new Error("Invalid annotated image file name.");
            }
            await writeFile(
              path.join(sessionDir, safeFile),
              dataUrlBuffer(payload.dataUrl),
            );
            return;
          }

          if (type === "delete-state") {
            const stateId = String(payload.stateId || "");
            const beforeImage = path.basename(payload.beforeImage || "");
            const annotatedImage = path.basename(payload.annotatedImage || "");
            if (
              !/^S\d+$/.test(stateId) ||
              beforeImage !== `before-${stateId}.png` ||
              annotatedImage !== `annotated-${stateId}.png`
            ) {
              throw new Error("Invalid frozen-state deletion request.");
            }
            await Promise.all([
              rm(path.join(sessionDir, beforeImage), { force: true }),
              rm(path.join(sessionDir, annotatedImage), { force: true }),
            ]);
            return;
          }

          if (type === "finish-session") {
            try {
              const session = payload.session;
              const validation = validateSessionData(session);
              if (validation.errors.length > 0) {
                throw new Error(validation.errors.join(" "));
              }
              await writeJson(path.join(sessionDir, "session.json"), session);
              await writeJson(
                path.join(sessionDir, "annotations.json"),
                session.annotations,
              );
              await writeJson(
                path.join(sessionDir, "dom-context.json"),
                session.annotations
                  .filter((annotation) => annotation.target)
                  .map((annotation) => ({
                    annotationId: annotation.id,
                    stateId: annotation.stateId,
                    target: annotation.target,
                  })),
              );
              const result = await buildChangeSpec({ sessionDir, repoPath });
              completed = true;
              await sendToPage(
                {
                  type: "session-complete",
                  sessionDir,
                  changeRequest: result.requestPath,
                  implementationPrompt: result.promptPath,
                },
                contextId,
              );
              console.log(`SYMBUI_CHANGE_REQUEST=${result.requestPath}`);
              console.log(`SYMBUI_IMPLEMENTATION_PROMPT=${result.promptPath}`);
              console.log(`SYMBUI_COMPLETE=1`);
              setTimeout(finishResolve, 1200);
            } catch (error) {
              await sendToPage(
                {
                  type: "session-error",
                  message: error instanceof Error ? error.message : String(error),
                },
                contextId,
              ).catch(() => {});
              console.error(
                `Session generation failed: ${
                  error instanceof Error ? error.stack : String(error)
                }`,
              );
            }
          }
        })
        .catch((error) => {
          console.error(
            `SymbUI controller error: ${
              error instanceof Error ? error.stack : String(error)
            }`,
          );
        });
    });

    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Runtime.addBinding", { name: "__symbuiNative" });
    await client.send("Page.addScriptToEvaluateOnNewDocument", {
      source: bootstrap,
    });
    const injection = await client.send("Runtime.evaluate", {
      expression: bootstrap,
      awaitPromise: false,
    });
    if (injection.exceptionDetails) {
      throw new Error(
        injection.exceptionDetails.exception?.description ||
          injection.exceptionDetails.text ||
          "The SymbUI overlay failed to initialize.",
      );
    }
    const overlayCheck = await client.send("Runtime.evaluate", {
      expression:
        '({present:Boolean(document.querySelector("#__symbui-host")?.shadowRoot?.querySelector(".panel")),url:location.href})',
      returnByValue: true,
    });
    const overlayState = overlayCheck.result?.value;
    if (overlayState?.present && isAllowedLocalUrl(overlayState.url)) {
      printReady(overlayState.url);
    }

    await finished;
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    if (chromeStderr) {
      console.error(`Chrome diagnostics:\n${chromeStderr}`);
    }
    process.exitCode = 1;
  } finally {
    await shutdown();
    if (!completed && process.exitCode == null) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
