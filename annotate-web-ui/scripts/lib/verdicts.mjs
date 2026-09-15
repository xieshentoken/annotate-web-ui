// Deterministic verdict proposal.
//
// A verdict answers one question: for this annotation's stated expectation, did
// the result deliver? When the diff can answer it from evidence, it does. When
// it cannot, it says `unverified` rather than guessing — the review UI and the
// judgement layer take it from there.

const OPERATION_KINDS = {
  style: ["restyled"],
  layout: ["moved", "resized", "reordered"],
  add: ["added"],
  remove: ["removed"],
  content: ["restyled"],
  interaction: ["added", "removed", "restyled"],
  fix: ["restyled", "moved", "resized", "added", "removed"],
};

export function allClusters(diff) {
  return (diff?.states || []).flatMap((state) =>
    (state.clusters || []).map((cluster) => ({ ...cluster, stateId: cluster.stateId || state.stateId })),
  );
}

function identityMatched(cluster, annotation) {
  const target = annotation.target || {};
  if (cluster.testId && target.testId && cluster.testId === target.testId) return true;
  if (cluster.selector && target.selector && cluster.selector === target.selector) return true;
  if (
    cluster.anchor?.file &&
    target.sourceFile &&
    cluster.anchor.file === target.sourceFile &&
    (!target.sourceLine || cluster.anchor.line === Number(target.sourceLine))
  ) {
    return true;
  }
  return false;
}

function manipulationCheck(cluster, annotation, tolerance) {
  const manipulation = annotation.manipulation;
  if (!manipulation || !cluster.delta) return null;
  const asked = manipulation.delta || {};
  const observed = cluster.delta;
  const within = (a, b) => Math.abs((a || 0) - (b || 0)) <= Math.max(tolerance, 2);
  if (manipulation.mode === "move") {
    if (!cluster.kinds.includes("moved")) return { ok: false, reason: "元素未发生位移" };
    return within(asked.x, observed.x) && within(asked.y, observed.y)
      ? { ok: true, reason: `位移 ${observed.x},${observed.y} 与标注一致` }
      : {
          ok: false,
          reason: `标注要求位移 ${asked.x},${asked.y}，实际 ${observed.x},${observed.y}`,
        };
  }
  if (manipulation.mode === "resize") {
    if (!cluster.kinds.includes("resized")) return { ok: false, reason: "元素尺寸未变化" };
    return within(asked.width, observed.width) && within(asked.height, observed.height)
      ? { ok: true, reason: `尺寸变化 ${observed.width},${observed.height} 与标注一致` }
      : {
          ok: false,
          reason: `标注要求尺寸变化 ${asked.width},${observed.height}，实际 ${observed.width},${observed.height}`,
        };
  }
  return null;
}

export function proposeVerdicts(diff, annotations, { tolerance = 1 } = {}) {
  const clusters = allClusters(diff);
  const verdicts = [];

  for (const annotation of annotations) {
    const related = clusters.filter((cluster) =>
      (cluster.relatedAnnotations || []).includes(annotation.id),
    );
    const operations = annotation.intent?.operations || [];

    if (related.length === 0) {
      verdicts.push({
        annotationId: annotation.id,
        status: "unverified",
        confidence: "low",
        clusters: [],
        evidence: ["diff 未在该标注覆盖的区域检测到任何变更"],
        note: "可能是标注区域与改动位置不一致，或改动未被本次抓取捕捉。请人工确认。",
        source: "heuristic",
      });
      continue;
    }

    const kinds = new Set(related.flatMap((cluster) => cluster.kinds));
    const matched = operations.filter((operation) => {
      const accepted = OPERATION_KINDS[operation] || [];
      return accepted.some((kind) => kinds.has(kind));
    });
    const byIdentity = related.some((cluster) => identityMatched(cluster, annotation));
    const manipulation = related
      .map((cluster) => manipulationCheck(cluster, annotation, tolerance))
      .find((result) => result !== null);

    let status;
    if (operations.length === 0) status = "partial";
    else if (matched.length === operations.length) status = "satisfied";
    else if (matched.length > 0) status = "partial";
    else status = "violated";

    if (manipulation && !manipulation.ok && status === "satisfied") status = "partial";

    const evidence = related.map((cluster) => cluster.label);
    if (manipulation) evidence.push(manipulation.reason);

    let note = "";
    if (operations.length === 0) {
      note = "该标注没有声明修改类型，只能确认区域发生了变化。";
    } else if (status === "violated") {
      note = `检测到的变更是 ${[...kinds].join("、")}，与标注要求的 ${operations.join("、")} 不匹配。`;
    } else if (status === "partial") {
      note = `标注要求 ${operations.join("、")}，已匹配 ${matched.join("、") || "无"}。`;
    }
    if (related.some((cluster) => cluster.unstable)) {
      note = `${note} 部分元素缺少稳定锚点，对齐结果仅供参考。`.trim();
    }

    verdicts.push({
      annotationId: annotation.id,
      status,
      confidence: byIdentity ? "high" : related.length > 0 ? "medium" : "low",
      clusters: related.map((cluster) => cluster.id),
      evidence,
      note,
      source: "heuristic",
    });
  }

  return verdicts;
}

export function verdictSummary(verdicts) {
  const summary = { satisfied: 0, partial: 0, violated: 0, unverified: 0, total: verdicts.length };
  for (const verdict of verdicts) {
    if (verdict.status in summary) summary[verdict.status] += 1;
  }
  return summary;
}
