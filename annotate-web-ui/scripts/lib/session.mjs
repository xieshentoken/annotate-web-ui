import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const SCHEMA_VERSION = "1.2";
export const SUPPORTED_SCHEMA_VERSIONS = new Set(["1.0", "1.1", "1.2"]);

export async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (fallback !== null && error.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function sessionFile(sessionDir, ...parts) {
  return path.join(sessionDir, ...parts);
}

// A legacy session stores states and annotations at the top level. Normalizing
// on read keeps every downstream step working on one shape.
export function normalizeSession(raw) {
  const session = { ...raw };
  if (!Array.isArray(session.revisions)) session.revisions = [];
  if (!Array.isArray(session.rounds)) session.rounds = [];
  session.normalizedFrom = session.schemaVersion || "1.0";
  session.schemaVersion = SCHEMA_VERSION;

  // Only a legacy session needs synthesizing. A brand-new session has no
  // revisions yet and must stay empty, or the first capture would be numbered
  // as if a baseline already existed.
  const legacyStates = Array.isArray(session.states) ? session.states : [];
  const legacyAnnotations = Array.isArray(session.annotations) ? session.annotations : [];
  const isLegacy = legacyStates.length > 0 || legacyAnnotations.length > 0;

  if (session.revisions.length === 0 && isLegacy) {
    session.revisions.push({
      id: "rev-001",
      roundIndex: 0,
      role: "baseline",
      createdAt: session.createdAt || new Date().toISOString(),
      git: session.git || { head: null, dirty: null },
      states: legacyStates.map((state) => ({ ...state })),
      inventory: null,
      synthesized: true,
    });
    session.rounds.push({
      id: "R0",
      index: 0,
      fromRevision: null,
      toRevision: "rev-001",
      closedAt: session.completedAt || session.createdAt || null,
      annotations: legacyAnnotations.map((annotation) => ({
        ...annotation,
        revisionId: annotation.revisionId || "rev-001",
      })),
      diff: null,
      verdicts: [],
      reviewAnnotations: [],
      consolidatedRequest: null,
      synthesized: true,
    });
  }
  delete session.states;
  delete session.annotations;

  for (const revision of session.revisions) {
    if (!Array.isArray(revision.states)) revision.states = [];
    if (!revision.git) revision.git = { head: null, dirty: null };
  }
  for (const round of session.rounds) {
    if (!Array.isArray(round.annotations)) round.annotations = [];
    if (!Array.isArray(round.verdicts)) round.verdicts = [];
    if (!Array.isArray(round.reviewAnnotations)) round.reviewAnnotations = [];
  }
  return session;
}

export async function loadSession(sessionDir) {
  const absolute = path.resolve(sessionDir);
  const file = path.join(absolute, "session.json");
  if (!(await pathExists(file))) {
    throw new Error(`No session.json in ${absolute}`);
  }
  return { dir: absolute, session: normalizeSession(await readJson(file)) };
}

export async function saveSession(sessionDir, session) {
  const file = path.join(path.resolve(sessionDir), "session.json");
  await writeJson(file, session);
  return file;
}

export function baselineRevision(session) {
  return session.revisions.find((revision) => revision.role === "baseline") || session.revisions[0] || null;
}

export function latestRevision(session) {
  return session.revisions[session.revisions.length - 1] || null;
}

export function revisionById(session, id) {
  return session.revisions.find((revision) => revision.id === id) || null;
}

export function nextRevisionId(session) {
  let highest = 0;
  for (const revision of session.revisions) {
    const match = /^rev-(\d+)$/.exec(revision.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `rev-${String(highest + 1).padStart(3, "0")}`;
}

export function nextRoundId(session) {
  let highest = 0;
  for (const round of session.rounds) {
    const match = /^R(\d+)$/.exec(round.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return { id: `R${highest + 1}`, index: highest + 1 };
}

// The revision to compare against: the last revision that has an inventory and
// at least one state. Falls back to the baseline.
export function comparableRevision(session) {
  for (let index = session.revisions.length - 1; index >= 0; index -= 1) {
    const revision = session.revisions[index];
    if (revision.states.length > 0 && revision.inventory) return revision;
  }
  return baselineRevision(session);
}

export function allAnnotations(session) {
  return session.rounds.flatMap((round) => round.annotations || []);
}

export function annotationsForRevision(session, revisionId) {
  return allAnnotations(session).filter((annotation) => annotation.revisionId === revisionId);
}

export function gitInfo(repoPath) {
  if (!repoPath) return { head: null, dirty: null };
  const run = (args) => {
    try {
      return execFileSync("git", ["-C", repoPath, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  };
  const head = run(["rev-parse", "--short", "HEAD"]);
  if (head === null) return { head: null, dirty: null };
  const status = run(["status", "--porcelain"]);
  return { head, dirty: status === null ? null : status.length > 0 };
}
