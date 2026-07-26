#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const SUPPORTED_SCHEMA_VERSIONS = new Set(["1.0", "1.1"]);

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
    errors.push('schemaVersion must be "1.0" or "1.1".');
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
        if (
          session.schemaVersion === "1.1" &&
          !hasOperationsArray
        ) {
          errors.push(
            `${prefix}.intent.operations must be an array in schema version 1.1.`,
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
