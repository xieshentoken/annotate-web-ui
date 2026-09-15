/* Turning an annotation into "where in the source is this?".
 *
 * Shared by `build-change-spec.mjs` and `consolidate-review.mjs`: both ask the
 * same question and must give the same answer.
 *
 * The split is deliberate. Everything that needs the filesystem — does the
 * annotation's own `sourceFile` still exist, and is it inside the repository —
 * lives here. Everything that can be answered from the index alone is pure and
 * lives in `symbol-index.mjs`.
 */

import { lstat } from "node:fs/promises";
import path from "node:path";

import { normalizeValue, resolveAnnotationCandidates } from "./symbol-index.mjs";

const EXPLICIT_SCORE = 10_000;

/* Below every strong index candidate (100 + corroboration + scope ≈ 122) so a
 * verified-looking-but-wrong position cannot outrank real evidence, but still
 * well above a weak one, so it stays the fallback when nothing else matches. */
const STALE_SCORE = 400;

/* Why an annotation's own `sourceFile` produced no candidate.
 *
 * Reported rather than swallowed: "the metadata points at a file that is not
 * there" is a different problem from "there was no metadata at all", and the
 * usual cause of the first — an agent renamed, moved, or deleted the file
 * between rounds — is exactly what the reader needs to know. A silent `null`
 * here is what let the change request print `src/ProductCard.tsx:16` as a
 * location while simultaneously reporting that no candidate was found.
 */
async function rejectExplicit(annotation, repoPath) {
  const explicitSource = annotation.target?.sourceFile;
  if (!explicitSource) return null;
  if (!repoPath) return "会话没有设置 repoPath";

  const absolute = path.resolve(repoPath, explicitSource);
  const relative = path.relative(repoPath, absolute).split(path.sep).join("/");
  if (relative.startsWith("..") || path.isAbsolute(relative)) return "路径在仓库之外";

  try {
    const info = await lstat(absolute);
    if (!info.isFile()) return "路径不是文件";
  } catch (error) {
    return error.code === "ENOENT"
      ? "文件不存在"
      : `无法读取（${error.code || error.message}）`;
  }
  return null;
}

/* An annotation can carry source metadata captured at build time
 * (`data-ui-source`). That is the strongest evidence available — while it is
 * still true.
 *
 * It is not always still true. The metadata is captured against the baseline
 * revision, then an agent edits the file and the line moves. The annotation is
 * carried into the next round unchanged, so from round two onward every target
 * would be resolved against a line number describing the pre-edit file.
 *
 * So the position is verified instead of trusted: if the element sitting at
 * that line declares a different `data-testid` than the annotation asked for,
 * the line is stale. The candidate is kept — it is still the best guess — but
 * it stops claiming to be exact, which is what puts it in the change request's
 * unresolved list and makes the agent open the file rather than edit line 12
 * blind.
 *
 * The check only fires when both sides name a test id. An element with no test
 * id of its own is not evidence of a stale line: the annotation's test id may
 * simply belong to an ancestor.
 */
async function buildExplicitCandidate(annotation, repoPath, index) {
  const explicitSource = annotation.target?.sourceFile;
  if (!explicitSource) return { candidate: null, rejected: null };

  const rejected = await rejectExplicit(annotation, repoPath);
  if (rejected) return { candidate: null, rejected };

  const absolute = path.resolve(repoPath, explicitSource);
  const relative = path.relative(repoPath, absolute).split(path.sep).join("/");

  const line = Number(annotation.target?.sourceLine) || 1;
  const column = Number(annotation.target?.sourceColumn) || 0;
  const described = index.describeAt(relative, line, column);

  const expectedTestId = normalizeValue(
    annotation.target?.testId || annotation.target?.attributes?.["data-testid"],
  );
  const actualTestId = normalizeValue(described?.testId);
  const stale = expectedTestId !== "" && actualTestId !== "" && expectedTestId !== actualTestId;

  const evidence = ["development source metadata"];
  if (described) {
    evidence.push(
      `enclosing: <${described.tag}> inside ${described.component || "unknown component"} (lines ${described.line}-${described.endLine})`,
    );
  }
  if (stale) {
    evidence.push(
      `stale: the element at this position declares data-testid=${JSON.stringify(actualTestId)}, not ${JSON.stringify(expectedTestId)} — the line moved after an earlier edit`,
    );
  }

  return {
    candidate: {
      file: relative,
      line,
      column,
      endLine: described?.endLine ?? line,
      score: stale ? STALE_SCORE : EXPLICIT_SCORE,
      confidence: stale ? "medium" : "exact",
      evidence,
      resolver: "metadata",
      fileMode: index.records.get(relative)?.mode ?? null,
      element: described
        ? { tag: described.tag, component: described.component, testId: described.testId }
        : null,
      enclosing: null,
      corroborated: null,
      i18nKey: null,
    },
    rejected: null,
  };
}

export async function resolveAnnotation(annotation, repoPath, index) {
  if (annotation.kind === "redact") {
    return { ...annotation, sourceCandidates: [], sourceMetadataRejected: null };
  }
  const { candidate, rejected } = await buildExplicitCandidate(annotation, repoPath, index);
  return {
    ...annotation,
    sourceCandidates: resolveAnnotationCandidates(index, annotation, { explicit: candidate }),
    sourceMetadataRejected: rejected,
  };
}

export function describeCandidate(candidate) {
  const where = `${candidate.file}:${candidate.line}${
    candidate.column ? `:${candidate.column}` : ""
  }`;
  const parts = [`${candidate.confidence} confidence`, `resolver=${candidate.resolver}`];
  if (candidate.element?.tag) {
    const scope = candidate.element.component ? ` inside ${candidate.element.component}` : "";
    parts.push(`<${candidate.element.tag}>${scope}`);
  }
  if (candidate.i18nKey) parts.push(`i18n=${candidate.i18nKey}`);
  if (candidate.corroborated) {
    parts.push(`corroborated by ${candidate.corroborated.kinds.join("+")}`);
  }
  return `\`${where}\` — ${parts.join("; ")}`;
}

/* Structured form of the same facts, so each script can phrase them in its own
 * language without either one re-deriving them.
 *
 * `reason` exists because `engine === "lexical"` has two very different
 * causes: no parser was found, or a parser was found and every file failed to
 * parse. The first is an install problem, the second is a version or plugin
 * conflict, and the agent reading the change request needs to know which.
 */
export function resolverFacts(index) {
  const stats = index.stats;
  let reason = "ok";
  if (!index.parser.available) reason = "no-parser";
  /* `files === 0` is its own failure: a `repoPath` that points at an empty
   * directory, or at one where every entry is excluded, indexes nothing. Left
   * merged with "parser loaded but every file threw", it would report an
   * install problem where the real answer is "you pointed me at nothing". */
  else if (stats.files === 0) reason = "no-files";
  else if (stats.parsed === 0) reason = "no-parse-success";

  return {
    engine: index.engine,
    reason,
    parserAvailable: index.parser.available,
    parserFrom: index.parser.from,
    files: stats.files,
    parsed: stats.parsed,
    lexical: stats.lexical,
    failed: stats.failed,
    elements: stats.elements,
    sites: stats.sites,
    locales: stats.locales,
    i18nEntries: stats.i18nEntries,
    failures: index.parser.failures,
  };
}

/* One wording, shared by both entry points, so the two paths cannot end up
 * warning about the same degradation in different terms. */
export function sourceResolutionWarning(index) {
  const facts = resolverFacts(index);
  if (facts.reason === "no-parser") {
    return "@babel/parser was not found, so source anchors are resolved lexically and no candidate can reach high confidence. Install @babel/parser in the project, or set SYMBUI_PARSER_MODULES to a directory that has it.";
  }
  if (facts.reason === "no-parse-success") {
    return `@babel/parser loaded from ${facts.parserFrom} but no file parsed, so every anchor was resolved lexically and no candidate can reach high confidence.`;
  }
  return null;
}

/* How much of a round was carried by development-only `data-ui-source`
 * metadata, which is the only evidence that reaches `exact` confidence.
 *
 * `orphanedMetadata` is the state worth separating. An annotation whose
 * `sourceFile` names a file the index cannot see is not the same as an
 * annotation that never had metadata: the first means the injectors are wired
 * and the file moved, the second means they were never wired. Telling a reader
 * to install injectors they already have sends them to fix the wrong thing.
 *
 * Counts only — each entry point renders these in its own language. */
export function anchorCoverage(resolvedAnnotations) {
  const changes = (resolvedAnnotations || []).filter(
    (annotation) => annotation.kind !== "redact",
  );
  const fromMetadata = (annotation) =>
    (annotation.sourceCandidates || []).some(
      (candidate) => candidate.resolver === "metadata",
    );
  const anchored = changes.filter(fromMetadata).length;
  const orphanedMetadata = changes.filter(
    (annotation) =>
      Boolean(annotation.target?.sourceFile) && !fromMetadata(annotation),
  ).length;
  return { total: changes.length, anchored, orphanedMetadata };
}
