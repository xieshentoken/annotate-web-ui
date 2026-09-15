#!/usr/bin/env node

// Capture one revision of the application: screenshots plus an element
// inventory, for every state in the session.
//
// The point of a revision is reproducibility. It either reproduces the baseline
// states exactly — same ids, routes, viewports, scroll offsets — or it records
// what it could not reproduce. It never substitutes a different state, because
// a substituted state turns the diff into noise.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CdpClient, evaluate, findPageTarget, waitForVersion } from "./lib/cdp.mjs";
import {
  baselineRevision,
  gitInfo,
  loadSession,
  nextRevisionId,
  normalizeSession,
  pathExists,
  readJson,
  saveSession,
  SCHEMA_VERSION,
  writeJson,
} from "./lib/session.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROBE_PATH = path.resolve(SCRIPT_DIR, "../assets/inventory-probe.js");
const DEFAULT_VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 };
const DEFAULT_SETTLE_MS = 350;

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) result[key] = true;
    else {
      result[key] = value;
      index += 1;
    }
  }
  return result;
}

function usage() {
  return [
    "Usage: capture-revision.mjs --session <dir> [options]",
    "",
    "  --session <dir>        session directory (created when missing)",
    "  --url <url>            target URL; required when the session is new",
    "  --revision <id>        revision id (default: next free id)",
    "  --role <role>          baseline | result (default: baseline)",
    "  --states <file.json>   explicit state list",
    "  --viewport <WxH>       viewport for the default state (default 1280x800)",
    "  --state-title <text>   title for the default state",
    "  --settle <ms>          extra wait after load (default 350)",
    "  --cdp-port <port>      attach to a running browser instead of launching",
    "  --chrome <path>        Chrome executable",
    "  --headful              launch with a visible window",
    "  --keep-chrome          do not close a browser this script launched",
  ].join("\n");
}

function parseViewport(value) {
  const match = /^(\d+)x(\d+)(?:@([\d.]+))?$/.exec(String(value || ""));
  if (!match) return null;
  return {
    width: Number(match[1]),
    height: Number(match[2]),
    deviceScaleFactor: match[3] ? Number(match[3]) : 1,
  };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function findChrome(explicit) {
  const candidates = [
    explicit,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  throw new Error("Chrome not found. Pass --chrome <path>.");
}

async function launchChrome(chromePath, port, url, headful) {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "symbui-rev-"));
  const args = [
    `--remote-debugging-port=${port}`,
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
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--window-size=${DEFAULT_VIEWPORT.width},${DEFAULT_VIEWPORT.height}`,
    "about:blank",
  ];
  if (!headful) args.unshift("--headless=new");
  const child = spawn(chromePath, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
  await waitForVersion(port).catch((error) => {
    throw new Error(`${error.message}\n${stderr}`);
  });
  return {
    child,
    profileDir,
    async close() {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

function statesFromBaseline(session) {
  const baseline = baselineRevision(session);
  if (!baseline) return [];
  return baseline.states.map((state) => ({
    id: state.id,
    title: state.title || state.id,
    description: state.description || "",
    url: state.url || session.targetUrl,
    viewport: state.viewport || { ...DEFAULT_VIEWPORT },
    scroll: state.scroll || { x: 0, y: 0 },
  }));
}

async function prepareStates(args, session) {
  if (args.states) {
    const raw = await readJson(path.resolve(args.states));
    const list = Array.isArray(raw) ? raw : raw.states || [];
    return list.map((state, index) => ({
      id: state.id || `s${index + 1}`,
      title: state.title || state.id || `状态 ${index + 1}`,
      description: state.description || "",
      url: state.url || session.targetUrl,
      viewport: state.viewport || { ...DEFAULT_VIEWPORT },
      scroll: state.scroll || { x: 0, y: 0 },
    }));
  }
  if (args.role === "result") {
    const inherited = statesFromBaseline(session);
    if (inherited.length > 0) return inherited;
  }
  const viewport = parseViewport(args.viewport) || { ...DEFAULT_VIEWPORT };
  return [
    {
      id: args["state-id"] || "s1",
      title: args["state-title"] || "默认状态",
      description: "",
      url: session.targetUrl,
      viewport,
      scroll: { x: 0, y: 0 },
    },
  ];
}

async function settle(client, ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureState(client, probeSource, state, sessionDir, revisionId) {
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: state.viewport.width,
    height: state.viewport.height,
    deviceScaleFactor: state.viewport.deviceScaleFactor || 1,
    mobile: false,
  });
  await client.send("Page.navigate", { url: state.url });
  await settle(client, 120);

  const deadline = Date.now() + 20000;
  for (;;) {
    const ready = await evaluate(client, "document.readyState").catch(() => "loading");
    if (ready === "complete") break;
    if (Date.now() > deadline) throw new Error(`Page never finished loading: ${state.url}`);
    await settle(client, 100);
  }
  await evaluate(client, "document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true").catch(() => {});
  await settle(client, 250);

  await evaluate(
    client,
    `(() => { window.scrollTo(${state.scroll.x || 0}, ${state.scroll.y || 0}); return true; })()`,
  );
  await evaluate(client, probeSource);
  await settle(client, 150);

  const inventory = await evaluate(
    client,
    `window.__SYMBUI_INVENTORY__(${JSON.stringify({ stateId: state.id, includeAncestry: false })})`,
  );
  if (!inventory || !Array.isArray(inventory.elements)) {
    throw new Error(`Inventory probe returned nothing for state ${state.id}`);
  }

  const screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const imagePath = path.join(sessionDir, "revisions", revisionId, `${state.id}.png`);
  await mkdir(path.dirname(imagePath), { recursive: true });
  await writeFile(imagePath, Buffer.from(screenshot.data, "base64"));

  const actual = inventory.viewport;
  const expected = state.viewport;
  const viewportMatched =
    actual.width === expected.width && actual.height === expected.height;

  return {
    state: {
      id: state.id,
      title: state.title,
      description: state.description,
      url: inventory.url || state.url,
      capturedAt: inventory.capturedAt,
      viewport: actual,
      scroll: inventory.scroll,
      beforeImage: path.relative(sessionDir, imagePath).split(path.sep).join("/"),
      annotatedImage: null,
    },
    inventory: { stateId: state.id, viewport: actual, elements: inventory.elements },
    stats: inventory.stats,
    viewportMatched,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.session) throw new Error(usage());
  const sessionDir = path.resolve(args.session);

  let session;
  if (await pathExists(path.join(sessionDir, "session.json"))) {
    ({ session } = await loadSession(sessionDir));
  } else {
    if (!args.url) throw new Error("--url is required when creating a new session.");
    session = normalizeSession({
      schemaVersion: SCHEMA_VERSION,
      sessionId: path.basename(sessionDir),
      createdAt: new Date().toISOString(),
      repoPath: args.repo ? path.resolve(args.repo) : null,
      targetUrl: args.url,
      revisions: [],
      rounds: [],
    });
    await saveSession(sessionDir, session);
  }
  if (args.url) session.targetUrl = args.url;
  if (args.repo) session.repoPath = path.resolve(args.repo);

  const states = await prepareStates(args, session);
  if (states.length === 0) throw new Error("No states to capture.");

  const revisionId = args.revision || nextRevisionId(session);
  const role = args.role === "result" ? "result" : "baseline";
  const probeSource = await readFile(PROBE_PATH, "utf8");

  let launched = null;
  let port = args["cdp-port"] ? Number(args["cdp-port"]) : null;
  try {
    if (!port) {
      port = await freePort();
      launched = await launchChrome(await findChrome(args.chrome), port, session.targetUrl, Boolean(args.headful));
      console.log(`Chrome launched on port ${port}`);
    } else {
      await waitForVersion(port);
    }

    const target = await findPageTarget(port, session.targetUrl);
    const client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send("Runtime.enable");
    await client.send("Page.enable");

    const results = [];
    const missing = [];
    for (const state of states) {
      try {
        results.push(await captureState(client, probeSource, state, sessionDir, revisionId));
      } catch (error) {
        missing.push({ stateId: state.id, reason: error.message });
        console.warn(`WARN: state ${state.id} failed: ${error.message}`);
      }
    }
    client.close();

    if (results.length === 0) throw new Error("No state could be captured.");

    const inventory = {
      revisionId,
      role,
      capturedAt: new Date().toISOString(),
      states: results.map((item) => item.inventory),
    };
    const inventoryPath = path.join(sessionDir, "inventory", `${revisionId}.json`);
    await writeJson(inventoryPath, inventory);

    const revision = {
      id: revisionId,
      roundIndex: role === "baseline" ? 0 : session.revisions.length,
      role,
      createdAt: new Date().toISOString(),
      git: gitInfo(session.repoPath),
      states: results.map((item) => item.state),
      inventory: path.relative(sessionDir, inventoryPath).split(path.sep).join("/"),
      missingStates: missing,
      stats: {
        elements: results.reduce((sum, item) => sum + (item.stats?.elements || 0), 0),
        anchored: results.reduce((sum, item) => sum + (item.stats?.anchored || 0), 0),
      },
    };

    const index = session.revisions.findIndex((item) => item.id === revisionId);
    if (index === -1) session.revisions.push(revision);
    else session.revisions[index] = revision;
    session.schemaVersion = SCHEMA_VERSION;
    await saveSession(sessionDir, session);

    console.log(`SYMBUI_REVISION=${revisionId}`);
    console.log(`SYMBUI_REVISION_DIR=${path.join(sessionDir, "revisions", revisionId)}`);
    console.log(`SYMBUI_INVENTORY=${inventoryPath}`);
    for (const item of results) {
      const anchored = item.stats?.anchored || 0;
      const total = item.stats?.elements || 0;
      const anchorNote =
        total > 0 && anchored / total < 0.2
          ? "  (锚点覆盖偏低，建议接入源码注入插件)"
          : "";
      console.log(
        `  state ${item.state.id}: ${total} 个元素，${anchored} 个有源码锚点${item.viewportMatched ? "" : "，视口未匹配"}${anchorNote}`,
      );
    }
    for (const item of missing) console.warn(`  missing ${item.stateId}: ${item.reason}`);

    if (revision.stats.elements > 0 && revision.stats.anchored / revision.stats.elements < 0.2) {
      console.warn(
        "WARN: fewer than 20% of elements carry a source anchor. Diff alignment will lean on test ids and selectors, which are fragile across refactors.",
      );
    }
  } finally {
    if (launched && !args["keep-chrome"]) await launched.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
