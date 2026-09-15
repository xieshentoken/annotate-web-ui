#!/usr/bin/env node

// Deterministic diff between two revision inventories.
//
// This module never calls a model and never reads application source. It aligns
// two element inventories by their stable `key` and reports what changed. Every
// verdict downstream cites clusters produced here, so the evidence stays
// reproducible by anyone who re-runs the command.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_TOLERANCE = 1;

// Size is deliberately absent: `rect` already carries it. Keeping width and
// height here would report every element inside a resized container as both
// moved and restyled, which is exactly the noise the derived rule exists to
// remove.
const TRACKED_STYLE_KEYS = [
  "display",
  "flexDirection",
  "justifyContent",
  "alignItems",
  "gap",
  "padding",
  "margin",
  "borderRadius",
  "border",
  "backgroundColor",
  "color",
  "boxShadow",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "opacity",
];

// Computed styles can differ in insignificant whitespace between captures.
// Collapse it so a real change is never reported as noise, and noise is never
// reported as a change.
export function normalizeStyleValue(value) {
  if (value == null) return "";
  return String(value)
    .replace(/\s+/g, " ")
    .replace(/,\s*/g, ",")
    .trim()
    .toLowerCase();
}

function area(rect) {
  if (!rect) return 0;
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function intersectionArea(a, b) {
  if (!a || !b) return 0;
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

function unionRect(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

function padRect(rect, amount) {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2,
  };
}

export function intersectionOverUnion(a, b) {
  const intersection = intersectionArea(a, b);
  if (intersection === 0) return 0;
  const union = area(a) + area(b) - intersection;
  return union === 0 ? 0 : intersection / union;
}

// An annotation's geometry is not always a rectangle. Points and arrows are
// reduced to a bounding box so the same overlap test applies to every kind.
export function annotationRect(annotation) {
  const geometry = annotation.geometry || {};
  if (annotation.kind === "point") {
    return {
      x: geometry.x - 8,
      y: geometry.y - 8,
      width: 16,
      height: 16,
    };
  }
  if (annotation.kind === "arrow") {
    const x = Math.min(geometry.x1, geometry.x2);
    const y = Math.min(geometry.y1, geometry.y2);
    return {
      x,
      y,
      width: Math.abs(geometry.x2 - geometry.x1),
      height: Math.abs(geometry.y2 - geometry.y1),
    };
  }
  return {
    x: geometry.x || 0,
    y: geometry.y || 0,
    width: geometry.width || 0,
    height: geometry.height || 0,
  };
}

// Compare only the tracked subset, so an inventory that carries extra style
// fields cannot turn into phantom restyles.
function styleDelta(before = {}, after = {}) {
  const changed = {};
  for (const key of TRACKED_STYLE_KEYS) {
    const from = normalizeStyleValue(before[key]);
    const to = normalizeStyleValue(after[key]);
    if (from !== to) changed[key] = [before[key] ?? null, after[key] ?? null];
  }
  return changed;
}

function rectDelta(before, after) {
  if (!before || !after) return { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: Math.round(after.x - before.x),
    y: Math.round(after.y - before.y),
    width: Math.round(after.width - before.width),
    height: Math.round(after.height - before.height),
  };
}

function kindsFor(before, after, tolerance) {
  const kinds = [];
  const delta = rectDelta(before?.rect, after?.rect);
  if (Math.abs(delta.x) > tolerance || Math.abs(delta.y) > tolerance) {
    kinds.push("moved");
  }
  if (
    Math.abs(delta.width) > tolerance ||
    Math.abs(delta.height) > tolerance
  ) {
    kinds.push("resized");
  }
  const style = styleDelta(before?.style, after?.style);
  if (Object.keys(style).length > 0) kinds.push("restyled");
  return { kinds, delta, style };
}

function indexByKey(elements = []) {
  const index = new Map();
  for (const element of elements) {
    if (!element?.key) continue;
    if (!index.has(element.key)) index.set(element.key, []);
    index.get(element.key).push(element);
  }
  return index;
}

function identityOf(element) {
  return {
    key: element.key,
    selector: element.selector || "",
    testId: element.testId || "",
    anchor: element.anchor || null,
    role: element.role || "",
    name: element.name || "",
  };
}

function clusterIdentity(before, after) {
  const source = after || before;
  return {
    key: source.key,
    selector: source.selector || "",
    testId: source.testId || "",
    anchor: source.anchor || null,
    tag: source.tag || "",
    role: source.role || "",
    name: source.name || "",
    reuseCount: source.reuseCount ?? null,
    unstable: source.unstable === true,
  };
}

function describeCluster(cluster) {
  const label = cluster.anchor
    ? `${cluster.anchor.file}:${cluster.anchor.line}`
    : cluster.testId
      ? `[data-testid="${cluster.testId}"]`
      : cluster.selector || cluster.key;
  if (cluster.kinds.includes("added")) return `added ${label}`;
  if (cluster.kinds.includes("removed")) return `removed ${label}`;
  const parts = [];
  if (cluster.kinds.includes("restyled")) {
    for (const [property, [from, to]] of Object.entries(
      cluster.delta.style || {},
    )) {
      parts.push(`${property} ${from ?? "none"} -> ${to ?? "none"}`);
    }
  }
  if (cluster.kinds.includes("resized")) {
    parts.push(
      `size ${cluster.delta.width >= 0 ? "+" : ""}${cluster.delta.width} x ${
        cluster.delta.height >= 0 ? "+" : ""
      }${cluster.delta.height}`,
    );
  }
  if (cluster.kinds.includes("moved")) {
    parts.push(
      `moved ${cluster.delta.x >= 0 ? "+" : ""}${cluster.delta.x}, ${
        cluster.delta.y >= 0 ? "+" : ""
      }${cluster.delta.y}`,
    );
  }
  return parts.length > 0 ? `${label}: ${parts.join("; ")}` : `${label}: changed`;
}

// Two kinds of relationship, and they mean different things.
//
// `direct` is an identity match: the annotation names this exact element by test
// id, selector, or source anchor. That is an explicit instruction, so the
// element stays a primary change even if its container also moved.
//
// `related` adds a geometric overlap on top. A box drawn around a card is
// evidence about everything inside it, but it is not an instruction to change
// each of those descendants, so overlap alone must not promote them.
function matchAnnotations(cluster, annotations) {
  const related = [];
  const direct = [];
  const region = cluster.region;
  for (const annotation of annotations) {
    const rect = annotationRect(annotation);
    const target = annotation.target || {};
    const sameTestId =
      cluster.testId && target.testId && cluster.testId === target.testId;
    const sameSelector =
      cluster.selector && target.selector && cluster.selector === target.selector;
    // An anchor alone cannot tell two rows of a list apart: every row of a
    // repeated component shares one file and line. When the annotation carries
    // a test id, the test id has to agree too, or the annotation would appear
    // to name every sibling.
    const testIdAgrees = !target.testId || target.testId === cluster.testId;
    const sameAnchor =
      testIdAgrees &&
      cluster.anchor?.file &&
      target.sourceFile &&
      cluster.anchor.file === target.sourceFile &&
      (!target.sourceLine || cluster.anchor.line === Number(target.sourceLine));
    if (sameTestId || sameSelector || sameAnchor) {
      related.push(annotation.id);
      direct.push(annotation.id);
      continue;
    }
    if (!region) continue;
    const overlap = intersectionOverUnion(rect, region);
    const contains =
      intersectionArea(rect, region) >= area(rect) * 0.5 && area(rect) > 0;
    if (overlap >= 0.05 || contains) related.push(annotation.id);
  }
  return { related: [...new Set(related)], direct: [...new Set(direct)] };
}

// Displacement is contagious: change a container's padding and every descendant
// moves. Reporting each of those as its own change buries the handful of
// changes the user actually asked for, so a displacement whose cause is already
// in the change list is marked derived and collapsed by default.
export function markDerived(clusters, elementLists) {
  const parentOf = new Map();
  for (const list of elementLists) {
    for (const element of list || []) {
      if (element?.key && element.parentKey) parentOf.set(element.key, element.parentKey);
    }
  }

  const byKey = new Map();
  for (const cluster of clusters) {
    if (!byKey.has(cluster.key)) byKey.set(cluster.key, []);
    byKey.get(cluster.key).push(cluster);
  }
  const changedKeys = new Set(clusters.map((cluster) => cluster.key));

  const shiftedParents = new Set();
  for (const cluster of clusters) {
    if (cluster.kinds.includes("added") || cluster.kinds.includes("removed")) {
      const parent = parentOf.get(cluster.key);
      if (parent) shiftedParents.add(parent);
    }
  }

  // Walk up until an ancestor that is itself a cluster, or nothing.
  const nearestChangedAncestor = (key, wantedKind) => {
    let parent = parentOf.get(key);
    let hops = 0;
    while (parent && hops < 40) {
      const found = byKey.get(parent);
      if (found && (!wantedKind || found.some((item) => item.kinds.includes(wantedKind)))) {
        return parent;
      }
      parent = parentOf.get(parent);
      hops += 1;
    }
    return null;
  };

  for (const cluster of clusters) {
    // Removing a container removes everything inside it. Reporting each
    // descendant as its own removal turns one change into a dozen, so only the
    // outermost element of the subtree is kept. This outranks the "named by an
    // annotation" rule below: if the whole card is gone, the fact that the
    // reviewer once named a price inside it changes nothing.
    if (
      cluster.kinds.length === 1 &&
      (cluster.kinds[0] === "added" || cluster.kinds[0] === "removed")
    ) {
      const ancestor = nearestChangedAncestor(cluster.key, cluster.kinds[0]);
      if (ancestor) {
        cluster.derived = true;
        cluster.derivedFrom = ancestor;
        cluster.derivedReason = `subtree-${cluster.kinds[0]}`;
      }
      continue;
    }

    // An element the reviewer named is a direct change by definition, even if
    // its container also moved. Explicit intent outranks inference. Geometric
    // overlap alone does not count: a box drawn around a card is evidence about
    // its children, not an instruction to change each of them.
    if ((cluster.directlyAnnotated || []).length > 0) continue;

    // Displacement is contagious: change a container's padding and every
    // descendant moves. Only displacement can be a consequence — a restyle is
    // always a direct change, even when its parent also changed.
    const onlyDisplacement = cluster.kinds.every(
      (kind) => kind === "moved" || kind === "resized",
    );
    if (!onlyDisplacement) continue;

    const ancestor = nearestChangedAncestor(cluster.key, null);
    if (ancestor) {
      cluster.derived = true;
      cluster.derivedFrom = ancestor;
      cluster.derivedReason = "ancestor-changed";
      continue;
    }

    const directParent = parentOf.get(cluster.key);
    if (directParent && shiftedParents.has(directParent) && cluster.kinds.length === 1) {
      cluster.derived = true;
      cluster.derivedFrom = directParent;
      cluster.derivedReason = "sibling-shift";
    }
  }
  return clusters;
}

export function diffState({ beforeState, afterState, annotations = [], tolerance = DEFAULT_TOLERANCE }) {
  const beforeIndex = indexByKey(beforeState?.elements);
  const afterIndex = indexByKey(afterState?.elements);
  const clusters = [];
  const seenKeys = new Set();

  const push = (cluster) => {
    cluster.id = `c${clusters.length + 1}`;
    cluster.stateId = afterState?.stateId || beforeState?.stateId || null;
    cluster.label = describeCluster(cluster);
    const matches = matchAnnotations(cluster, annotations);
    cluster.relatedAnnotations = matches.related;
    cluster.directlyAnnotated = matches.direct;
    clusters.push(cluster);
  };

  for (const [key, afterElements] of afterIndex) {
    const beforeElements = beforeIndex.get(key);
    if (!beforeElements) {
      for (const element of afterElements) {
        push({
          kinds: ["added"],
          ...clusterIdentity(null, element),
          before: null,
          after: { rect: element.rect, style: element.style || {} },
          delta: { x: 0, y: 0, width: 0, height: 0, style: {} },
          region: element.rect,
        });
      }
      continue;
    }
    seenKeys.add(key);
    const count = Math.min(beforeElements.length, afterElements.length);
    for (let index = 0; index < count; index += 1) {
      const before = beforeElements[index];
      const after = afterElements[index];
      const { kinds, delta, style } = kindsFor(before, after, tolerance);
      if (kinds.length === 0) continue;
      push({
        kinds,
        ...clusterIdentity(before, after),
        before: { rect: before.rect, style: before.style || {} },
        after: { rect: after.rect, style: after.style || {} },
        delta: { ...delta, style },
        region: unionRect(before.rect, after.rect),
      });
    }
    // A key that now appears more or fewer times than before is a structural
    // change, not a style change. Report the surplus as added or removed.
    for (let index = count; index < afterElements.length; index += 1) {
      const element = afterElements[index];
      push({
        kinds: ["added"],
        ...clusterIdentity(null, element),
        before: null,
        after: { rect: element.rect, style: element.style || {} },
        delta: { x: 0, y: 0, width: 0, height: 0, style: {} },
        region: element.rect,
      });
    }
    for (let index = count; index < beforeElements.length; index += 1) {
      const element = beforeElements[index];
      push({
        kinds: ["removed"],
        ...clusterIdentity(element, null),
        before: { rect: element.rect, style: element.style || {} },
        after: null,
        delta: { x: 0, y: 0, width: 0, height: 0, style: {} },
        region: element.rect,
      });
    }
  }

  for (const [key, beforeElements] of beforeIndex) {
    if (seenKeys.has(key)) continue;
    for (const element of beforeElements) {
      push({
        kinds: ["removed"],
        ...clusterIdentity(element, null),
        before: { rect: element.rect, style: element.style || {} },
        after: null,
        delta: { x: 0, y: 0, width: 0, height: 0, style: {} },
        region: element.rect,
      });
    }
  }

  markDerived(clusters, [beforeState?.elements, afterState?.elements]);

  const order = ["removed", "added", "restyled", "resized", "moved", "reordered"];
  clusters.sort((left, right) => {
    if (Boolean(left.derived) !== Boolean(right.derived)) return left.derived ? 1 : -1;
    const leftRank = Math.min(...left.kinds.map((kind) => order.indexOf(kind)));
    const rightRank = Math.min(...right.kinds.map((kind) => order.indexOf(kind)));
    if (leftRank !== rightRank) return leftRank - rightRank;
    return area(right.region) - area(left.region);
  });
  // Re-id after sorting so IDs read in display order.
  clusters.forEach((cluster, index) => {
    cluster.id = `c${index + 1}`;
  });

  const summary = {
    added: 0,
    removed: 0,
    moved: 0,
    resized: 0,
    restyled: 0,
    reordered: 0,
    elements: clusters.length,
    primary: 0,
    derived: 0,
  };
  for (const cluster of clusters) {
    for (const kind of cluster.kinds) summary[kind] = (summary[kind] || 0) + 1;
    if (cluster.derived) summary.derived += 1;
    else summary.primary += 1;
  }

  return { stateId: afterState?.stateId || beforeState?.stateId || null, clusters, summary };
}

export function diffInventories({
  fromInventory,
  toInventory,
  fromRevision = null,
  toRevision = null,
  annotations = [],
  tolerance = DEFAULT_TOLERANCE,
}) {
  const beforeStates = new Map(
    (fromInventory?.states || []).map((state) => [state.stateId, state]),
  );
  const afterStates = new Map(
    (toInventory?.states || []).map((state) => [state.stateId, state]),
  );

  const states = [];
  const missingStates = [];

  for (const [stateId, beforeState] of beforeStates) {
    const afterState = afterStates.get(stateId);
    if (!afterState) {
      missingStates.push(stateId);
      continue;
    }
    const stateAnnotations = annotations.filter(
      (annotation) => !annotation.stateId || annotation.stateId === stateId,
    );
    states.push(
      diffState({ beforeState, afterState, annotations: stateAnnotations, tolerance }),
    );
  }

  const total = {
    added: 0,
    removed: 0,
    moved: 0,
    resized: 0,
    restyled: 0,
    reordered: 0,
    elements: 0,
    primary: 0,
    derived: 0,
    annotations: annotations.length,
    attributed: 0,
  };
  const attributed = new Set();
  for (const state of states) {
    for (const key of Object.keys(state.summary)) {
      if (key in total) total[key] += state.summary[key];
    }
    for (const cluster of state.clusters) {
      for (const id of cluster.relatedAnnotations) attributed.add(id);
    }
  }
  total.attributed = attributed.size;
  total.unattributed = annotations
    .map((annotation) => annotation.id)
    .filter((id) => !attributed.has(id));

  return {
    fromRevision,
    toRevision,
    tolerance,
    states,
    missingStates,
    summary: total,
  };
}

export function clustersById(diff) {
  const index = new Map();
  for (const state of diff?.states || []) {
    for (const cluster of state.clusters) index.set(cluster.id, cluster);
  }
  return index;
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

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.from || !args.to) {
    throw new Error(
      "Usage: revision-diff.mjs --from <inventory.json> --to <inventory.json> [--annotations <annotations.json>] [--out <diff.json>] [--tolerance 1]",
    );
  }
  const fromInventory = await readJson(args.from);
  const toInventory = await readJson(args.to);
  const annotations = args.annotations ? await readJson(args.annotations) : [];
  const diff = diffInventories({
    fromInventory,
    toInventory,
    fromRevision: fromInventory.revisionId || null,
    toRevision: toInventory.revisionId || null,
    annotations: Array.isArray(annotations) ? annotations : annotations.annotations || [],
    tolerance: args.tolerance ? Number(args.tolerance) : DEFAULT_TOLERANCE,
  });
  if (args.out) {
    await writeFile(args.out, `${JSON.stringify(diff, null, 2)}\n`, "utf8");
    console.log(`Diff written: ${path.resolve(args.out)}`);
  } else {
    console.log(JSON.stringify(diff.summary, null, 2));
    for (const state of diff.states) {
      for (const cluster of state.clusters) {
        console.log(`  ${cluster.id} [${cluster.kinds.join("+")}] ${cluster.label}`);
      }
    }
  }
  if (diff.missingStates.length > 0) {
    console.warn(`WARN: states missing in the result revision: ${diff.missingStates.join(", ")}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
