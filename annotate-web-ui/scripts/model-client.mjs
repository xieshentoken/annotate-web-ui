#!/usr/bin/env node

// The judgement layer.
//
// Evidence is produced deterministically by revision-diff.mjs. Turning that
// evidence into verdicts and a next change request is a judgement call, and
// this module makes that call pluggable:
//
//   host-agent  the current session's agent reads review-input.json and writes
//               review-output.json. No credential, no extra cost. Default.
//   byok        call a provider directly with the user's own key.
//
// Both modes produce the same review-output.json, so nothing downstream needs
// to know which one ran.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig, redact, resolveCredential } from "./lib/config.mjs";
import { loadSession, readJson, writeJson } from "./lib/session.mjs";
import { proposeVerdicts, verdictSummary } from "./lib/verdicts.mjs";

export const VERDICT_SCHEMA = {
  task: "verdicts",
  verdicts: [
    {
      annotationId: "A1",
      status: "satisfied | partial | violated | unverified",
      confidence: "high | medium | low",
      clusters: ["c1"],
      evidence: ["borderRadius 12px -> 4px on src/components/Card.tsx:42"],
      note: "short explanation",
    },
  ],
};

export function buildReviewInput({ session, round, diff, annotations }) {
  const clusters = (diff?.states || []).flatMap((state) =>
    state.clusters.map((cluster) => ({
      id: cluster.id,
      stateId: cluster.stateId,
      kinds: cluster.kinds,
      key: cluster.key,
      anchor: cluster.anchor,
      selector: cluster.selector,
      testId: cluster.testId,
      label: cluster.label,
      delta: cluster.delta,
      relatedAnnotations: cluster.relatedAnnotations,
      unstable: cluster.unstable === true,
    })),
  );

  return {
    task: "verdicts",
    schemaVersion: "1.2",
    sessionId: session.sessionId,
    roundId: round.id,
    fromRevision: round.fromRevision,
    toRevision: round.toRevision,
    targetUrl: session.targetUrl,
    summary: diff?.summary || null,
    missingStates: diff?.missingStates || [],
    annotations: annotations.map((annotation) => ({
      id: annotation.id,
      stateId: annotation.stateId,
      kind: annotation.kind,
      target: annotation.target
        ? {
            testId: annotation.target.testId,
            selector: annotation.target.selector,
            anchor: annotation.target.anchor,
            reuseCount: annotation.target.reuseCount,
          }
        : null,
      intent: annotation.intent,
      manipulation: annotation.manipulation || null,
    })),
    clusters,
    instructions: [
      "For every annotation, decide whether the result revision delivered what the annotation asked for.",
      "A verdict must cite at least one cluster id, or state explicitly why no cluster could be attributed.",
      "Use satisfied only when the requested change is visibly present.",
      "Use partial when some of the requested change is present, or when the change landed but not as described.",
      "Use violated when the region changed in a way that contradicts the request.",
      "Use unverified when the evidence is insufficient. Do not guess.",
      "Treat clusters whose unstable flag is true as weak evidence and lower the confidence.",
      "Reply with JSON only, matching the verdict schema exactly. No prose outside the JSON.",
    ],
  };
}

function verdictPrompt(input) {
  return [
    "You are reviewing whether a coding agent's UI change matched what a reviewer asked for.",
    "",
    "You receive:",
    "- annotations: what the reviewer asked for, each with an id and an expected result.",
    "- clusters: what actually changed between the before and after revision, measured from the DOM.",
    "",
    "Return JSON only:",
    JSON.stringify(VERDICT_SCHEMA, null, 2),
    "",
    "Evidence:",
    JSON.stringify(input, null, 2),
  ].join("\n");
}

function extractJson(text) {
  const trimmed = String(text || "").trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("response contained no JSON object");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

async function callOpenAi({ model, apiKey, prompt, signal }) {
  const response = await fetch(`${model.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model.model,
      max_tokens: model.maxOutputTokens,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You return strict JSON. No prose." },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`provider returned ${response.status}: ${(await response.text()).slice(0, 400)}`);
  }
  const payload = await response.json();
  return payload.choices?.[0]?.message?.content || "";
}

async function callAnthropic({ model, apiKey, prompt, signal }) {
  const response = await fetch(`${model.baseUrl.replace(/\/$/, "")}/messages`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: model.model,
      max_tokens: model.maxOutputTokens,
      temperature: 0,
      system: "You return strict JSON. No prose.",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) {
    throw new Error(`provider returned ${response.status}: ${(await response.text()).slice(0, 400)}`);
  }
  const payload = await response.json();
  const blocks = payload.content || [];
  return blocks.map((block) => block.text || "").join("");
}

export function fallbackVerdicts(annotations, diff, reason) {
  const heuristic = proposeVerdicts(diff, annotations);
  return heuristic.map((verdict) => ({
    ...verdict,
    note: `${verdict.note} 模型判定不可用（${reason}），此结果来自确定性 diff。`.trim(),
    source: "heuristic",
  }));
}

export async function requestVerdicts({ config, input, credential, secrets = [] }) {
  const model = config.review.model;
  const prompt = verdictPrompt(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), model.timeoutMs);
  try {
    const call = model.style === "anthropic" ? callAnthropic : callOpenAi;
    let text = await call({
      model,
      apiKey: credential.apiKey,
      prompt,
      signal: controller.signal,
    });
    try {
      return extractJson(text);
    } catch (firstError) {
      text = await call({
        model,
        apiKey: credential.apiKey,
        prompt: `${prompt}\n\nYour previous reply could not be parsed: ${firstError.message}. Reply with a single JSON object and nothing else.`,
        signal: controller.signal,
      });
      return extractJson(text);
    }
  } catch (error) {
    throw new Error(redact(error.message, secrets));
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeVerdicts(payload, annotations, source) {
  const list = Array.isArray(payload) ? payload : payload?.verdicts || [];
  const byId = new Map(list.map((item) => [item.annotationId, item]));
  return annotations.map((annotation) => {
    const found = byId.get(annotation.id);
    if (!found) {
      return {
        annotationId: annotation.id,
        status: "unverified",
        confidence: "low",
        clusters: [],
        evidence: [],
        note: "判定结果里缺少这一条标注。",
        source,
      };
    }
    const status = ["satisfied", "partial", "violated", "unverified"].includes(found.status)
      ? found.status
      : "unverified";
    return {
      annotationId: annotation.id,
      status,
      confidence: ["high", "medium", "low"].includes(found.confidence) ? found.confidence : "medium",
      clusters: Array.isArray(found.clusters) ? found.clusters : [],
      evidence: Array.isArray(found.evidence) ? found.evidence.map(String) : [],
      note: String(found.note || ""),
      source,
    };
  });
}

export function hostAgentInstructions(inputPath, outputPath, annotations) {
  return [
    "# 判定任务（host-agent 模式）",
    "",
    `请阅读 ${inputPath}，对其中每一条标注判断修改是否达成，并把结果写入 ${outputPath}。`,
    "",
    "输出必须是严格 JSON，形如：",
    "",
    "```json",
    JSON.stringify(
      {
        task: "verdicts",
        verdicts: annotations.map((annotation, index) => ({
          annotationId: annotation.id,
          status: index === 0 ? "satisfied" : "partial",
          confidence: "high",
          clusters: [],
          evidence: ["引用 cluster 的 label"],
          note: "简述判断依据",
        })),
      },
      null,
      2,
    ),
    "```",
    "",
    "规则：",
    "",
    "- 每条判定至少引用一个 cluster id，或明确说明为什么无法归因。",
    "- 只有确实看到了要求的改动才给 satisfied。",
    "- 证据不足时给 unverified，不要猜。",
    "- clusters 里 unstable 为 true 的属于弱证据，应降低 confidence。",
    "- 只输出 JSON，不要任何额外文字。",
    "",
  ].join("\n");
}

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.session || !args.round) {
    throw new Error("Usage: model-client.mjs --session <dir> --round <roundId> [--diff <diff.json>] [--input <review-input.json>]");
  }
  const { dir, session } = await loadSession(args.session);
  const round = session.rounds.find((item) => item.id === args.round);
  if (!round) throw new Error(`Round ${args.round} not found in ${dir}`);

  const inputPath = args.input
    ? path.resolve(args.input)
    : path.join(dir, "rounds", round.id, "review-input.json");

  let input;
  if (await readJson(inputPath, null)) {
    input = await readJson(inputPath);
  } else {
    const diff = await readJson(
      path.join(dir, "rounds", round.id, "diff.json"),
      null,
    );
    if (!diff) throw new Error(`No diff found for round ${round.id}. Run review-session.mjs first.`);
    input = buildReviewInput({ session, round, diff, annotations: round.annotations });
    await writeJson(inputPath, input);
  }

  const outputPath = path.join(dir, "rounds", round.id, "review-output.json");
  const { config, sources } = await loadConfig({ repoPath: session.repoPath });
  const mode = config.review.model.mode;

  console.log(`配置来源：${sources.length ? sources.join("、") : "内置默认"}`);
  console.log(`判定模式：${mode}`);

  if (mode !== "byok") {
    const instructionsPath = path.join(dir, "rounds", round.id, "verdict-task.md");
    await writeFile(
      instructionsPath,
      hostAgentInstructions(inputPath, outputPath, round.annotations),
      "utf8",
    );
    console.log("SYMBUI_VERDICT_MODE=host-agent");
    console.log(`SYMBUI_REVIEW_INPUT=${inputPath}`);
    console.log(`SYMBUI_VERDICT_TASK=${instructionsPath}`);
    console.log(`SYMBUI_REVIEW_OUTPUT=${outputPath}`);
    console.log(
      "由当前会话的 agent 阅读 review-input.json 并写出 review-output.json；本步骤不消耗额外密钥。",
    );
    return;
  }

  let verdicts;
  let source = "byok";
  try {
    const credential = await resolveCredential(config, { repoPath: session.repoPath });
    console.log(`凭据来源：${credential.source}`);
    const payload = await requestVerdicts({
      config,
      input,
      credential,
      secrets: [credential.apiKey],
    });
    verdicts = normalizeVerdicts(payload, round.annotations, "byok");
  } catch (error) {
    console.warn(`WARN: byok 判定失败，降级到确定性 diff：${error.message}`);
    source = "heuristic";
    verdicts = fallbackVerdicts(round.annotations, await readJson(path.join(dir, "rounds", round.id, "diff.json"), null), "byok 不可用");
  }

  await writeJson(outputPath, { task: "verdicts", verdicts, source });
  console.log(`SYMBUI_REVIEW_OUTPUT=${outputPath}`);
  console.log(JSON.stringify(verdictSummary(verdicts), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
