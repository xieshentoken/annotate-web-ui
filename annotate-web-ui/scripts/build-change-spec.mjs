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

function changeRequestMarkdown(session, resolvedAnnotations, sessionDir, index) {
  const statesById = new Map(session.states.map((state) => [state.id, state]));
  const changes = resolvedAnnotations.filter(
    (annotation) => annotation.kind !== "redact",
  );
  const unresolved = [];

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
      `- [ ] ${annotation.id}: ${markdown(annotation.intent?.expected)}`,
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

function implementationPrompt(session, resolvedAnnotations, sessionDir, index) {
  const actionable = resolvedAnnotations.filter(
    (annotation) => annotation.kind !== "redact",
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
      `- ${annotation.id}${where}: ${clip(annotation.intent?.expected, 600)} [types=${changeTypes || "unspecified"}, scope=${annotation.intent?.scope || "element"}, breakpoint=${annotation.intent?.breakpoint || "all"}]`,
    );
  }
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
