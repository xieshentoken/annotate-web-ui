#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectSourceFiles } from "./lib/source-files.mjs";
import {
  anchorCoverage,
  describeCandidate,
  resolverFacts,
  resolveAnnotation,
  sourceResolutionWarning,
} from "./lib/source-resolve.mjs";
import {
  collectLocaleFiles,
  createSymbolIndex,
} from "./lib/symbol-index.mjs";
import {
  formatIntentOperations,
  validateSessionDirectory,
} from "./validate-session.mjs";

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

function clip(value, limit = 180) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized.length > limit
    ? `${normalized.slice(0, limit - 1)}…`
    : normalized;
}

function markdown(value) {
  return clip(value, 500).replace(/[\\`|]/g, "\\$&");
}

function quote(value) {
  return JSON.stringify(clip(value, 300));
}

/* `alias` is a name the user typed. It is display only: every place that
 * prints it prints the `id` beside it, because the `id` and the source anchor
 * are still what decide which element is meant. */
function annotationAlias(annotation) {
  const alias = annotation.alias;
  return typeof alias === "string" && alias.trim().length > 0 ? alias : "";
}

function aliasSuffix(annotation) {
  const alias = annotationAlias(annotation);
  return alias ? ` (${markdown(alias)})` : "";
}

function describeRect(rect) {
  if (!rect) return "unknown";
  return `x=${Math.round(rect.x || 0)} y=${Math.round(rect.y || 0)} w=${Math.round(rect.width || 0)} h=${Math.round(rect.height || 0)}`;
}

/* The schema rule this encodes: a manipulating annotation without an explicit
 * `expected` must not be exported. `delta.x: 32` is a measurement, not an
 * instruction — only the user can say which mechanism it means — so it is
 * reported as a blocking problem instead of a change the agent may guess at. */
function blockingManipulationProblem(annotation) {
  if (!annotation.manipulation) return null;
  if (String(annotation.intent?.expected ?? "").trim() !== "") return null;
  return `${annotation.id}: direct manipulation with no expected result — a delta is a measurement, not an instruction, so this annotation is blocked and must not be exported until its expected result is filled in.`;
}

/* Two blocks, always. The first is what was measured; the second is what has
 * to be written. A coding agent handed `delta.x: 32` writes `left: 32px`, and
 * the source of that offset cannot be recovered from the number alone. The
 * breakpoint travels with it: a delta measured at one viewport says nothing
 * about the others. */
function manipulationLines(annotation) {
  const manipulation = annotation.manipulation;
  const delta = manipulation.delta || {};
  const geometry = [
    `mode=${manipulation.mode || "move"}`,
    `before [${describeRect(manipulation.before)}]`,
    `after [${describeRect(manipulation.after)}]`,
    `delta [${describeRect(delta)}] in CSS px`,
  ];
  if (manipulation.key) {
    geometry.splice(1, 0, `key=\`${markdown(manipulation.key)}\``);
  }
  return [
    `- Manipulation (geometry truth): ${geometry.join("; ")}`,
    `- Manipulation (semantic hint): the delta is evidence, not CSS. Never write it into the source as an absolute pixel value; express it through the mechanism the source already uses — a \`gap\`, an \`order\`, a \`flex-basis\`, or a breakpoint-scoped rule. Required responsive scope (breakpoint): ${markdown(annotation.intent?.breakpoint || "all")}.`,
  ];
}

function groupMemberLabel(annotation, id) {
  const alias = annotation ? annotationAlias(annotation) : "";
  return alias ? `${id} (${alias})` : id;
}

function groupContainerLabel(group) {
  const anchor = group.container?.anchor;
  if (anchor?.file) {
    return `\`${anchor.file}:${anchor.line ?? "?"}${anchor.component ? ` (${anchor.component})` : ""}\``;
  }
  if (group.containerKey) return `\`${markdown(group.containerKey)}\``;
  return "the shared captured container";
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

/* A group asks for one change across several annotations. How far the agent
 * may generalize is exactly what `cohesion` records, so the wording differs
 * per value — and `mixed` has to forbid inventing a container, because there
 * is none that can be named. */
function groupsSection(session, resolvedAnnotations) {
  const groups = Array.isArray(session.groups) ? session.groups : [];
  if (groups.length === 0) return [];
  const byId = new Map(
    resolvedAnnotations.map((annotation) => [annotation.id, annotation]),
  );
  const lines = ["## Groups", ""];
  for (const group of groups) {
    const ids = Array.isArray(group.annotationIds) ? group.annotationIds : [];
    const members = ids.map((id) => groupMemberLabel(byId.get(id), id));
    lines.push(
      `### ${markdown(group.name || group.id)} (cohesion: ${markdown(group.cohesion || "mixed")})`,
      "",
    );
    lines.push(`- Members: ${members.join(", ")}`, "");
    if (group.cohesion === "container") {
      lines.push(
        `- These members share one captured container, ${groupContainerLabel(group)}. One adjustment applied inside that container satisfies the whole group; the member list is evidence, not a request to restate the change per member.`,
        "",
      );
    } else if (group.cohesion === "component") {
      const component = groupComponentLabel(group, byId);
      lines.push(
        `- No shared container, but every member resolves to one component${component ? ` (\`${markdown(component)}\`)` : ""}. Ask for one adjustment to that component rather than to a container.`,
        "",
      );
    } else {
      lines.push(
        "- These members share neither a container nor a component. Change each member individually, and do not invent a container to group them behind.",
        "",
      );
    }
  }
  return lines;
}

/* Resolution is done by `lib/symbol-index.mjs`. It reads and parses every
 * source file once and answers every annotation from that index, instead of
 * re-scanning the whole tree per annotation with `indexOf` — which also meant
 * a `data-testid` mentioned in a comment scored as high as the real element.
 *
 * The half of that which needs the filesystem lives in
 * `lib/source-resolve.mjs`, shared with the round-based consolidator.
 */

function describeTarget(annotation) {
  const target = annotation.target;
  if (!target) return "Visual region only";
  const parts = [];
  if (target.role) parts.push(`role=${quote(target.role)}`);
  if (target.accessibleName) {
    parts.push(`name=${quote(target.accessibleName)}`);
  }
  if (target.testId) parts.push(`testId=${quote(target.testId)}`);
  if (target.selector) parts.push(`selector=${quote(target.selector)}`);
  if (target.text) parts.push(`text=${quote(target.text)}`);
  return parts.length > 0 ? parts.join(", ") : `${target.tag || "element"}`;
}

function describeGeometry(annotation) {
  const geometry = annotation.geometry || {};
  if (annotation.kind === "point") {
    return `point (${Math.round(geometry.x)}, ${Math.round(geometry.y)})`;
  }
  if (annotation.kind === "arrow") {
    return `arrow (${Math.round(geometry.x1)}, ${Math.round(
      geometry.y1,
    )}) → (${Math.round(geometry.x2)}, ${Math.round(geometry.y2)})`;
  }
  return `rect x=${Math.round(geometry.x)}, y=${Math.round(
    geometry.y,
  )}, w=${Math.round(geometry.width)}, h=${Math.round(geometry.height)}`;
}

/* Why this section exists: a resolver that silently degrades is worse than one
 * that fails. When `@babel/parser` is missing, every candidate is lexically
 * derived and none of them can reach high confidence — the agent reading the
 * change request needs to know that before it trusts a line number.
 *
 * The same argument applies one level up. A run with no build-time anchors
 * never reaches `exact`, and every per-annotation candidate says so, but a
 * reader who skims the summary would not notice that the whole run is
 * text-derived. So the count goes next to the engine, with the one action that
 * changes it. */
function resolverSection(index, resolvedAnnotations) {
  const facts = resolverFacts(index);
  const lines = ["## Resolver", ""];
  if (facts.reason === "no-files") {
    lines.push(
      "- Engine: nothing indexed — no source files were found under the repository root",
    );
  } else if (facts.reason === "no-parser") {
    lines.push("- Engine: lexical only — `@babel/parser` was not found");
  } else if (facts.reason === "no-parse-success") {
    lines.push(
      `- Engine: lexical — \`@babel/parser\` loaded from \`${facts.parserFrom}\` but no file parsed successfully`,
    );
  } else {
    lines.push(`- Engine: AST (\`@babel/parser\` from \`${facts.parserFrom}\`)`);
  }
  lines.push(
    `- Files scanned: ${facts.files} (${facts.parsed} parsed, ${facts.lexical} scanned lexically, ${facts.failed} parse failures)`,
  );
  lines.push(`- Sites indexed: ${facts.sites} across ${facts.elements} elements`);
  lines.push(
    facts.locales > 0
      ? `- Locale files indexed: ${facts.locales} (${facts.i18nEntries} messages); visible text is reverse-mapped to i18n keys before searching source`
      : "- Locale files indexed: none; visible text is matched literally against source",
  );
  if (facts.reason === "no-parser" && facts.failures.length > 0) {
    lines.push("- Parser search:");
    for (const failure of facts.failures.slice(0, 5)) {
      lines.push(`  - ${markdown(failure)}`);
    }
  }
  lines.push(...anchorCoverageLines(resolvedAnnotations));
  lines.push("");
  return lines;
}

function anchorCoverageWarning(resolvedAnnotations) {
  const { total, anchored, orphanedMetadata } =
    anchorCoverage(resolvedAnnotations);
  if (total === 0 || anchored === total) return null;
  if (anchored === 0 && orphanedMetadata === 0) {
    return "No annotation resolved from development source metadata, so every target is a text-derived candidate. Wiring the development-only injectors (references/build-anchors.md) is what raises a candidate to exact confidence.";
  }
  return `${total - anchored} of ${total} annotations have no development source metadata candidate, so those targets are text-derived candidates.`;
}

function anchorCoverageLines(resolvedAnnotations) {
  const { total, anchored, orphanedMetadata } =
    anchorCoverage(resolvedAnnotations);
  if (total === 0) return [];
  if (anchored === total) {
    return [
      `- Build-time anchors: all ${total} annotations resolved from \`data-ui-source\` metadata`,
    ];
  }
  return [
    anchored === 0
      ? "- Build-time anchors: none resolved — no candidate came from `data-ui-source` metadata, so every target below is a text-derived candidate rather than the element the user pointed at"
      : `- Build-time anchors: ${anchored}/${total} resolved from \`data-ui-source\` metadata; the rest are text-derived candidates`,
    orphanedMetadata > 0
      ? `  - ${orphanedMetadata} annotation(s) carried \`data-ui-source\` metadata that produced no candidate; the referenced file may have moved or been renamed since the page was captured.`
      : "  - Wiring the development-only injectors (`references/build-anchors.md`) is what raises a candidate to `exact`, and what lets the revision diff tell a real change apart from a cascade of shifted siblings.",
  ];
}

/* Exported so the rendering contract — alias beside the id, the two
 * manipulation blocks, the Groups wording, and the blocked-manipulation gate —
 * is testable without a repository to resolve against. `buildChangeSpec` is the
 * only production caller. */
export function changeRequestMarkdown(session, resolvedAnnotations, sessionDir, index) {
  const statesById = new Map(session.states.map((state) => [state.id, state]));
  const changes = resolvedAnnotations.filter(
    (annotation) => annotation.kind !== "redact",
  );
  const unresolved = [];
  for (const annotation of resolvedAnnotations) {
    const blocked = blockingManipulationProblem(annotation);
    if (blocked) unresolved.push(blocked);
  }

  const lines = [
    "# Web UI Change Request",
    "",
    `- Session: \`${session.sessionId}\``,
    `- Repository: \`${session.repoPath}\``,
    `- Target: ${session.targetUrl}`,
    `- Captured: ${session.completedAt || session.createdAt}`,
    `- Evidence directory: \`${sessionDir}\``,
    "",
    ...resolverSection(index, resolvedAnnotations),
    "## Requested changes",
    "",
  ];

  for (const annotation of changes) {
    const state = statesById.get(annotation.stateId);
    const intent = annotation.intent || {};
    const changeTypes = formatIntentOperations(intent);
    lines.push(
      `### ${annotation.id} — ${markdown(changeTypes || "change")}`,
    );
    lines.push("");
    const alias = annotationAlias(annotation);
    if (alias) lines.push(`- Name: ${markdown(alias)}`);
    lines.push(`- State: ${markdown(state?.description || state?.title || state?.url)}`);
    lines.push(
      `- Viewport: ${state?.viewport?.width} × ${state?.viewport?.height} @ ${state?.viewport?.deviceScaleFactor || 1}x`,
    );
    lines.push(`- Visual evidence: \`${state?.annotatedImage}\``);
    lines.push(`- Target: ${markdown(describeTarget(annotation))}`);
    lines.push(`- Geometry: ${markdown(describeGeometry(annotation))}`);
    lines.push(`- Change types: ${markdown(changeTypes || "Unspecified")}`);
    lines.push(`- Expected result: ${markdown(intent.expected)}`);
    lines.push(`- Scope: ${markdown(intent.scope || "selected element")}`);
    lines.push(`- Responsive scope: ${markdown(intent.breakpoint || "all")}`);
    lines.push(`- Priority: ${markdown(intent.priority || "must")}`);
    if (intent.invariants) {
      lines.push(`- Keep unchanged: ${markdown(intent.invariants)}`);
    }
    if (annotation.manipulation) {
      lines.push(...manipulationLines(annotation));
    }
    lines.push("- Source candidates:");
    if (annotation.sourceCandidates.length === 0) {
      lines.push("  - No reliable source candidate. Resolve manually from evidence.");
      unresolved.push(`${annotation.id}: no reliable source candidate`);
    } else {
      for (const candidate of annotation.sourceCandidates) {
        lines.push(`  - ${describeCandidate(candidate)}`);
        if (candidate.evidence.length > 0) {
          lines.push(`    - evidence: ${candidate.evidence.join("; ")}`);
        }
      }
      const [best, second] = annotation.sourceCandidates;
      if (annotation.sourceCandidates.length > 1 && best.score - second.score < 25) {
        unresolved.push(`${annotation.id}: multiple similarly ranked source candidates`);
      }
      if (best.confidence === "low") {
        unresolved.push(
          `${annotation.id}: best candidate is low confidence (\`${best.file}:${best.line}\`) — verify before editing`,
        );
      } else if (best.confidence === "medium") {
        unresolved.push(
          `${annotation.id}: best candidate is medium confidence (\`${best.file}:${best.line}\`) — confirm the element before editing`,
        );
      }
    }
    lines.push("");
  }

  lines.push(...groupsSection(session, resolvedAnnotations));

  lines.push("## Protected behavior", "");
  lines.push(
    "- Preserve existing interactions that are not explicitly changed above.",
    "- Preserve routes, data flow, and component behavior outside the annotated scope.",
    "- Do not infer hidden requirements from screenshot coordinates alone.",
    "",
    "## Acceptance criteria",
    "",
  );
  for (const annotation of changes) {
    lines.push(
      `- [ ] ${annotation.id}${aliasSuffix(annotation)}: ${markdown(annotation.intent?.expected)}`,
    );
  }
  lines.push(
    "- [ ] The page still supports its original controls outside the requested changes.",
    "- [ ] The result is verified at every captured viewport and state.",
    "",
    "## Unresolved items",
    "",
  );
  if (unresolved.length === 0) {
    lines.push("- None detected by the deterministic resolver.");
  } else {
    for (const item of unresolved) lines.push(`- ${item}`);
  }
  lines.push("");

  return lines.join("\n");
}

export function implementationPrompt(session, resolvedAnnotations, sessionDir, index) {
  const blocked = resolvedAnnotations.filter(
    (annotation) => blockingManipulationProblem(annotation) !== null,
  );
  const actionable = resolvedAnnotations.filter(
    (annotation) =>
      annotation.kind !== "redact" &&
      blockingManipulationProblem(annotation) === null,
  );
  const lines = [
    "Modify the local web application according to the evidence-linked UI change request.",
    "",
    `Repository: ${session.repoPath}`,
    `Target URL: ${session.targetUrl}`,
    `Change request: ${path.join(sessionDir, "change-request.md")}`,
    `Structured annotations: ${path.join(sessionDir, "annotations.resolved.json")}`,
    "",
    `Source resolution: ${
      index.engine === "ast"
        ? "AST-based (elements, attributes, and declarations are indexed with exact positions)"
        : "lexical only, so no candidate reaches high confidence"
    }.`,
    "",
    "Instructions:",
    "1. Read the change request, structured annotations, and referenced screenshots before editing.",
    "2. Treat source matches as candidates unless the annotation contains explicit source metadata.",
    "3. Each candidate carries a `confidence` and a `resolver`; open the file before editing when confidence is not `high` or `exact`.",
    "4. A candidate's `element` field names the enclosing element and component. If it disagrees with the line number, trust the element and re-read the file.",
    "5. Implement only the numbered changes below and preserve every stated invariant.",
    "6. If evidence is ambiguous, stop and report the exact unresolved target instead of guessing.",
    "7. Run the project's existing relevant checks and visually verify the captured route and viewport.",
    "",
    "Numbered changes:",
  ];
  for (const annotation of actionable) {
    const changeTypes = formatIntentOperations(annotation.intent);
    const best = annotation.sourceCandidates?.[0];
    const where = best ? ` @ ${best.file}:${best.line} (${best.confidence})` : "";
    lines.push(
      `- ${annotation.id}${aliasSuffix(annotation)}${where}: ${clip(annotation.intent?.expected, 600)} [types=${changeTypes || "unspecified"}, scope=${annotation.intent?.scope || "element"}, breakpoint=${annotation.intent?.breakpoint || "all"}]`,
    );
    if (annotation.manipulation) {
      for (const line of manipulationLines(annotation)) {
        lines.push(`  ${line}`);
      }
    }
  }
  lines.push("");
  if (blocked.length > 0) {
    lines.push(
      `Blocked — do not implement: ${blocked.map((annotation) => annotation.id).join(", ")}. Each one records a direct manipulation without an expected result, so the delta is a measurement rather than an instruction. Report it back instead of guessing.`,
      "",
    );
  }
  lines.push(...groupsSection(session, resolvedAnnotations));
  lines.push("");
  return lines.join("\n");
}

export async function buildChangeSpec({ sessionDir, repoPath }) {
  const absoluteSessionDir = path.resolve(sessionDir);
  const absoluteRepoPath = path.resolve(repoPath);
  const validation = await validateSessionDirectory(absoluteSessionDir);
  if (validation.errors.length > 0) {
    throw new Error(
      `Session validation failed:\n${validation.errors
        .map((item) => `- ${item}`)
        .join("\n")}`,
    );
  }

  /* One pass over the repository, then every annotation is answered from the
   * index. The previous shape re-read and re-scanned every source file once
   * per annotation.
   */
  const sourceFiles = await collectSourceFiles(absoluteRepoPath);
  const localeFiles = await collectLocaleFiles(absoluteRepoPath);
  const index = await createSymbolIndex({
    root: absoluteRepoPath,
    files: sourceFiles,
    localeFiles,
  });

  const resolvedAnnotations = [];
  for (const annotation of validation.session.annotations) {
    resolvedAnnotations.push(
      await resolveAnnotation(annotation, absoluteRepoPath, index),
    );
  }

  const warnings = [...validation.warnings];
  const degradation = sourceResolutionWarning(index);
  if (degradation) warnings.push(degradation);
  const anchorGap = anchorCoverageWarning(resolvedAnnotations);
  if (anchorGap) warnings.push(anchorGap);
  for (const failure of index.parseErrors.slice(0, 5)) {
    warnings.push(`Parse failed for ${failure.file}: ${failure.message}`);
  }
  if (index.parseErrors.length > 5) {
    warnings.push(`${index.parseErrors.length - 5} further files failed to parse.`);
  }

  const resolvedPath = path.join(
    absoluteSessionDir,
    "annotations.resolved.json",
  );
  const requestPath = path.join(absoluteSessionDir, "change-request.md");
  const promptPath = path.join(
    absoluteSessionDir,
    "implementation-prompt.md",
  );

  await writeFile(
    resolvedPath,
    `${JSON.stringify(resolvedAnnotations, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    requestPath,
    changeRequestMarkdown(
      validation.session,
      resolvedAnnotations,
      absoluteSessionDir,
      index,
    ),
    "utf8",
  );
  await writeFile(
    promptPath,
    implementationPrompt(
      validation.session,
      resolvedAnnotations,
      absoluteSessionDir,
      index,
    ),
    "utf8",
  );

  return {
    requestPath,
    promptPath,
    resolvedPath,
    warnings,
    resolver: {
      engine: index.engine,
      parserFrom: index.parser.from,
      stats: index.stats,
    },
  };
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.session || !args.repo) {
    throw new Error(
      "Usage: build-change-spec.mjs --session /path/to/session --repo /path/to/repo",
    );
  }
  const result = await buildChangeSpec({
    sessionDir: args.session,
    repoPath: args.repo,
  });
  for (const warning of result.warnings) console.warn(`WARN: ${warning}`);
  console.log(`Change request: ${result.requestPath}`);
  console.log(`Implementation prompt: ${result.promptPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
