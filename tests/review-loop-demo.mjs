#!/usr/bin/env node

// End-to-end demonstration of the review loop on a local fixture.
//
//   baseline capture -> agent-style edit -> result capture -> diff
//   -> verdicts -> review preview -> consolidated next request
//
// Everything runs locally. Chrome is launched headless by capture-revision.mjs.

import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SCRIPTS = path.join(ROOT, "annotate-web-ui", "scripts");
const FIXTURE = path.join(HERE, "fixture", "review-app");

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

function runNode(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS, script), ...args], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with ${code}`));
    });
  });
}

function startServer(root) {
  const server = http.createServer(async (request, response) => {
    const relative = request.url === "/" ? "/index.html" : request.url.split("?")[0];
    try {
      const body = await readFile(path.join(root, relative));
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store, must-revalidate",
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

const baselineAnnotations = [
  {
    id: "A1",
    revisionId: "rev-001",
    stateId: "s1",
    kind: "element",
    geometry: { x: 32, y: 90, width: 380, height: 190 },
    target: {
      testId: "card-aurora",
      selector: '[data-testid="card-aurora"]',
      sourceFile: "src/components/ProductCard.tsx",
      sourceLine: 12,
      componentName: "ProductCard",
      reuseCount: 3,
    },
    intent: {
      operations: ["style"],
      expected: "卡片圆角从 12px 改到 4px，让整体更硬朗",
      scope: "repeated",
      breakpoint: "all",
      priority: "must",
      invariants: "卡片内容、间距和层级不变",
    },
  },
  {
    id: "A2",
    revisionId: "rev-001",
    stateId: "s1",
    kind: "element",
    geometry: { x: 48, y: 240, width: 120, height: 36 },
    target: {
      selector: "button.primary",
      sourceFile: "src/components/ProductCard.tsx",
      sourceLine: 18,
      componentName: "ProductCard",
      reuseCount: 3,
    },
    intent: {
      operations: ["style"],
      expected: "主按钮换成品牌绿 #0f6e56，并改为全圆角胶囊形",
      scope: "repeated",
      breakpoint: "all",
      priority: "must",
      invariants: "按钮文案与点击行为不变",
    },
  },
  {
    id: "A3",
    revisionId: "rev-001",
    stateId: "s1",
    kind: "element",
    geometry: { x: 440, y: 90, width: 380, height: 190 },
    target: {
      testId: "card-lumen",
      selector: '[data-testid="card-lumen"]',
      sourceFile: "src/components/ProductCard.tsx",
      sourceLine: 12,
      componentName: "ProductCard",
      reuseCount: 1,
    },
    intent: {
      operations: ["remove"],
      expected: "下架「流明台灯」，从列表里移除这张卡片",
      scope: "element",
      breakpoint: "all",
      priority: "must",
      invariants: "其余卡片顺序与内容不变",
    },
  },
  {
    id: "A4",
    revisionId: "rev-001",
    stateId: "s1",
    kind: "element",
    geometry: { x: 48, y: 200, width: 90, height: 30 },
    target: {
      selector: ".price",
      sourceFile: "src/components/ProductCard.tsx",
      sourceLine: 16,
      componentName: "ProductCard",
      reuseCount: 3,
    },
    intent: {
      operations: ["style"],
      expected: "价格字号加大到 22px 以上，作为视觉焦点",
      scope: "repeated",
      breakpoint: "all",
      priority: "must",
      invariants: "价格数值不变",
    },
  },
  {
    id: "A5",
    revisionId: "rev-001",
    stateId: "s1",
    kind: "element",
    geometry: { x: 32, y: 90, width: 1216, height: 190 },
    target: {
      selector: ".grid",
      sourceFile: "src/pages/Products.tsx",
      sourceLine: 21,
      componentName: "ProductGrid",
      reuseCount: 1,
    },
    intent: {
      operations: ["layout"],
      expected: "卡片之间的间距从 16px 加大到 24px",
      scope: "element",
      breakpoint: "all",
      priority: "should",
      invariants: "三列布局保持不变",
    },
  },
];

// What a reviewer would produce in review.html: a few verdict overrides plus
// two fresh annotations drawn on the result revision.
const reviewOutput = {
  schemaVersion: "1.2",
  roundId: "R1",
  source: "review-ui",
  verdicts: [
    { annotationId: "A1", status: "satisfied", confidence: "high", clusters: [], evidence: [], note: "", source: "review-ui" },
    { annotationId: "A2", status: "satisfied", confidence: "high", clusters: [], evidence: [], note: "", source: "review-ui" },
    { annotationId: "A3", status: "satisfied", confidence: "high", clusters: [], evidence: [], note: "", source: "review-ui" },
    { annotationId: "A4", status: "partial", confidence: "high", clusters: [], evidence: [], note: "字号确实变大了，但和标题的层级差还不够明显，再加大到 26px", source: "review-ui" },
    { annotationId: "A5", status: "satisfied", confidence: "high", clusters: [], evidence: [], note: "", source: "review-ui" },
  ],
  annotations: [
    {
      id: "F1",
      revisionId: "rev-002",
      stateId: "s1",
      kind: "element",
      geometry: { x: 32, y: 90, width: 372, height: 178 },
      target: {
        testId: "card-aurora",
        selector: '[data-testid="card-aurora"]',
        sourceFile: "src/components/ProductCard.tsx",
        sourceLine: 12,
        componentName: "ProductCard",
        reuseCount: 3,
      },
      manipulation: {
        mode: "resize",
        before: { x: 32, y: 90, width: 380, height: 190 },
        after: { x: 32, y: 90, width: 372, height: 178 },
        delta: { x: 0, y: 0, width: -8, height: -12 },
      },
      intent: {
        operations: ["layout"],
        expected: "卡片高度收紧一点，去掉底部多余的留白",
        scope: "repeated",
        breakpoint: "all",
        priority: "must",
        invariants: "卡片内元素不被裁切",
      },
    },
    {
      id: "F2",
      revisionId: "rev-002",
      stateId: "s1",
      kind: "element",
      geometry: { x: 32, y: 90, width: 1216, height: 190 },
      target: { selector: ".grid", sourceFile: "src/pages/Products.tsx", sourceLine: 21, componentName: "ProductGrid", reuseCount: 1 },
      batch: ["card-aurora", "card-verde", "card-slate"],
      intent: {
        operations: ["style"],
        expected: "三张卡片的描边统一改成 1px solid rgba(0,0,0,.08)，现在偏重",
        scope: "repeated",
        breakpoint: "all",
        priority: "should",
        invariants: "卡片阴影与圆角不变",
      },
    },
  ],
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.out || path.join(ROOT, ".workbuddy-ai", "demo", "review-loop"));
  await rm(outDir, { recursive: true, force: true });
  const sessionDir = path.join(outDir, "session");
  const serveDir = path.join(outDir, "served");
  await mkdir(serveDir, { recursive: true });

  const beforePath = path.join(FIXTURE, "before", "index.html");
  const afterPath = path.join(FIXTURE, "after", "index.html");
  await copyFile(beforePath, path.join(serveDir, "index.html"));

  const { server, port } = await startServer(serveDir);
  const url = `http://127.0.0.1:${port}/`;
  console.log(`演示服务：${url}\n`);

  try {
    console.log("=== 1/4 抓取基线 revision ===");
    await runNode("capture-revision.mjs", [
      "--session", sessionDir,
      "--role", "baseline",
      "--url", url,
      "--viewport", "1280x800",
      "--state-title", "产品列表",
    ]);

    console.log("\n=== 2/4 写入首轮标注（模拟上一轮复审） ===");
    const sessionFile = path.join(sessionDir, "session.json");
    const session = JSON.parse(await readFile(sessionFile, "utf8"));
    session.rounds.push({
      id: "R0",
      index: 0,
      fromRevision: null,
      toRevision: "rev-001",
      closedAt: new Date().toISOString(),
      annotations: baselineAnnotations,
      diff: null,
      verdicts: [],
      reviewAnnotations: [],
      consolidatedRequest: null,
    });
    await writeFile(sessionFile, `${JSON.stringify(session, null, 2)}\n`, "utf8");
    console.log(`写入了 ${baselineAnnotations.length} 条标注：${baselineAnnotations.map((a) => a.id).join("、")}`);

    console.log("\n=== 3/4 模拟 agent 改完代码（切换站点内容） ===");
    await copyFile(afterPath, path.join(serveDir, "index.html"));
    console.log("已把页面切换到修改后版本。");

    console.log("\n=== 4/4 重新抓取、对比、生成复审预览 ===");
    await runNode("review-session.mjs", ["--session", sessionDir]);

    console.log("\n=== 追加：模拟复审界面回传的判定与新标注 ===");
    const roundDir = path.join(sessionDir, "rounds", "R1");
    await writeFile(
      path.join(roundDir, "review-annotations.json"),
      `${JSON.stringify(reviewOutput, null, 2)}\n`,
      "utf8",
    );
    await runNode("consolidate-review.mjs", ["--session", sessionDir]);

    console.log(`\n演示产物目录：${outDir}`);
    console.log(`复审预览：${path.join(roundDir, "review", "review.html")}`);
    console.log(`变更请求：${path.join(roundDir, "change-request-R2.md")}`);
  } finally {
    server.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
