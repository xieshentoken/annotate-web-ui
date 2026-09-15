import assert from "node:assert/strict";
import test from "node:test";

import {
  annotationRect,
  diffInventories,
  diffState,
  intersectionOverUnion,
  markDerived,
  normalizeStyleValue,
} from "../annotate-web-ui/scripts/revision-diff.mjs";

function element(overrides = {}) {
  return {
    key: overrides.key || "k1",
    selector: overrides.selector || "#a",
    testId: overrides.testId || "",
    anchor: overrides.anchor || null,
    tag: "div",
    role: overrides.role || "",
    name: overrides.name || "",
    rect: overrides.rect || { x: 0, y: 0, width: 100, height: 40 },
    style: overrides.style || { borderRadius: "12px" },
    reuseCount: overrides.reuseCount ?? 1,
    visible: true,
    ...overrides,
  };
}

function state(stateId, elements) {
  return {
    stateId,
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    elements,
  };
}

test("identical inventories produce no clusters", () => {
  const inventory = { revisionId: "rev-001", states: [state("s1", [element()])] };
  const diff = diffInventories({ fromInventory: inventory, toInventory: inventory });
  assert.equal(diff.summary.elements, 0);
  assert.deepEqual(diff.missingStates, []);
});

test("style whitespace differences are not reported as changes", () => {
  assert.equal(normalizeStyleValue("rgb(1, 2, 3)"), normalizeStyleValue("rgb(1,2,3)"));
  assert.equal(normalizeStyleValue("  8px   16px "), "8px 16px");
  const before = state("s1", [element({ style: { color: "rgb(1, 2, 3)" } })]);
  const after = state("s1", [element({ style: { color: "rgb(1,2,3)" } })]);
  const result = diffState({ beforeState: before, afterState: after });
  assert.equal(result.clusters.length, 0);
});

test("a restyle reports the exact property transition", () => {
  const before = state("s1", [element({ style: { borderRadius: "12px" } })]);
  const after = state("s1", [element({ style: { borderRadius: "4px" } })]);
  const result = diffState({ beforeState: before, afterState: after });
  assert.equal(result.clusters.length, 1);
  const [cluster] = result.clusters;
  assert.deepEqual(cluster.kinds, ["restyled"]);
  assert.deepEqual(cluster.delta.style.borderRadius, ["12px", "4px"]);
  assert.match(cluster.label, /borderRadius 12px -> 4px/);
});

test("one element can be moved and resized in the same round", () => {
  const before = state("s1", [element({ rect: { x: 0, y: 0, width: 100, height: 40 } })]);
  const after = state("s1", [element({ rect: { x: 32, y: 0, width: 120, height: 40 } })]);
  const result = diffState({ beforeState: before, afterState: after });
  const [cluster] = result.clusters;
  assert.deepEqual(cluster.kinds.sort(), ["moved", "resized"]);
  assert.equal(cluster.delta.x, 32);
  assert.equal(cluster.delta.width, 20);
  assert.equal(cluster.summary, undefined);
});

test("sub-tolerance movement is ignored", () => {
  const before = state("s1", [element({ rect: { x: 0, y: 0, width: 100, height: 40 } })]);
  const after = state("s1", [element({ rect: { x: 1, y: 0, width: 100, height: 40 } })]);
  assert.equal(diffState({ beforeState: before, afterState: after }).clusters.length, 0);
  assert.equal(
    diffState({ beforeState: before, afterState: after, tolerance: 0 }).clusters.length,
    1,
  );
});

test("added and removed elements are reported per key", () => {
  const before = state("s1", [element({ key: "gone" })]);
  const after = state("s1", [element({ key: "fresh" })]);
  const result = diffState({ beforeState: before, afterState: after });
  const kinds = result.clusters.map((cluster) => cluster.kinds[0]).sort();
  assert.deepEqual(kinds, ["added", "removed"]);
  assert.equal(result.summary.added, 1);
  assert.equal(result.summary.removed, 1);
});

test("annotations are attributed by test id before geometry", () => {
  const before = state("s1", [element({ key: "k", testId: "card-1" })]);
  const after = state("s1", [
    element({ key: "k", testId: "card-1", style: { borderRadius: "4px" } }),
  ]);
  const annotations = [
    {
      id: "A1",
      kind: "box",
      geometry: { x: 0, y: 0, width: 100, height: 40 },
      target: { testId: "card-1" },
    },
  ];
  const result = diffState({ beforeState: before, afterState: after, annotations });
  assert.deepEqual(result.clusters[0].relatedAnnotations, ["A1"]);
});

test("annotations are attributed by geometry when identity is absent", () => {
  const before = state("s1", [element({ key: "k", rect: { x: 10, y: 10, width: 100, height: 40 } })]);
  const after = state("s1", [
    element({ key: "k", rect: { x: 10, y: 10, width: 100, height: 40 }, style: { color: "red" } }),
  ]);
  const overlapping = {
    id: "A1",
    kind: "box",
    geometry: { x: 20, y: 20, width: 60, height: 20 },
  };
  const farAway = {
    id: "A2",
    kind: "box",
    geometry: { x: 900, y: 900, width: 40, height: 40 },
  };
  const result = diffState({
    beforeState: before,
    afterState: after,
    annotations: [overlapping, farAway],
  });
  assert.deepEqual(result.clusters[0].relatedAnnotations, ["A1"]);
});

test("a point annotation reduces to a padded bounding box", () => {
  const rect = annotationRect({ kind: "point", geometry: { x: 100, y: 100 } });
  assert.deepEqual(rect, { x: 92, y: 92, width: 16, height: 16 });
});

test("an arrow annotation reduces to the bounding box of its endpoints", () => {
  const rect = annotationRect({
    kind: "arrow",
    geometry: { x1: 300, y1: 200, x2: 100, y2: 50 },
  });
  assert.deepEqual(rect, { x: 100, y: 50, width: 200, height: 150 });
});

test("intersection over union is zero for disjoint rects", () => {
  assert.equal(
    intersectionOverUnion(
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 100, y: 100, width: 10, height: 10 },
    ),
    0,
  );
});

test("a state present only in the baseline is recorded as missing, not faked", () => {
  const from = { revisionId: "rev-001", states: [state("s1", [element()]), state("s2", [element()])] };
  const to = { revisionId: "rev-002", states: [state("s1", [element()])] };
  const diff = diffInventories({ fromInventory: from, toInventory: to });
  assert.deepEqual(diff.missingStates, ["s2"]);
  assert.equal(diff.states.length, 1);
});

test("unattributed annotations are listed so the caller can ask for clarification", () => {
  const before = state("s1", [element({ key: "k", rect: { x: 0, y: 0, width: 10, height: 10 } })]);
  const after = state("s1", [
    element({ key: "k", rect: { x: 0, y: 0, width: 10, height: 10 }, style: { color: "red" } }),
  ]);
  const annotations = [
    { id: "A1", kind: "box", geometry: { x: 0, y: 0, width: 10, height: 10 } },
    { id: "A9", kind: "box", geometry: { x: 800, y: 800, width: 10, height: 10 } },
  ];
  const diff = diffInventories({
    fromInventory: { revisionId: "rev-001", states: [before] },
    toInventory: { revisionId: "rev-002", states: [after] },
    annotations,
  });
  assert.equal(diff.summary.attributed, 1);
  assert.deepEqual(diff.summary.unattributed, ["A9"]);
});

test("cluster ids are stable and read in display order", () => {
  const before = state("s1", [
    element({ key: "small", rect: { x: 0, y: 0, width: 10, height: 10 } }),
    element({ key: "big", rect: { x: 0, y: 100, width: 400, height: 300 } }),
  ]);
  const after = state("s1", [
    element({ key: "small", rect: { x: 0, y: 0, width: 10, height: 10 }, style: { color: "red" } }),
    element({ key: "big", rect: { x: 0, y: 100, width: 400, height: 300 }, style: { color: "red" } }),
  ]);
  const result = diffState({ beforeState: before, afterState: after });
  assert.deepEqual(
    result.clusters.map((cluster) => cluster.id),
    ["c1", "c2"],
  );
  assert.equal(result.clusters[0].key, "big");
});

test("a child displaced by its changed parent is marked derived", () => {
  const before = state("s1", [
    element({ key: "card", parentKey: null, style: { padding: "16px" } }),
    element({ key: "label", parentKey: "card", rect: { x: 16, y: 16, width: 80, height: 20 } }),
  ]);
  const after = state("s1", [
    element({ key: "card", parentKey: null, style: { padding: "12px" } }),
    element({ key: "label", parentKey: "card", rect: { x: 12, y: 12, width: 80, height: 20 } }),
  ]);
  const result = diffState({ beforeState: before, afterState: after });
  const card = result.clusters.find((cluster) => cluster.key === "card");
  const label = result.clusters.find((cluster) => cluster.key === "label");
  assert.equal(card.derived, undefined);
  assert.equal(label.derived, true);
  assert.equal(label.derivedFrom, "card");
  assert.equal(label.derivedReason, "ancestor-changed");
  assert.equal(result.summary.primary, 1);
  assert.equal(result.summary.derived, 1);
});

test("a restyle on a child is never treated as derived", () => {
  const before = state("s1", [
    element({ key: "card", parentKey: null, style: { padding: "16px" } }),
    element({ key: "btn", parentKey: "card", style: { backgroundColor: "rgb(24,95,165)" } }),
  ]);
  const after = state("s1", [
    element({ key: "card", parentKey: null, style: { padding: "12px" } }),
    element({ key: "btn", parentKey: "card", style: { backgroundColor: "rgb(15,110,86)" } }),
  ]);
  const result = diffState({ beforeState: before, afterState: after });
  const btn = result.clusters.find((cluster) => cluster.key === "btn");
  assert.equal(btn.derived, undefined);
  assert.deepEqual(btn.kinds, ["restyled"]);
});

test("siblings displaced by a removal are marked derived", () => {
  const before = state("s1", [
    element({ key: "grid", parentKey: null }),
    element({ key: "a", parentKey: "grid", rect: { x: 0, y: 0, width: 100, height: 50 } }),
    element({ key: "b", parentKey: "grid", rect: { x: 110, y: 0, width: 100, height: 50 } }),
  ]);
  const after = state("s1", [
    element({ key: "grid", parentKey: null }),
    element({ key: "b", parentKey: "grid", rect: { x: 0, y: 0, width: 100, height: 50 } }),
  ]);
  const result = diffState({ beforeState: before, afterState: after });
  const removed = result.clusters.find((cluster) => cluster.kinds.includes("removed"));
  const shifted = result.clusters.find((cluster) => cluster.key === "b");
  assert.equal(removed.derived, undefined);
  assert.equal(shifted.derived, true);
  assert.equal(shifted.derivedReason, "sibling-shift");
});

test("derived clusters sort after primary ones", () => {
  const clusters = [
    { id: "c1", key: "child", kinds: ["moved"], derived: true },
    { id: "c2", key: "parent", kinds: ["restyled"] },
  ];
  markDerived(clusters, []);
  const sorted = [...clusters].sort((a, b) => (a.derived ? 1 : 0) - (b.derived ? 1 : 0));
  assert.equal(sorted[0].key, "parent");
});

test("removing a container collapses its whole subtree to one cluster", () => {
  const before = state("s1", [
    element({ key: "card", parentKey: null }),
    element({ key: "title", parentKey: "card" }),
    element({ key: "body", parentKey: "card" }),
  ]);
  const after = state("s1", [element({ key: "other", parentKey: null })]);
  const result = diffState({ beforeState: before, afterState: after });
  const removed = result.clusters.filter((cluster) => cluster.kinds[0] === "removed");
  const outer = removed.find((cluster) => cluster.key === "card");
  const inner = removed.filter((cluster) => cluster.derived);
  assert.equal(outer.derived, undefined);
  assert.equal(inner.length, 2);
  assert.equal(inner[0].derivedReason, "subtree-removed");
  assert.equal(inner[0].derivedFrom, "card");
});

test("a box annotation overlapping a subtree does not promote its descendants", () => {
  const before = state("s1", [
    element({ key: "card", parentKey: null, testId: "card", rect: { x: 0, y: 0, width: 400, height: 200 } }),
    element({ key: "inner", parentKey: "card", rect: { x: 10, y: 10, width: 100, height: 40 } }),
  ]);
  const after = state("s1", [
    element({ key: "card", parentKey: null, testId: "card", rect: { x: 0, y: 0, width: 400, height: 200 }, style: { padding: "12px" } }),
    element({ key: "inner", parentKey: "card", rect: { x: 6, y: 6, width: 100, height: 40 } }),
  ]);
  const annotations = [
    {
      id: "A1",
      kind: "box",
      geometry: { x: 0, y: 0, width: 400, height: 200 },
      target: { testId: "card" },
    },
  ];
  const result = diffState({ beforeState: before, afterState: after, annotations });
  const card = result.clusters.find((cluster) => cluster.key === "card");
  const inner = result.clusters.find((cluster) => cluster.key === "inner");
  assert.deepEqual(card.directlyAnnotated, ["A1"]);
  assert.deepEqual(inner.directlyAnnotated, []);
  assert.deepEqual(inner.relatedAnnotations, ["A1"]);
  assert.equal(inner.derived, true);
});

test("a cluster named by an annotation stays primary even when its parent changed", () => {
  const before = state("s1", [
    element({ key: "grid", parentKey: null, selector: ".grid", style: { gap: "16px" } }),
    element({ key: "cell", parentKey: "grid", selector: ".cell", rect: { x: 0, y: 0, width: 100, height: 50 } }),
  ]);
  const after = state("s1", [
    element({ key: "grid", parentKey: null, selector: ".grid", style: { gap: "24px" } }),
    element({ key: "cell", parentKey: "grid", selector: ".cell", rect: { x: 0, y: 0, width: 120, height: 50 } }),
  ]);
  const annotations = [
    { id: "A1", kind: "element", geometry: { x: 0, y: 0, width: 120, height: 50 }, target: { selector: ".cell" } },
  ];
  const result = diffState({ beforeState: before, afterState: after, annotations });
  const cell = result.clusters.find((cluster) => cluster.key === "cell");
  assert.deepEqual(cell.directlyAnnotated, ["A1"]);
  assert.equal(cell.derived, undefined);
});

test("width and height in a stored style object cannot fake a restyle", () => {
  const before = state("s1", [
    element({ rect: { x: 0, y: 0, width: 100, height: 40 }, style: { width: "100px", height: "40px" } }),
  ]);
  const after = state("s1", [
    element({ rect: { x: 0, y: 0, width: 120, height: 40 }, style: { width: "120px", height: "40px" } }),
  ]);
  const result = diffState({ beforeState: before, afterState: after });
  assert.deepEqual(result.clusters[0].kinds, ["resized"]);
});

test("a shared anchor does not let an annotation name every sibling", () => {
  const anchor = { file: "src/components/Card.tsx", line: 12, component: "Card" };
  const before = state("s1", [
    element({ key: "a", testId: "card-a", anchor, style: { padding: "16px" } }),
    element({ key: "b", testId: "card-b", anchor, style: { padding: "16px" } }),
  ]);
  const after = state("s1", [
    element({ key: "a", testId: "card-a", anchor, style: { padding: "12px" } }),
    element({ key: "b", testId: "card-b", anchor, style: { padding: "12px" } }),
  ]);
  const annotations = [
    {
      id: "A1",
      kind: "element",
      geometry: { x: 0, y: 0, width: 100, height: 40 },
      target: { testId: "card-a", sourceFile: "src/components/Card.tsx", sourceLine: 12 },
    },
  ];
  const result = diffState({ beforeState: before, afterState: after, annotations });
  const a = result.clusters.find((cluster) => cluster.key === "a");
  const b = result.clusters.find((cluster) => cluster.key === "b");
  assert.deepEqual(a.directlyAnnotated, ["A1"]);
  assert.deepEqual(b.directlyAnnotated, []);
});

test("an annotation with no test id still matches every instance by anchor", () => {
  const anchor = { file: "src/components/Card.tsx", line: 18, component: "Card" };
  const before = state("s1", [
    element({ key: "a", testId: "card-a", anchor, style: { backgroundColor: "rgb(24,95,165)" } }),
    element({ key: "b", testId: "card-b", anchor, style: { backgroundColor: "rgb(24,95,165)" } }),
  ]);
  const after = state("s1", [
    element({ key: "a", testId: "card-a", anchor, style: { backgroundColor: "rgb(15,110,86)" } }),
    element({ key: "b", testId: "card-b", anchor, style: { backgroundColor: "rgb(15,110,86)" } }),
  ]);
  const annotations = [
    {
      id: "A2",
      kind: "element",
      geometry: { x: 0, y: 0, width: 100, height: 40 },
      target: { sourceFile: "src/components/Card.tsx", sourceLine: 18 },
    },
  ];
  const result = diffState({ beforeState: before, afterState: after, annotations });
  for (const cluster of result.clusters) {
    assert.deepEqual(cluster.directlyAnnotated, ["A2"]);
  }
});

test("a named descendant of a removed subtree is still collapsed away", () => {
  const before = state("s1", [
    element({ key: "card", parentKey: null, testId: "card-a" }),
    element({ key: "price", parentKey: "card", selector: ".price" }),
  ]);
  const after = state("s1", []);
  const annotations = [
    {
      id: "A1",
      kind: "element",
      geometry: { x: 0, y: 0, width: 100, height: 40 },
      target: { selector: ".price" },
    },
  ];
  const result = diffState({ beforeState: before, afterState: after, annotations });
  const price = result.clusters.find((cluster) => cluster.key === "price");
  assert.deepEqual(price.directlyAnnotated, ["A1"]);
  assert.equal(price.derived, true);
  assert.equal(price.derivedReason, "subtree-removed");
});
