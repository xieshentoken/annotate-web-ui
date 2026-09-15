#!/usr/bin/env node

// Orchestrates one review round:
//
//   capture result revision -> diff -> propose verdicts -> build preview
//
// The preview is served on loopback so review.html can POST the reviewer's
// decisions back. Nothing leaves the machine: the server binds 127.0.0.1, and
// the only write endpoint is the round's own review-annotations.json.

import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadConfig, publicConfig } from "./lib/config.mjs";
import { diffInventories } from "./revision-diff.mjs";
import { serveReviewDir } from "./serve-review.mjs";
import {
  annotationsForRevision,
  comparableRevision,
  loadSession,
  nextRoundId,
  readJson,
  revisionById,
  saveSession,
  SCHEMA_VERSION,
  writeJson,
} from "./lib/session.mjs";
import { proposeVerdicts, verdictSummary } from "./lib/verdicts.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = path.resolve(SCRIPT_DIR, "../assets");

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

async function runNode(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(scriptPath)} exited with ${code}`));
    });
  });
}

function revisionStateMap(revision) {
  const map = new Map();
  for (const state of revision?.states || []) map.set(state.id, state);
  return map;
}

async function buildPreview({ session, sessionDir, round, fromRevision, toRevision, diff, verdicts, config }) {
  const roundDir = path.join(sessionDir, "rounds", round.id);
  const reviewDir = path.join(roundDir, "review");
  await mkdir(path.join(reviewDir, "before"), { recursive: true });
  await mkdir(path.join(reviewDir, "after"), { recursive: true });

  const fromStates = revisionStateMap(fromRevision);
  const toStates = revisionStateMap(toRevision);
  const fromInventory = await readJson(path.join(sessionDir, fromRevision.inventory));
  const toInventory = await readJson(path.join(sessionDir, toRevision.inventory));

  const states = [];
  for (const stateDiff of diff.states) {
    const stateId = stateDiff.stateId;
    const beforeState = fromStates.get(stateId);
    const afterState = toStates.get(stateId);
    if (!beforeState || !afterState) continue;

    const beforeTarget = path.join(reviewDir, "before", `${stateId}.png`);
    const afterTarget = path.join(reviewDir, "after", `${stateId}.png`);
    await copyFile(path.join(sessionDir, beforeState.beforeImage), beforeTarget);
    await copyFile(path.join(sessionDir, afterState.beforeImage), afterTarget);

    const beforeElements = (fromInventory.states.find((item) => item.stateId === stateId) || {}).elements || [];
    const afterElements = (toInventory.states.find((item) => item.stateId === stateId) || {}).elements || [];

    states.push({
      stateId,
      title: afterState.title || stateId,
      description: afterState.description || "",
      viewport: afterState.viewport,
      before: { image: `before/${stateId}.png`, elements: beforeElements },
      after: { image: `after/${stateId}.png`, elements: afterElements },
      clusters: stateDiff.clusters,
      summary: stateDiff.summary,
    });
  }

  const bundle = {
    schemaVersion: SCHEMA_VERSION,
    sessionId: session.sessionId,
    roundId: round.id,
    fromRevision: fromRevision.id,
    toRevision: toRevision.id,
    repoPath: session.repoPath,
    targetUrl: session.targetUrl,
    model: publicConfig(config).review.model,
    maxRounds: config.review.maxRounds,
    states,
    annotations: round.annotations,
    verdicts,
    diffSummary: diff.summary,
    missingStates: diff.missingStates,
  };

  await writeJson(path.join(reviewDir, "review.json"), bundle);
  await copyFile(path.join(ASSET_DIR, "review.html"), path.join(reviewDir, "review.html"));

  return { roundDir, reviewDir, bundle };
}

// Serve the preview and finish as soon as the reviewer saves, so the skill can
// continue without a second prompt.
async function serve(reviewDir, savePath) {
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  let running;
  running = await serveReviewDir(reviewDir, {
    onSave: async (payload) => {
      await writeJson(savePath, payload);
      console.log(`SYMBUI_REVIEW_SAVED=${savePath}`);
      console.log(
        `保存了 ${payload.annotations?.length || 0} 条新标注、${payload.verdicts?.length || 0} 条判定。`,
      );
      await running.close();
      finish({ saved: true });
    },
  });
  console.log(`SYMBUI_REVIEW_URL=${running.url}`);
  console.log("在浏览器里完成复审，点「保存复审结果」后本步骤自动结束。");
  const stop = async () => {
    console.log("\n复审服务已停止。");
    await running.close();
    finish({ saved: false });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return done;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.session) {
    throw new Error(
      "Usage: review-session.mjs --session <dir> [--no-capture] [--serve] [--url <url>] [--role result]",
    );
  }
  const { dir: sessionDir, session } = await loadSession(args.session);
  const { config, sources } = await loadConfig({ repoPath: session.repoPath });
  session.config = publicConfig(config);
  session.schemaVersion = SCHEMA_VERSION;

  // A round with no result revision is pending: consolidate-review.mjs opened
  // it, and this run is the one that captures what the agent changed.
  const pending = session.rounds.find((round) => !round.toRevision) || null;
  const fromRevision = pending
    ? revisionById(session, pending.fromRevision)
    : comparableRevision(session);
  if (!fromRevision) throw new Error("会话里没有可对比的 revision，先跑 capture-revision.mjs。");

  const { id: roundId, index } = pending ? { id: pending.id, index: pending.index } : nextRoundId(session);
  const roundDir = path.join(sessionDir, "rounds", roundId);

  if (!args["no-capture"]) {
    console.log(`抓取改动后的 revision（对比基线 ${fromRevision.id}）...`);
    await runNode(path.join(SCRIPT_DIR, "capture-revision.mjs"), [
      "--session", sessionDir,
      "--role", "result",
      ...(args.url ? ["--url", args.url] : []),
      ...(args.chrome ? ["--chrome", args.chrome] : []),
      ...(args["cdp-port"] ? ["--cdp-port", String(args["cdp-port"])] : []),
    ]);
  }

  const refreshed = await loadSession(sessionDir);
  session.revisions = refreshed.session.revisions;
  const toRevision = session.revisions[session.revisions.length - 1];
  if (toRevision.id === fromRevision.id) {
    throw new Error("没有新的 revision，抓取可能失败了。");
  }

  const fromInventory = await readJson(path.join(sessionDir, fromRevision.inventory));
  const toInventory = await readJson(path.join(sessionDir, toRevision.inventory));

  const annotations = pending
    ? pending.annotations || []
    : annotationsForRevision(session, fromRevision.id);

  console.log(`对比 ${fromRevision.id} -> ${toRevision.id}，涉及 ${annotations.length} 条标注`);
  const diff = diffInventories({
    fromInventory,
    toInventory,
    fromRevision: fromRevision.id,
    toRevision: toRevision.id,
    annotations,
    tolerance: config.review.pixelTolerance,
  });

  await mkdir(roundDir, { recursive: true });
  await writeJson(path.join(roundDir, "diff.json"), diff);

  const round = pending || {
    id: roundId,
    index,
    fromRevision: fromRevision.id,
    toRevision: null,
    closedAt: null,
    annotations,
    diff: null,
    verdicts: [],
    reviewAnnotations: [],
    consolidatedRequest: null,
  };
  round.toRevision = toRevision.id;
  round.closedAt = new Date().toISOString();
  round.annotations = annotations;
  round.diff = {
    path: path.relative(sessionDir, path.join(roundDir, "diff.json")).split(path.sep).join("/"),
    summary: diff.summary,
  };
  round.verdicts = proposeVerdicts(diff, annotations, {
    tolerance: config.review.pixelTolerance,
  });
  round.status = "reviewed";

  const preview = await buildPreview({
    session, sessionDir, round, fromRevision, toRevision, diff,
    verdicts: round.verdicts, config,
  });

  if (!pending) session.rounds.push(round);
  await saveSession(sessionDir, session);

  console.log(`SYMBUI_ROUND=${round.id}`);
  console.log(`SYMBUI_DIFF=${path.join(roundDir, "diff.json")}`);
  console.log(`SYMBUI_REVIEW_DIR=${preview.reviewDir}`);
  console.log(`变更汇总：${JSON.stringify(diff.summary)}`);
  console.log(`判定建议：${JSON.stringify(verdictSummary(round.verdicts))}`);
  if (sources.length) console.log(`配置来源：${sources.join("、")}`);

  const attention = round.verdicts.filter((verdict) => verdict.status !== "satisfied");
  if (attention.length) {
    console.log("需要人工确认的标注：");
    for (const verdict of attention) {
      console.log(`  ${verdict.annotationId} [${verdict.status}] ${verdict.note || verdict.evidence[0] || ""}`);
    }
  }

  if (args.serve) {
    const result = await serve(
      preview.reviewDir,
      path.join(roundDir, "review-annotations.json"),
    );
    console.log(`SYMBUI_REVIEW_SAVED_FLAG=${result.saved}`);
    console.log("下一步：node scripts/consolidate-review.mjs --session <dir> --round " + round.id);
  } else {
    console.log(`打开 ${path.join(preview.reviewDir, "review.html")} 查看对比（需与 review.json 同目录并通过本地服务访问）。`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
