#!/usr/bin/env node

// Closes a review round and opens the next one.
//
// The consolidated request contains only the delta: annotations that were not
// satisfied, plus whatever the reviewer drew on the result revision. Satisfied
// annotations are listed as closed and dropped. Conflicts are surfaced, never
// silently resolved — if two instructions contradict each other, a human
// decides, not this script.

import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "./lib/config.mjs";
import {
  loadSession,
  nextRoundId,
  readJson,
  saveSession,
  SCHEMA_VERSION,
} from "./lib/session.mjs";
import { collectSourceFiles } from "./lib/source-files.mjs";
import {
  anchorCoverage,
  describeCandidate,
  resolverFacts,
  resolveAnnotation,
  sourceResolutionWarning,
} from "./lib/source-resolve.mjs";
import { collectLocaleFiles, createSymbolIndex } from "./lib/symbol-index.mjs";
import { verdictSummary } from "./lib/verdicts.mjs";

const OPERATION_LABELS = {
  layout: "布局",
  style: "样式",
  content: "内容",
  interaction: "交互",
  add: "新增",
  remove: "删除",
  fix: "问题修复",
};
const SCOPE_LABELS = { element: "仅此元素", repeated: "同组件全部", page: "整页" };
const BREAKPOINT_LABELS = { all: "全部断点", current: "仅当前", desktop: "桌面", tablet: "平板", mobile: "手机" };
const STATUS_LABELS = { satisfied: "已达成", partial: "部分达成", violated: "未达成", unverified: "未验证" };

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

function targetKey(annotation) {
  const target = annotation.target || {};
  if (target.sourceFile) return `src:${target.sourceFile}:${target.sourceLine || 0}`;
  if (target.testId) return `testid:${target.testId}`;
  if (target.selector) return `sel:${target.selector}`;
  const geometry = annotation.geometry || {};
  return `geo:${Math.round(geometry.x || 0)},${Math.round(geometry.y || 0)}`;
}

/* The position an annotation *claims*, which is not the same as a position
 * that was verified. When the claim failed verification the reason is printed
 * beside it, so the request cannot say `src/ProductCard.tsx:16` on one line
 * and "no candidate found" on another.
 */
function targetLabel(annotation) {
  const target = annotation.target || {};
  if (target.sourceFile) {
    const where = `${target.sourceFile}:${target.sourceLine || "?"}`;
    return annotation.sourceMetadataRejected
      ? `${where}（未通过校验：${annotation.sourceMetadataRejected}）`
      : where;
  }
  if (target.testId) return `[data-testid="${target.testId}"]`;
  if (target.selector) return target.selector;
  return "（无稳定定位）";
}

function operationsLabel(annotation) {
  const list = annotation.intent?.operations || [];
  return list.map((value) => OPERATION_LABELS[value] || value).join("、") || "未指定";
}

// Two instructions conflict when they act on the same target in opposite
// directions. Everything else is left alone: near-duplicates are reported, not
// merged, so the reviewer stays in control.
export function detectConflicts(annotations) {
  const groups = new Map();
  for (const annotation of annotations) {
    const key = targetKey(annotation);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(annotation);
  }

  const conflicts = [];
  const duplicates = [];
  for (const [key, group] of groups) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i];
        const b = group[j];
        const da = a.manipulation?.delta;
        const db = b.manipulation?.delta;
        if (da && db) {
          const opposite =
            (da.x && db.x && Math.sign(da.x) !== Math.sign(db.x)) ||
            (da.y && db.y && Math.sign(da.y) !== Math.sign(db.y)) ||
            (da.width && db.width && Math.sign(da.width) !== Math.sign(db.width)) ||
            (da.height && db.height && Math.sign(db.height) !== Math.sign(db.height));
          if (opposite) {
            conflicts.push({
              key,
              ids: [a.id, b.id],
              reason: `同一目标上的位移或尺寸方向相反（${a.id}: Δ${da.x},${da.y},${da.width},${da.height}；${b.id}: Δ${db.x},${db.y},${db.width},${db.height}）`,
            });
            continue;
          }
        }
        const sameOps =
          JSON.stringify([...(a.intent?.operations || [])].sort()) ===
          JSON.stringify([...(b.intent?.operations || [])].sort());
        const sameExpected =
          (a.intent?.expected || "").trim() === (b.intent?.expected || "").trim();
        if (sameOps && sameExpected && sameExpected) {
          duplicates.push({ key, ids: [a.id, b.id] });
        }
      }
    }
  }
  return { conflicts, duplicates };
}

function uniqueIds(annotations) {
  const used = new Set();
  return annotations.map((annotation) => {
    let id = annotation.id;
    let suffix = 2;
    while (used.has(id)) {
      id = `${annotation.id}-${suffix}`;
      suffix += 1;
    }
    used.add(id);
    return { ...annotation, id };
  });
}
/* 轮次折叠时分组要跟着成员走：已判定达成的标注不再需要改动，必须从成员里移除；
 * 成员被删空的组直接丢弃。`cohesion` 原样保留 —— 它是用户当初框选时算出的事实，
 * 按剩下的成员重算会悄悄换掉用户真正要的那条指令。 */
export function pruneGroups(groups, closedIds) {
  const closed = new Set(closedIds);
  const kept = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    if (!group || !Array.isArray(group.annotationIds)) {
      kept.push(group);
      continue;
    }
    const remaining = group.annotationIds.filter((id) => !closed.has(id));
    if (remaining.length === 0) continue;
    kept.push({ ...group, annotationIds: remaining });
  }
  return kept;
}

/* 锚点覆盖率。只有编译期的 `data-ui-source` 元数据能让候选升到 `exact`；没有它时
 * 每个目标都只是文本推导的候选，写清楚比让读者自己翻候选列表要好。
 * `orphanedMetadata` 单独计数：「装了注入器但文件挪走了」和「根本没装注入器」
 * 需要完全不同的处置，混为一谈会把读者引去重装已经装好的东西。 */
function anchorCoverageSection(annotations) {
  const { total, anchored, orphanedMetadata } = anchorCoverage(annotations);
  if (total === 0) return [];
  if (anchored === total) {
    return [`- 编译期锚点：全部 ${total} 条标注均由 \`data-ui-source\` 元数据解析`];
  }
  return [
    anchored === 0
      ? "- 编译期锚点：无 —— 没有任何候选取自 `data-ui-source` 元数据，下面每个目标都是文本推导的候选，而不是用户实际指到的那个元素"
      : `- 编译期锚点：${anchored}/${total} 条由 \`data-ui-source\` 元数据解析，其余是文本推导的候选`,
    orphanedMetadata > 0
      ? `  - 有 ${orphanedMetadata} 条标注带了 \`data-ui-source\` 元数据但未产出候选；所引用的文件可能已被移动或改名。`
      : "  - 接入仅开发期的注入器（`references/build-anchors.md`）才能把候选提升到 `exact`，也才能让差异对比区分「真实改动」和「兄弟元素整体位移」。",
  ];
}

/* Why this section exists: a resolver that silently degrades is worse than one
 * that fails. Without a `repoPath` there is no index at all; with a parser
 * that cannot load, every candidate is lexical and none can reach high
 * confidence. Either way the agent reading the change request has to be told
 * before it trusts a line number.
 */
function resolverSection(index, repoPath, annotations) {
  const lines = ["## Resolver", ""];
  if (!index) {
    lines.push(
      repoPath
        ? `- 未能建立源码索引（\`${repoPath}\` 不是可读目录）。下面的「目标」是标注自带的元数据，未经验证。`
        : "- 会话没有设置 `repoPath`，无法核验任何源码位置。下面的「目标」是标注自带的元数据，未经验证。",
    );
    lines.push("");
    return lines;
  }

  const facts = resolverFacts(index);
  if (facts.reason === "no-files") {
    lines.push("- 解析引擎：未索引到任何文件 —— 仓库根目录下没有找到可解析的源文件");
  } else if (facts.reason === "no-parser") {
    lines.push("- 解析引擎：仅词法扫描 —— 未找到 `@babel/parser`");
  } else if (facts.reason === "no-parse-success") {
    lines.push(
      `- 解析引擎：仅词法扫描 —— \`@babel/parser\` 已从 \`${facts.parserFrom}\` 加载，但没有文件解析成功`,
    );
  } else {
    lines.push(`- 解析引擎：AST（\`@babel/parser\` 来自 \`${facts.parserFrom}\`）`);
  }
  lines.push(
    `- 扫描文件：${facts.files} 个（AST 解析 ${facts.parsed}，词法扫描 ${facts.lexical}，解析失败 ${facts.failed}）`,
  );
  lines.push(`- 索引符号：${facts.sites} 个，覆盖 ${facts.elements} 个元素`);
  lines.push(
    facts.locales > 0
      ? `- 语言文件：${facts.locales} 个（${facts.i18nEntries} 条文案）；可见文本会先反查 i18n key 再检索源码`
      : "- 语言文件：无；可见文本按字面量直接检索源码",
  );
  if (facts.reason === "no-parser" && facts.failures.length > 0) {
    lines.push("- 解析器搜索路径：");
    for (const failure of facts.failures.slice(0, 5)) {
      lines.push(`  - ${failure}`);
    }
  }
  lines.push(...anchorCoverageSection(annotations));
  lines.push("");
  return lines;
}

const COHESION_LABELS = {
  container: "同一容器",
  component: "同一组件",
  mixed: "混合",
};

function groupMemberLabel(annotation, id) {
  return annotation?.alias ? `${id}（${annotation.alias}）` : id;
}

function groupContainerLabel(group) {
  const anchor = group.container?.anchor;
  if (anchor?.file) {
    return `\`${anchor.file}:${anchor.line ?? "?"}${anchor.component ? `（${anchor.component}）` : ""}\``;
  }
  if (group.containerKey) return `\`${group.containerKey}\``;
  return "共同的捕获祖先";
}

function groupComponentLabel(group, byId) {
  const ids = Array.isArray(group.annotationIds) ? group.annotationIds : [];
  for (const id of ids) {
    const annotation = byId.get(id);
    const component =
      annotation?.target?.componentName ||
      annotation?.sourceCandidates?.[0]?.element?.component;
    if (component) return component;
  }
  return null;
}

/* 分组只有在产物里写清楚才有意义，而措辞完全取决于 `cohesion`：能说「在这个容器
 * 内统一调整」时就说，不能时就逐个列出 —— 绝不留机会让 agent 自己编一个容器。 */
function groupsSection(session, annotations) {
  const groups = Array.isArray(session.groups) ? session.groups : [];
  if (groups.length === 0) return [];
  const byId = new Map(
    annotations.map((annotation) => [annotation.id, annotation]),
  );
  const lines = ["## Groups", ""];
  for (const group of groups) {
    const ids = Array.isArray(group.annotationIds) ? group.annotationIds : [];
    const label = COHESION_LABELS[group.cohesion]
      ? `${group.cohesion} / ${COHESION_LABELS[group.cohesion]}`
      : group.cohesion || "mixed";
    lines.push(`### ${group.name || group.id}（内聚：${label}）`, "");
    lines.push(
      `- 成员：${ids.map((id) => groupMemberLabel(byId.get(id), id)).join("、") || "（无）"}`,
    );
    if (group.cohesion === "container") {
      lines.push(
        `- 成员同属一个捕获到的容器 ${groupContainerLabel(group)}：可以要求「在这个容器内统一调整」，不必逐条重述。`,
      );
    } else if (group.cohesion === "component") {
      const component = groupComponentLabel(group, byId);
      lines.push(
        `- 成员没有共同祖先，但都落在同一个组件${component ? ` \`${component}\`` : ""}：按这个组件提出一次调整，不要改写成某个容器。`,
      );
    } else {
      lines.push(
        "- 成员既没有共同容器，也不属于同一个组件：必须逐个列出并逐个调整，禁止自行虚构一个容器把它们包起来。",
      );
    }
    lines.push("");
  }
  return lines;
}

function changeRequestMarkdown({ session, round, open, closed, fresh, deduped, conflicts, duplicates, unresolved, index, repoPath, nextRoundId: nextId, maxRounds, reachedLimit }) {
  const lines = [
    `# Web UI Change Request — ${nextId}`,
    "",
    `- 会话：\`${session.sessionId}\``,
    `- 仓库：\`${session.repoPath || "（未设置）"}\``,
    `- 目标：${session.targetUrl}`,
    `- 上一轮：${round.id}（${round.fromRevision} → ${round.toRevision}）`,
    `- 判定：${JSON.stringify(verdictSummary(round.verdicts))}`,
    "",
    ...resolverSection(index, repoPath, deduped),
  ];

  if (reachedLimit) {
    lines.push(
      `> 已达到 review.maxRounds = ${maxRounds}。本轮只汇总未解决项，不再自动开启下一轮。`,
      "",
    );
  }

  lines.push("## 上一轮结果", "");
  if (closed.length === 0) {
    lines.push("- 没有标注被判定为已达成。", "");
  } else {
    lines.push("以下标注已验证通过，本轮不再处理：", "");
    for (const annotation of closed) {
      lines.push(
        `- ~~${annotation.id}~~${annotation.alias ? `（${annotation.alias}）` : ""} ${annotation.intent?.expected || ""}`,
      );
    }
    lines.push("");
  }

  lines.push("## 本轮待改", "");
  if (open.length + fresh.length === 0) {
    lines.push("- 无。所有标注均已达成，且复审没有提出新意见。循环可以结束。", "");
  }

  const section = (title, list, note) => {
    if (list.length === 0) return;
    lines.push(`### ${title}`, "");
    if (note) lines.push(note, "");
    for (const annotation of list) {
      const alias = annotation.alias ? `（${annotation.alias}）` : "";
      lines.push(`#### ${annotation.id}${alias} — ${operationsLabel(annotation)}`, "");
      lines.push(`- 目标：\`${targetLabel(annotation)}\``);
      if (annotation.sourceCandidates?.length) {
        lines.push("- 源码候选：");
        for (const candidate of annotation.sourceCandidates) {
          lines.push(`  - ${describeCandidate(candidate)}`);
          if (candidate.evidence.length > 0) {
            lines.push(`    - 证据：${candidate.evidence.join("；")}`);
          }
        }
      } else if (index) {
        lines.push("- 源码候选：无可靠候选，需要人工从截图和选择器定位。");
      }
      if (annotation.target?.reuseCount != null) {
        lines.push(`- 复用范围：该目标在页面中出现 ${annotation.target.reuseCount} 处`);
      }
      lines.push(`- 期望结果：${annotation.intent?.expected || "（未填写）"}`);
      lines.push(`- 作用范围：${SCOPE_LABELS[annotation.intent?.scope] || annotation.intent?.scope || "仅此元素"}`);
      lines.push(`- 响应式：${BREAKPOINT_LABELS[annotation.intent?.breakpoint] || annotation.intent?.breakpoint || "全部断点"}`);
      lines.push(`- 优先级：${annotation.intent?.priority === "should" ? "建议" : "必须"}`);
      if (annotation.intent?.invariants) {
        lines.push(`- 不可改动：${annotation.intent.invariants}`);
      }
      if (annotation.manipulation) {
        const delta = annotation.manipulation.delta;
        lines.push(
          `- 直接操作：${annotation.manipulation.mode === "move" ? "拖动" : "缩放"}，Δx ${delta.x}、Δy ${delta.y}、Δw ${delta.width}、Δh ${delta.height}（CSS 像素）`,
        );
      }
      const verdict = round.verdicts.find((item) => item.annotationId === annotation.id);
      if (verdict && verdict.status !== "satisfied") {
        lines.push(`- 上轮判定：${STATUS_LABELS[verdict.status] || verdict.status}`);
        for (const line of verdict.evidence || []) lines.push(`  - 证据：${line}`);
        if (verdict.note) lines.push(`  - 说明：${verdict.note}`);
      }
      lines.push("");
    }
  };

  section("未达成或部分达成，需要继续改", open, "这些是上一轮标注中未通过的部分，附带了实际观测到的变更。");
  section("复审新增意见", fresh, "这些是在改动后的页面上直接标注或拖动产生的。");

  lines.push(...groupsSection(session, deduped));

  if (conflicts.length || duplicates.length || unresolved.length) {
    lines.push("## 需要人工裁决", "");
    for (const conflict of conflicts) {
      lines.push(`- 冲突：${conflict.ids.join(" 与 ")} — ${conflict.reason}`);
    }
    for (const duplicate of duplicates) {
      lines.push(`- 重复：${duplicate.ids.join(" 与 ")} 描述几乎相同，建议合并为一条。`);
    }
    for (const item of unresolved) {
      lines.push(`- 定位待确认：${item}`);
    }
    lines.push("");
    lines.push("这些条目在人工确认之前不要执行。", "");
  }

  lines.push("## 保护既有行为", "");
  lines.push("- 未被点名的交互、路由、数据流和组件行为必须保持不变。");
  lines.push("- 不要根据截图坐标推断未声明的需求。");
  lines.push("- 改动若涉及被多处复用的组件，必须说明影响范围。");
  lines.push("");
  lines.push("## 验收标准", "");
  for (const annotation of [...open, ...fresh]) {
    lines.push(`- [ ] ${annotation.id}${annotation.alias ? `（${annotation.alias}）` : ""}：${annotation.intent?.expected || "（未填写）"}`);
  }
  lines.push("- [ ] 在捕获的每个视口与状态下复核页面。");
  lines.push("");

  return lines.join("\n");
}

function implementationPrompt({ session, round, nextId, requestPath, inputPath, annotations, index }) {
  const lines = [
    "按证据驱动的 UI 变更请求修改本地 Web 应用。",
    "",
    `仓库：${session.repoPath || "（未设置）"}`,
    `目标 URL：${session.targetUrl}`,
    `变更请求：${requestPath}`,
    `结构化标注：${inputPath}`,
    "",
    `源码解析：${
      !index
        ? "未启用（会话没有可用的 repoPath），下面列出的位置只是候选描述"
        : index.engine === "ast"
          ? "基于 AST，元素、属性和声明都带精确位置"
          : "仅词法扫描，因此没有候选能达到 high 置信度"
    }。`,
    "",
    "要求：",
    "1. 先读变更请求、结构化标注和引用的截图，再动手。",
    "2. 每条源码位置都带 `confidence` 和 `resolver`；置信度不是 `high` 或 `exact` 时，先打开文件确认再改。",
    "3. 候选里的 `element` 字段给出所在元素和组件。若它与行号冲突，以元素为准并重新读文件。",
    "4. 只实现下面列出的编号条目，并保持每一条声明的不可改动项。",
    "5. 遇到冲突条目或证据不足，停下来报告，不要猜。",
    "6. 运行项目已有的相关检查，并在捕获的路由和视口上做视觉复核。",
    "",
    `编号条目（${nextId}）：`,
  ];
  for (const annotation of annotations) {
    const best = annotation.sourceCandidates?.[0];
    const where = best ? ` @ ${best.file}:${best.line}（${best.confidence}）` : "";
    lines.push(
      `- ${annotation.id}${annotation.alias ? `（${annotation.alias}）` : ""}${where}：${annotation.intent?.expected || "（未填写）"} [类型=${operationsLabel(annotation)}，范围=${
        SCOPE_LABELS[annotation.intent?.scope] || annotation.intent?.scope || "仅此元素"
      }，断点=${BREAKPOINT_LABELS[annotation.intent?.breakpoint] || annotation.intent?.breakpoint || "全部"}]`,
    );
  }

  lines.push(...groupsSection(session, annotations));
  lines.push("");
  lines.push("完成后由复审流程重新抓取同一组状态，逐条核对，不需要你自证完成。");
  lines.push("");
  return lines.join("\n");
}

/* A session only gets source resolution when it names a repository that is
 * actually there. A missing `repoPath` is not an error — a session can run
 * without one — but it does mean every target is described by selector alone,
 * and that has to show up in the artifacts rather than pass silently.
 */
async function buildResolverIndex(session) {
  if (!session.repoPath) return null;
  try {
    const info = await stat(session.repoPath);
    if (!info.isDirectory()) return null;
  } catch {
    return null;
  }

  const root = path.resolve(session.repoPath);
  const files = await collectSourceFiles(root);
  const localeFiles = await collectLocaleFiles(root);
  return createSymbolIndex({ root, files, localeFiles });
}

/* The candidates the agent must not edit blind: none found, two too close to
 * separate, or a best guess that does not claim to be certain. `redact`
 * annotations have no source target by definition and are not counted.
 */
function collectUnresolved(annotations, index) {
  /* No index means nothing was resolved, so "no candidate" would be a claim
   * about a search that never ran. That case is already reported by the
   * Resolver section. */
  if (!index) return [];

  const unresolved = [];
  for (const annotation of annotations) {
    if (annotation.kind === "redact") continue;
    const candidates = annotation.sourceCandidates || [];
    if (candidates.length === 0) {
      unresolved.push(
        annotation.sourceMetadataRejected
          ? `${annotation.id}：标注自带的源码位置未通过校验（${annotation.sourceMetadataRejected}），索引里也没有其他候选，需要人工定位。`
          : `${annotation.id}：没有可靠的源码候选，需要人工从截图与选择器定位。`,
      );
      continue;
    }
    const [best, second] = candidates;
    if (candidates.length > 1 && best.score - second.score < 25) {
      unresolved.push(
        `${annotation.id}：有多个评分接近的候选（\`${best.file}:${best.line}\` 与 \`${second.file}:${second.line}\`），需要人工选定。`,
      );
    }
    if (best.confidence === "low") {
      unresolved.push(
        `${annotation.id}：最佳候选置信度为 low（\`${best.file}:${best.line}\`），改动前必须核对。`,
      );
    } else if (best.confidence === "medium") {
      unresolved.push(
        `${annotation.id}：最佳候选置信度为 medium（\`${best.file}:${best.line}\`），改动前先确认元素。`,
      );
    }
  }
  return unresolved;
}

/* The export gate the schema states: a manipulating annotation with no
 * `intent.expected` must never reach a prompt. A delta is a measurement, not
 * an instruction — only the user can say which mechanism it stands for — so
 * consolidation stops rather than rendering a bare delta as a change. */
function unexportableManipulations(annotations) {
  return annotations.filter(
    (annotation) =>
      annotation.manipulation &&
      String(annotation.intent?.expected ?? "").trim() === "",
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.session) {
    throw new Error("Usage: consolidate-review.mjs --session <dir> [--round <roundId>] [--review <review-annotations.json>]");
  }
  const { dir: sessionDir, session } = await loadSession(args.session);
  const { config } = await loadConfig({ repoPath: session.repoPath });

  const reviewed = session.rounds.filter((round) => round.toRevision);
  const round = args.round
    ? session.rounds.find((item) => item.id === args.round)
    : reviewed[reviewed.length - 1];
  if (!round) throw new Error("没有可汇总的轮次。先跑 review-session.mjs。");

  const roundDir = path.join(sessionDir, "rounds", round.id);
  const reviewPath = args.review
    ? path.resolve(args.review)
    : path.join(roundDir, "review-annotations.json");
  const reviewPayload = await readJson(reviewPath, null);

  // Reviewer decisions override the proposed verdicts.
  let verdicts = round.verdicts || [];
  if (reviewPayload?.verdicts?.length) {
    const overrides = new Map(reviewPayload.verdicts.map((item) => [item.annotationId, item]));
    verdicts = verdicts.map((verdict) => {
      const override = overrides.get(verdict.annotationId);
      return override ? { ...verdict, ...override } : verdict;
    });
    for (const [annotationId, override] of overrides) {
      if (!verdicts.some((verdict) => verdict.annotationId === annotationId)) {
        verdicts.push({ ...override, annotationId });
      }
    }
  }
  round.verdicts = verdicts;
  round.reviewAnnotations = reviewPayload?.annotations || [];

  const verdictFor = (id) => verdicts.find((verdict) => verdict.annotationId === id);
  const open = round.annotations.filter((annotation) => {
    const verdict = verdictFor(annotation.id);
    return !verdict || verdict.status !== "satisfied";
  });
  const closed = round.annotations.filter((annotation) => {
    const verdict = verdictFor(annotation.id);
    return verdict && verdict.status === "satisfied";
  });

  /* 被关掉的标注不再需要改动，就必须从各分组的成员里移除；成员因此变空的组直接
   * 丢弃。`cohesion` 不重算。 */
  if (Array.isArray(session.groups)) {
    session.groups = pruneGroups(
      session.groups,
      closed.map((annotation) => annotation.id),
    );
  }

  // Annotations drawn in the review UI apply to the revision they were drawn
  // on, which becomes the next round's baseline.
  const fresh = round.reviewAnnotations.map((annotation) => ({
    ...annotation,
    revisionId: round.toRevision,
  }));

  /* The export gate, run before the resolver index is built and before a single
   * artifact is written. This is the first point where both halves of the next
   * round — the re-issued annotations that were not satisfied and the ones
   * drawn in the review UI — are assembled under their final shape, so it is
   * the earliest place that can stop a bare delta from reaching
   * `change-request-<R>.md` or `implementation-prompt-<R>.md`. Only
   * manipulating annotations are gated: a plain annotation still renders its
   * `（未填写）` placeholder exactly as before. */
  const unexportable = unexportableManipulations([...open, ...fresh]);
  if (unexportable.length > 0) {
    throw new Error(
      `以下标注带有直接操作（manipulation）但没有填写「期望结果」，不得导出：${unexportable
        .map((annotation) => annotation.id)
        .join("、")}。拖动或缩放产生的 Δ 只是测量值而不是指令，请先补全「期望结果」再汇总。本轮未写出任何产物。`,
    );
  }

  /* Source resolution for the carried set. Both halves need it, for different
   * reasons:
   *
   *  - an annotation drawn in the review UI carries whatever the DOM exposed,
   *    which is nothing when the app was not built with the anchor plugin;
   *  - an annotation carried from an earlier round carries the line number
   *    from *that* round, captured before the agent edited the file.
   *
   * Neither is answered by reading `target.sourceFile` and printing it, which
   * is what this script used to do. The index re-derives the position, and
   * `explicitCandidate` verifies the metadata it was handed instead of
   * trusting it.
   */
  const index = await buildResolverIndex(session);
  const resolveAll = (list) =>
    index
      ? Promise.all(
          list.map((annotation) => resolveAnnotation(annotation, session.repoPath, index)),
        )
      : Promise.resolve(list);

  const openResolved = await resolveAll(open);
  const freshResolved = await resolveAll(fresh);

  const carried = [
    ...openResolved.map((annotation) => ({ ...annotation, revisionId: round.toRevision, carriedFrom: round.id })),
    ...freshResolved.map((annotation) => ({ ...annotation, revisionId: round.toRevision, carriedFrom: null })),
  ];
  /* `uniqueIds` 只在 id 冲突时改显示名，展开赋值让 `alias` 原样跟着走：名字不是
   * 身份，任何一步都不允许丢掉或改写它。 */
  const deduped = uniqueIds(carried);
  const { conflicts, duplicates } = detectConflicts(deduped);

  const reachedLimit = session.rounds.length >= config.review.maxRounds;
  const nextId = reachedLimit ? `${round.id}-final` : nextRoundId(session).id;

  const requestPath = path.join(roundDir, `change-request-${nextId}.md`);
  const promptPath = path.join(roundDir, `implementation-prompt-${nextId}.md`);
  const inputPath = path.join(roundDir, "review-input.json");
  const unresolved = collectUnresolved(deduped, index);

  await mkdir(roundDir, { recursive: true });
  await writeFile(
    requestPath,
    changeRequestMarkdown({
      session, round, open: openResolved, closed, fresh: freshResolved, deduped, conflicts, duplicates, unresolved,
      index, repoPath: session.repoPath,
      nextRoundId: nextId, maxRounds: config.review.maxRounds, reachedLimit,
    }),
    "utf8",
  );
  await writeFile(
    promptPath,
    implementationPrompt({ session, round, nextId, requestPath, inputPath, annotations: deduped, index }),
    "utf8",
  );
  await writeFile(inputPath, `${JSON.stringify(deduped, null, 2)}\n`, "utf8");
  round.consolidatedRequest = path.relative(sessionDir, requestPath).split(path.sep).join("/");
  round.status = "closed";

  if (!reachedLimit && deduped.length > 0) {
    const { id, index } = nextRoundId(session);
    session.rounds.push({
      id,
      index,
      fromRevision: round.toRevision,
      toRevision: null,
      closedAt: null,
      annotations: deduped,
      diff: null,
      verdicts: [],
      reviewAnnotations: [],
      consolidatedRequest: null,
      status: "pending",
    });
    console.log(`SYMBUI_NEXT_ROUND=${id}`);
  }

  session.schemaVersion = SCHEMA_VERSION;
  await saveSession(sessionDir, session);

  console.log(`SYMBUI_CHANGE_REQUEST=${requestPath}`);
  console.log(`SYMBUI_IMPLEMENTATION_PROMPT=${promptPath}`);
  console.log(`SYMBUI_REVIEW_INPUT=${inputPath}`);
  console.log(
    `本轮：已达成 ${closed.length} 条，待改 ${open.length} 条，新增 ${fresh.length} 条。`,
  );
  if (index) {
    console.log(
      `源码解析：${index.engine === "ast" ? "AST" : "词法"}，扫描 ${index.stats.files} 个文件，索引 ${index.stats.sites} 个符号。`,
    );
    const degradation = sourceResolutionWarning(index);
    if (degradation) console.warn(`WARN: ${degradation}`);
  } else {
    console.warn(
      "WARN: 会话没有可用的 repoPath，本轮不做源码定位，目标只按选择器和测试 ID 描述。",
    );
  }
  for (const conflict of conflicts) {
    console.warn(`CONFLICT: ${conflict.ids.join(" 与 ")} — ${conflict.reason}`);
  }
  for (const duplicate of duplicates) {
    console.warn(`DUPLICATE: ${duplicate.ids.join(" 与 ")} 描述几乎相同。`);
  }
  for (const item of unresolved) {
    console.warn(`UNRESOLVED: ${item}`);
  }
  if (reachedLimit) {
    console.warn(
      `WARN: 已达到 review.maxRounds = ${config.review.maxRounds}，未开启下一轮。剩余未解决项已写入变更请求。`,
    );
  } else if (deduped.length === 0) {
    console.log("全部达成且无新意见，复审循环结束。");
  } else {
    console.log(`下一步：让 agent 按 ${path.basename(promptPath)} 修改，然后跑 review-session.mjs 复核。`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
