// Start-session baseline.
//
// `review-session` can only compare against a baseline that has an element
// inventory, and the annotation session is the last moment before an agent
// edits the page that the inventory can be taken at all. This drives the real
// CLI end to end: start-session, a synthetic finish, an edit to the served
// page, then review-session.
//
// The test exists because the only other end-to-end coverage ran
// `capture-revision.mjs --role baseline` directly, which is not the path a user
// takes — start-session is. That divergence hid a whole class of session that
// could never be reviewed: `normalizeSession` synthesized a baseline with
// `inventory: null`, and `review-session` crashed on it.
//
//     node --test tests/start-session-baseline.test.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FIXTURE = path.join(HERE, "fixture");
const SCRIPTS = path.join(ROOT, "annotate-web-ui", "scripts");

const CHROME_CANDIDATES = [
  process.env.SYMBUI_CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* The site has to be served from somewhere this test owns: `review-session`
 * re-captures the same URL, so the page must change between the two runs
 * without the repository's own fixture being touched. */
async function serve(dir, port) {
  const server = http.createServer(async (request, response) => {
    const relative =
      request.url === "/" ? "/index.html" : request.url.split("?")[0];
    try {
      const body = await readFile(path.join(dir, relative));
      response.writeHead(200, {
        "content-type":
          MIME[path.extname(relative)] || "application/octet-stream",
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}

function run(script, args) {
  const child = spawn(process.execPath, [path.join(SCRIPTS, script), ...args], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const state = { stdout: "", stderr: "", child };
  child.stdout.on("data", (chunk) => {
    state.stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    state.stderr += chunk.toString();
  });
  return state;
}

async function waitForSessionDir(started, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = /SYMBUI_SESSION_DIR=(\S+)/.exec(started.stdout);
    if (match) return match[1];
    await sleep(150);
  }
  throw new Error(
    `start-session never printed SYMBUI_SESSION_DIR\n${started.stdout}\n${started.stderr}`,
  );
}

const chromePath = await findChrome();
const skip = chromePath
  ? false
  : "Google Chrome was not found; set SYMBUI_CHROME_PATH to run this suite";

test(
  "a session recorded by start-session can be reviewed",
  { skip },
  async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "symbui-baseline-"));
    const siteDir = path.join(workDir, "site");
    await cp(FIXTURE, siteDir, { recursive: true });

    const sitePort = await freePort();
    const server = await serve(siteDir, sitePort);
    const siteUrl = `http://127.0.0.1:${sitePort}/`;

    let started = null;
    let client = null;
    try {
      const debugPort = await freePort();
      started = run("start-session.mjs", [
        "--url",
        siteUrl,
        "--repo",
        ROOT,
        "--output-root",
        path.join(workDir, "sessions"),
        "--debug-port",
        String(debugPort),
        "--headless",
      ]);

      const sessionDir = await waitForSessionDir(started);

      // The two images `validateSessionDirectory` insists on.
      await writeFile(path.join(sessionDir, "before-S1.png"), Buffer.from("png"));
      await writeFile(
        path.join(sessionDir, "annotated-S1.png"),
        Buffer.from("png"),
      );

      await waitForVersion(debugPort, 30000);
      const target = await findPageTarget(debugPort, null, 30000);
      client = new CdpClient(target.webSocketDebuggerUrl);
      await client.connect();
      await client.send("Runtime.enable");

      const now = new Date().toISOString();
      const payload = {
        schemaVersion: "1.1",
        sessionId: path.basename(sessionDir),
        createdAt: now,
        repoPath: ROOT,
        targetUrl: siteUrl,
        states: [
          {
            id: "S1",
            title: "Default",
            description: "Default view",
            url: siteUrl,
            capturedAt: now,
            viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
            scroll: { x: 0, y: 0 },
            beforeImage: "before-S1.png",
            annotatedImage: "annotated-S1.png",
          },
        ],
        annotations: [
          {
            id: "A1",
            kind: "element",
            stateId: "S1",
            geometry: { x: 10, y: 10, width: 120, height: 44 },
            target: { id: "count-button", tagName: "button" },
            intent: {
              operations: ["style"],
              expected: "按标注放大按钮的内边距",
              scope: "element",
              breakpoint: "all",
              priority: "should",
            },
          },
        ],
        completedAt: now,
      };

      // The same message the overlay sends when the user presses "完成并生成".
      await evaluate(
        client,
        `window.__symbuiNative(${JSON.stringify(
          JSON.stringify({
            type: "finish-session",
            payload: { session: payload },
          }),
        )}); true`,
      );
      client.close();
      client = null;

      const exitCode = await new Promise((resolve) =>
        started.child.on("exit", resolve),
      );
      assert.equal(exitCode, 0, `start-session failed\n${started.stderr}`);

      const saved = JSON.parse(
        await readFile(path.join(sessionDir, "session.json"), "utf8"),
      );
      const baseline = (saved.revisions || []).find(
        (revision) => revision.role === "baseline",
      );
      assert.ok(baseline, "start-session must record a baseline revision");
      assert.ok(
        baseline.inventory,
        "the baseline must name an inventory; without one nothing can be diffed",
      );

      const inventory = JSON.parse(
        await readFile(path.join(sessionDir, baseline.inventory), "utf8"),
      );
      const elements = inventory.states.flatMap((state) => state.elements);
      assert.ok(
        elements.length > 0,
        "the baseline inventory must contain the page's elements",
      );

      // The annotation has to hang off the revision being compared, or the
      // review has nothing to show.
      const round = (saved.rounds || []).find(
        (candidate) => candidate.toRevision === baseline.id,
      );
      assert.ok(round, "the baseline must be reachable as a round's target");
      assert.equal(
        (round.annotations || []).length,
        1,
        "the user's annotation must be attached to the baseline revision",
      );

      // -------------------------------------------------- simulate the edit
      const html = await readFile(path.join(siteDir, "index.html"), "utf8");
      await writeFile(
        path.join(siteDir, "index.html"),
        html.replace(
          "</head>",
          "<style>#count-button { padding: 28px 60px; font-size: 22px; }</style></head>",
        ),
      );

      // ---------------------------------------------------------- review it
      const review = run("review-session.mjs", ["--session", sessionDir]);
      const reviewExit = await new Promise((resolve) =>
        review.child.on("exit", resolve),
      );
      assert.equal(
        reviewExit,
        0,
        `review-session failed\n${review.stdout}\n${review.stderr}`,
      );
      assert.match(
        review.stdout,
        /对比 rev-001 -> rev-002，涉及 1 条标注/,
        "the review must compare the baseline against the result, with the annotation",
      );
      const summary = /变更汇总：(\{.*\})/.exec(review.stdout);
      assert.ok(summary, "the review must report a diff summary");
      assert.ok(
        JSON.parse(summary[1]).annotations >= 1,
        "the diff must attribute the annotation",
      );
    } finally {
      try {
        client?.close();
      } catch {
        // The socket is already gone.
      }
      started?.child.kill("SIGTERM");
      server.close();
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  },
);
