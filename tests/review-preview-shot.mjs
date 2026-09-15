#!/usr/bin/env node

// Renders the review preview in each comparison mode and saves screenshots.
// Used to eyeball the UI and to keep a visual record of a round.

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CdpClient, evaluate, findPageTarget, waitForVersion } from "../annotate-web-ui/scripts/lib/cdp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".js": "text/javascript; charset=utf-8",
};

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

function serve(root) {
  const server = http.createServer(async (request, response) => {
    let relative = decodeURIComponent(request.url.split("?")[0]);
    if (relative === "/") relative = "/review.html";
    const target = path.join(root, relative);
    if (!target.startsWith(root)) {
      response.writeHead(403);
      response.end();
      return;
    }
    try {
      const body = await readFile(target);
      response.writeHead(200, {
        "content-type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
        "cache-control": "no-store",
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function findChrome() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
  ];
  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  throw new Error("Chrome not found");
}

const MODES = [
  { mode: "side", name: "1-并排" },
  { mode: "slider", name: "2-滑块" },
  { mode: "heatmap", name: "3-热力图" },
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const reviewDir = path.resolve(
    args.dir ||
      path.join(ROOT, ".workbuddy-ai", "demo", "review-loop", "session", "rounds", "R1", "review"),
  );
  const outDir = path.resolve(args.out || path.join(reviewDir, "shots"));
  await mkdir(outDir, { recursive: true });

  const { server, port } = await serve(reviewDir);
  const debugPort = await freePort();
  const profileDir = await new Promise((resolve, reject) => {
    import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(path.join(os.tmpdir(), "symbui-shot-")).then(resolve, reject),
    );
  });

  const url = `http://127.0.0.1:${port}/review.html`;
  const chrome = spawn(
    await findChrome(),
    [
      "--headless=new",
      `--remote-debugging-port=${debugPort}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--hide-scrollbars",
      "--window-size=1440,900",
      url,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  try {
    await waitForVersion(debugPort);
    const target = await findPageTarget(debugPort, url);
    const client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });

    const deadline = Date.now() + 20000;
    for (;;) {
      const ready = await evaluate(client, "window.__SYMBUI_REVIEW_READY__ === true").catch(() => false);
      if (ready) break;
      if (Date.now() > deadline) throw new Error("review.html never became ready");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await new Promise((resolve) => setTimeout(resolve, 800));

    const written = [];
    for (const entry of MODES) {
      await evaluate(
        client,
        `document.querySelector('#modeSeg button[data-mode="${entry.mode}"]').click(); true`,
      );
      await new Promise((resolve) => setTimeout(resolve, 700));
      const shot = await client.send("Page.captureScreenshot", {
        format: "png", fromSurface: true, captureBeyondViewport: false,
      });
      const file = path.join(outDir, `${entry.name}.png`);
      await writeFile(file, Buffer.from(shot.data, "base64"));
      written.push(file);
      console.log(`SYMBUI_SHOT=${file}`);
    }
    client.close();
  } finally {
    chrome.kill("SIGTERM");
    server.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
