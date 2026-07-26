#!/usr/bin/env node

import {
  lstat,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  formatIntentOperations,
  validateSessionDirectory,
} from "./validate-session.mjs";

const SOURCE_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".vue",
  ".svelte",
  ".astro",
  ".css",
  ".scss",
  ".sass",
  ".less",
]);

const SKIP_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".symbui",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "vendor",
]);

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

async function collectSourceFiles(root) {
  const files = [];
  const queue = [root];

  while (queue.length > 0 && files.length < 5000) {
    const current = queue.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") && !entry.name.startsWith(".env")) {
        if (entry.isDirectory()) continue;
      }
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        queue.push(absolute);
        continue;
      }
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      const info = await stat(absolute);
      if (info.size <= 1_500_000) files.push(absolute);
    }
  }

  return files;
}

function queryEvidence(annotation) {
  const target = annotation.target || {};
  const attributes = target.attributes || {};
  const queries = [];

  const add = (kind, value, score) => {
    const needle = clip(value, 240);
    if (needle.length >= 2) queries.push({ kind, needle, score });
  };

  add("test-id", target.testId || attributes["data-testid"], 100);
  add("source-component", target.componentName, 92);
  add("element-id", target.id, 86);
  add("aria-label", target.accessibleName || attributes["aria-label"], 76);
  add("visible-text", target.text, 64);
  add("placeholder", attributes.placeholder, 60);
  add("href", attributes.href, 54);

  return queries;
}

function lineNumberFor(text, index) {
  return text.slice(0, index).split("\n").length;
}

async function resolveAnnotation(annotation, repoPath, sourceFiles) {
  if (annotation.kind === "redact") {
    return { ...annotation, sourceCandidates: [] };
  }

  const candidates = new Map();
  const explicitSource = annotation.target?.sourceFile;
  if (explicitSource) {
    const absolute = path.resolve(repoPath, explicitSource);
    const relative = path.relative(repoPath, absolute);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      try {
        const info = await lstat(absolute);
        if (info.isFile()) {
          candidates.set(absolute, {
            file: relative,
            line: Number(annotation.target?.sourceLine) || 1,
            score: 10_000,
            confidence: "exact",
            evidence: ["development source metadata"],
          });
        }
      } catch {
        // Keep resolving through repository evidence.
      }
    }
  }

  const queries = queryEvidence(annotation);
  for (const absolute of sourceFiles) {
    let text;
    try {
      text = await readFile(absolute, "utf8");
    } catch {
      continue;
    }
    let total = 0;
    let bestIndex = -1;
    const evidence = [];
    for (const query of queries) {
      const index = text.indexOf(query.needle);
      if (index === -1) continue;
      total += query.score;
      if (bestIndex === -1) bestIndex = index;
      evidence.push(`${query.kind}: ${quote(query.needle)}`);
    }
    if (total === 0) continue;
    const existing = candidates.get(absolute);
    if (existing?.confidence === "exact") continue;
    if (existing?.score >= total) continue;
    candidates.set(absolute, {
      file: path.relative(repoPath, absolute),
      line: lineNumberFor(text, bestIndex),
      score: total,
      confidence: total >= 100 ? "high" : total >= 70 ? "medium" : "low",
      evidence,
    });
  }

  const sourceCandidates = [...candidates.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);

  return { ...annotation, sourceCandidates };
}

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

function changeRequestMarkdown(session, resolvedAnnotations, sessionDir) {
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
        lines.push(
          `  - \`${candidate.file}:${candidate.line}\` — ${candidate.confidence} confidence; ${candidate.evidence.join("; ")}`,
        );
      }
      if (
        annotation.sourceCandidates.length > 1 &&
        annotation.sourceCandidates[0].score -
          annotation.sourceCandidates[1].score <
          25
      ) {
        unresolved.push(`${annotation.id}: multiple similarly ranked source candidates`);
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

function implementationPrompt(session, resolvedAnnotations, sessionDir) {
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
    "Instructions:",
    "1. Read the change request, structured annotations, and referenced screenshots before editing.",
    "2. Treat source matches as candidates unless the annotation contains explicit source metadata.",
    "3. Implement only the numbered changes below and preserve every stated invariant.",
    "4. If evidence is ambiguous, stop and report the exact unresolved target instead of guessing.",
    "5. Run the project's existing relevant checks and visually verify the captured route and viewport.",
    "",
    "Numbered changes:",
  ];
  for (const annotation of actionable) {
    const changeTypes = formatIntentOperations(annotation.intent);
    lines.push(
      `- ${annotation.id}: ${clip(annotation.intent?.expected, 600)} [types=${changeTypes || "unspecified"}, scope=${annotation.intent?.scope || "element"}, breakpoint=${annotation.intent?.breakpoint || "all"}]`,
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

  const sourceFiles = await collectSourceFiles(absoluteRepoPath);
  const resolvedAnnotations = [];
  for (const annotation of validation.session.annotations) {
    resolvedAnnotations.push(
      await resolveAnnotation(annotation, absoluteRepoPath, sourceFiles),
    );
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
    ),
    "utf8",
  );
  await writeFile(
    promptPath,
    implementationPrompt(
      validation.session,
      resolvedAnnotations,
      absoluteSessionDir,
    ),
    "utf8",
  );

  return {
    requestPath,
    promptPath,
    resolvedPath,
    warnings: validation.warnings,
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
