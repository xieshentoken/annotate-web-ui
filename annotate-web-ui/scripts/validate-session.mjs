#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const SUPPORTED_SCHEMA_VERSIONS = new Set(["1.0", "1.1", "1.2", "1.3"]);

export const CHANGE_OPERATION_LABELS = {
  layout: "布局",
  style: "样式",
  content: "内容",
  interaction: "交互",
  add: "新增",
  remove: "删除",
  fix: "问题修复",
};

const CHANGE_OPERATION_VALUES = new Set(Object.keys(CHANGE_OPERATION_LABELS));

/* `alias` is a name the user typed, so a bad one is a warning, never a fatal
 * error: the session keeps working without it, and the value is never
 * rewritten or dropped — `id` and `target` are still what identify the
 * element. Resolving the collision is the user's call, not this script's. */
const ANNOTATION_ALIAS_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const GROUP_COHESION_VALUES = new Set(["container", "component", "mixed"]);

export function isAllowedLocalUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      (LOCAL_HOSTS.has(parsed.hostname) || parsed.hostname.endsWith(".localhost"))
    );
  } catch {
    return false;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeIntentOperations(intent) {
  if (!isPlainObject(intent)) return [];
  const raw = Array.isArray(intent.operations)
    ? intent.operations
    : typeof intent.operation === "string"
      ? [intent.operation]
      : [];
  return [...new Set(raw)].filter((value) => CHANGE_OPERATION_VALUES.has(value));
}

export function formatIntentOperations(intent) {
  return normalizeIntentOperations(intent)
    .map((value) => CHANGE_OPERATION_LABELS[value])
    .join("、");
}

function isSafeRelativeFile(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.split(/[\\/]/).includes("..")
  );
}

export function validateSessionData(session) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(session)) {
    return { errors: ["Session root must be an object."], warnings };
  }

  if (!SUPPORTED_SCHEMA_VERSIONS.has(session.schemaVersion)) {
    errors.push('schemaVersion must be "1.0", "1.1", "1.2", or "1.3".');
  }
  if (typeof session.sessionId !== "string" || session.sessionId.length < 6) {
    errors.push("sessionId must be a non-empty stable identifier.");
  }
  if (!isAllowedLocalUrl(session.targetUrl)) {
    errors.push("targetUrl must point to an allowed local development host.");
  }
  if (!Array.isArray(session.states) || session.states.length === 0) {
    errors.push("states must contain at least one captured page state.");
  }
  if (!Array.isArray(session.annotations) || session.annotations.length === 0) {
    errors.push("annotations must contain at least one annotation.");
  }

  const stateIds = new Set();
  for (const [index, state] of (session.states || []).entries()) {
    const prefix = `states[${index}]`;
    if (!isPlainObject(state)) {
      errors.push(`${prefix} must be an object.`);
      continue;
    }
    if (typeof state.id !== "string" || stateIds.has(state.id)) {
      errors.push(`${prefix}.id must be unique.`);
    } else {
      stateIds.add(state.id);
    }
    if (!isAllowedLocalUrl(state.url)) {
      errors.push(`${prefix}.url must be an allowed local URL.`);
    }
    if (
      !isPlainObject(state.viewport) ||
      !Number.isFinite(state.viewport.width) ||
      !Number.isFinite(state.viewport.height)
    ) {
      errors.push(`${prefix}.viewport must contain numeric width and height.`);
    }
    if (!isSafeRelativeFile(state.beforeImage)) {
      errors.push(`${prefix}.beforeImage must be a safe relative path.`);
    }
    if (!isSafeRelativeFile(state.annotatedImage)) {
      errors.push(`${prefix}.annotatedImage must be a safe relative path.`);
    }
  }

  const annotationIds = new Set();
  const aliases = new Set();
  for (const [index, annotation] of (session.annotations || []).entries()) {
    const prefix = `annotations[${index}]`;
    if (!isPlainObject(annotation)) {
      errors.push(`${prefix} must be an object.`);
      continue;
    }
    if (
      typeof annotation.id !== "string" ||
      annotationIds.has(annotation.id)
    ) {
      errors.push(`${prefix}.id must be unique.`);
    } else {
      annotationIds.add(annotation.id);
    }
    if (annotation.alias !== undefined && annotation.alias !== null) {
      if (typeof annotation.alias !== "string") {
        warnings.push(
          `${annotation.id || prefix}.alias is not a string; the value was kept exactly as written.`,
        );
      } else if (annotation.alias.trim().length > 0) {
        if (!ANNOTATION_ALIAS_PATTERN.test(annotation.alias)) {
          warnings.push(
            `${annotation.id || prefix}.alias ${JSON.stringify(annotation.alias)} does not match ${ANNOTATION_ALIAS_PATTERN}; the name is kept as written because names are the user's to choose.`,
          );
        }
        if (aliases.has(annotation.alias)) {
          warnings.push(
            `${annotation.id || prefix}.alias ${JSON.stringify(annotation.alias)} is already used by another annotation; ids stay authoritative and neither name was changed.`,
          );
        } else {
          aliases.add(annotation.alias);
        }
      }
    }
    if (!stateIds.has(annotation.stateId)) {
      errors.push(`${prefix}.stateId must reference a captured state.`);
    }
    if (
      !["element", "box", "point", "arrow", "redact"].includes(annotation.kind)
    ) {
      errors.push(`${prefix}.kind is unsupported.`);
    }
    if (!isPlainObject(annotation.geometry)) {
      errors.push(`${prefix}.geometry must be an object.`);
    }
    if (annotation.kind !== "redact") {
      if (!isPlainObject(annotation.intent)) {
        errors.push(`${prefix}.intent must be an object.`);
      } else {
        const hasOperationsArray = Array.isArray(annotation.intent.operations);
        const operations = normalizeIntentOperations(annotation.intent);
        if (session.schemaVersion !== "1.0" && !hasOperationsArray) {
          errors.push(
            `${prefix}.intent.operations must be an array from schema version 1.1 onwards.`,
          );
        }
        if (hasOperationsArray) {
          if (
            annotation.intent.operations.length === 0 ||
            annotation.intent.operations.some(
              (value) => !CHANGE_OPERATION_VALUES.has(value),
            )
          ) {
            errors.push(
              `${prefix}.intent.operations must contain supported change types.`,
            );
          }
          if (new Set(annotation.intent.operations).size !== annotation.intent.operations.length) {
            errors.push(`${prefix}.intent.operations must not contain duplicates.`);
          }
        } else if (
          typeof annotation.intent.operation !== "string" ||
          !CHANGE_OPERATION_VALUES.has(annotation.intent.operation)
        ) {
          errors.push(
            `${prefix}.intent.operation must be a supported legacy change type.`,
          );
        } else if (operations.length === 0) {
          errors.push(
            `${prefix}.intent must include at least one supported change type.`,
          );
        }
        if (
          typeof annotation.intent.expected !== "string" ||
          annotation.intent.expected.trim().length === 0
        ) {
          errors.push(`${prefix}.intent.expected is required.`);
        }
      }
      if (!annotation.target) {
        warnings.push(
          `${annotation.id || prefix} has visual-only targeting; review its source candidates manually.`,
        );
      }
    }
    /* `key` is the manipulation's identity from 1.3 onwards: without it a delta
     * cannot be attributed to the element it was measured on. Sessions written
     * before then may carry a manipulation without a key, and those are
     * reported rather than rejected. `mode` and `delta` are checked for every
     * version — a gesture is only re-measurable if its numbers are numbers. */
    if (annotation.manipulation !== undefined && annotation.manipulation !== null) {
      if (!isPlainObject(annotation.manipulation)) {
        errors.push(`${prefix}.manipulation must be an object.`);
      } else {
        const manipulation = annotation.manipulation;
        if (
          typeof manipulation.key !== "string" ||
          manipulation.key.trim().length === 0
        ) {
          if (session.schemaVersion === "1.3") {
            errors.push(
              `${prefix}.manipulation.key must be a non-empty string from schema version 1.3 onwards.`,
            );
          } else {
            warnings.push(
              `${annotation.id || prefix}.manipulation has no key; a session written before 1.3 may carry one without a key, but the gesture then cannot be attributed to one element.`,
            );
          }
        }
        if (manipulation.mode !== "move" && manipulation.mode !== "resize") {
          errors.push(`${prefix}.manipulation.mode must be "move" or "resize".`);
        }
        if (!isPlainObject(manipulation.delta)) {
          errors.push(`${prefix}.manipulation.delta must be an object.`);
        } else {
          for (const axis of ["x", "y", "width", "height"]) {
            if (!Number.isFinite(manipulation.delta[axis])) {
              errors.push(
                `${prefix}.manipulation.delta.${axis} must be a finite number.`,
              );
            }
          }
        }
      }
    }
  }

  /* Groups are validated after the annotations so a membership check can ask
   * the finished set. A group naming an annotation that does not exist is an
   * error rather than a group with fewer members: silently dropping the member
   * would change what the user asked for. */
  if (session.groups !== undefined) {
    if (!Array.isArray(session.groups)) {
      errors.push("groups must be an array when present.");
    } else {
      const groupIds = new Set();
      for (const [index, group] of session.groups.entries()) {
        const prefix = `groups[${index}]`;
        if (!isPlainObject(group)) {
          errors.push(`${prefix} must be an object.`);
          continue;
        }
        if (
          typeof group.id !== "string" ||
          group.id.trim().length === 0 ||
          groupIds.has(group.id)
        ) {
          errors.push(`${prefix}.id must be non-empty and unique.`);
        } else {
          groupIds.add(group.id);
        }
        /* `name` is human text the user typed, Chinese included, so only
         * emptiness is checked — never a character set. */
        if (typeof group.name !== "string" || group.name.trim().length === 0) {
          errors.push(`${prefix}.name must be a non-empty string.`);
        }
        if (
          !Array.isArray(group.annotationIds) ||
          group.annotationIds.length === 0 ||
          group.annotationIds.some(
            (value) => typeof value !== "string" || value.trim().length === 0,
          )
        ) {
          errors.push(
            `${prefix}.annotationIds must be a non-empty array of annotation ids.`,
          );
        } else {
          for (const annotationId of group.annotationIds) {
            if (!annotationIds.has(annotationId)) {
              errors.push(
                `${prefix}.annotationIds references unknown annotation ${JSON.stringify(annotationId)}.`,
              );
            }
          }
        }
        if (!GROUP_COHESION_VALUES.has(group.cohesion)) {
          errors.push(
            `${prefix}.cohesion must be "container", "component", or "mixed".`,
          );
        } else if (
          group.cohesion === "container" &&
          (typeof group.containerKey !== "string" ||
            group.containerKey.trim().length === 0)
        ) {
          errors.push(
            `${prefix}.containerKey must be a non-empty string for a container group.`,
          );
        }
      }
    }
  }

  /* `null` is how a session without a reference serializes it, so only a
   * non-null value has to be an object. */
  if (session.reference !== undefined && session.reference !== null) {
    if (!isPlainObject(session.reference)) {
      errors.push("reference must be an object when present.");
    } else if (
      typeof session.reference.styleTarget !== "string" ||
      session.reference.styleTarget.trim().length === 0
    ) {
      errors.push("reference.styleTarget must be a non-empty string.");
    }
  }
  return { errors, warnings };
}

export async function validateSessionDirectory(sessionDir) {
  const absoluteDir = path.resolve(sessionDir);
  const sessionPath = path.join(absoluteDir, "session.json");
  const session = JSON.parse(await readFile(sessionPath, "utf8"));
  const result = validateSessionData(session);

  for (const state of session.states || []) {
    for (const relativeFile of [state.beforeImage, state.annotatedImage]) {
      if (!isSafeRelativeFile(relativeFile)) continue;
      try {
        await access(path.join(absoluteDir, relativeFile));
      } catch {
        result.errors.push(`Missing session artifact: ${relativeFile}`);
      }
    }
  }

  return { ...result, session, sessionPath: absoluteDir };
}

async function runCli() {
  const sessionDir = process.argv[2];
  if (!sessionDir) {
    throw new Error("Usage: validate-session.mjs /absolute/path/to/session");
  }
  const result = await validateSessionDirectory(sessionDir);
  for (const warning of result.warnings) {
    console.warn(`WARN: ${warning}`);
  }
  if (result.errors.length > 0) {
    for (const error of result.errors) {
      console.error(`ERROR: ${error}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`Session is valid: ${result.sessionPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
