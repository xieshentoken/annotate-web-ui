/* Tests for the schema 1.3 additions: `annotation.alias` and session `groups`.
 *
 * Two groups of rules are covered here, and they are deliberately different:
 *
 *   - an `alias` is a name the user typed. A bad or colliding name is a
 *     *warning* and is never rewritten or dropped, because resolving a naming
 *     conflict is the user's call and `id`/`target` still identify the element;
 *   - a `group` is structure the user drew. Naming an annotation that does not
 *     exist is an *error*, because silently dropping the member would change
 *     what the user asked for.
 *
 * The rendering half checks the contract the prompt states: alias always beside
 * `id` and the anchor, a manipulation split into geometry truth plus a semantic
 * hint with a mandatory breakpoint, and the `cohesion`-specific group wording.
 *
 * Everything here is pure Node: no Chrome, no compiler, no node_modules.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  changeRequestMarkdown,
  implementationPrompt,
} from "../annotate-web-ui/scripts/build-change-spec.mjs";
import { pruneGroups } from "../annotate-web-ui/scripts/consolidate-review.mjs";
import { normalizeSession } from "../annotate-web-ui/scripts/lib/session.mjs";
import { validateSessionData } from "../annotate-web-ui/scripts/validate-session.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONSOLIDATE = path.join(
  ROOT,
  "annotate-web-ui",
  "scripts",
  "consolidate-review.mjs",
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function capturedState() {
  return {
    id: "S1",
    title: "Home",
    description: "Default desktop view",
    url: "http://localhost:5173/",
    capturedAt: "2026-09-18T10:01:00.000Z",
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    scroll: { x: 0, y: 0 },
    beforeImage: "before-S1.png",
    annotatedImage: "annotated-S1.png",
  };
}

function annotation(id, overrides = {}) {
  return {
    id,
    stateId: "S1",
    kind: "element",
    geometry: { x: 10, y: 20, width: 100, height: 40 },
    target: { tag: "div", testId: "card" },
    intent: {
      operations: ["layout"],
      expected: `${id} expected`,
      scope: "element",
      breakpoint: "all",
      priority: "must",
    },
    ...overrides,
  };
}

function session(overrides = {}) {
  return {
    schemaVersion: "1.3",
    sessionId: "20260918-000000-alias",
    createdAt: "2026-09-18T10:00:00.000Z",
    repoPath: "/repo",
    targetUrl: "http://localhost:5173/",
    states: [capturedState()],
    annotations: [annotation("A1"), annotation("A2")],
    ...overrides,
  };
}

/* A resolved annotation as `buildChangeSpec` hands it to the renderers. The
 * index is faked because the renderers only read the resolver summary out of
 * it — resolution itself is covered by symbol-index.test.mjs. */
const INDEX = {
  engine: "ast",
  parser: {
    available: true,
    from: "/tmp/node_modules/@babel/parser",
    failures: [],
  },
  stats: {
    files: 3,
    parsed: 3,
    lexical: 0,
    failed: 0,
    elements: 9,
    sites: 12,
    locales: 0,
    i18nEntries: 0,
  },
  records: new Map(),
};

function candidate(overrides = {}) {
  return {
    file: "src/Hero.tsx",
    line: 12,
    column: 0,
    endLine: 20,
    score: 100,
    confidence: "high",
    resolver: "ast",
    evidence: [],
    element: { tag: "div", component: "Hero", testId: "hero" },
    i18nKey: null,
    corroborated: null,
    ...overrides,
  };
}

function resolved(base, candidates = []) {
  return {
    ...base,
    sourceCandidates: candidates,
    sourceMetadataRejected: null,
  };
}

function manipulation(overrides = {}) {
  return {
    mode: "move",
    key: "src/Hero.tsx:12#Hero",
    before: { x: 100, y: 200, width: 120, height: 40 },
    after: { x: 132, y: 200, width: 120, height: 40 },
    delta: { x: 32, y: 0, width: 0, height: 0 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("a duplicate alias is a warning, and neither name is rewritten", () => {
  const data = session({
    annotations: [
      annotation("A1", { alias: "Header" }),
      annotation("A2", { alias: "Header" }),
    ],
  });
  const { errors, warnings } = validateSessionData(data);

  assert.equal(
    errors.some((error) => error.includes("alias")),
    false,
    "a naming collision must not block the session",
  );
  assert.ok(
    warnings.some(
      (warning) =>
        warning.includes("alias") && warning.includes("already used"),
    ),
    "the collision must be reported",
  );
  assert.equal(data.annotations[0].alias, "Header");
  assert.equal(data.annotations[1].alias, "Header");
  assert.equal(
    data.annotations[1].id,
    "A2",
    "the id must survive a name collision unchanged",
  );
});

test("an unusable alias warns and is never rewritten or dropped", () => {
  const data = session({
    annotations: [
      annotation("A1", { alias: "头部 卡片" }),
      annotation("A2", { alias: 7 }),
    ],
  });
  const { errors, warnings } = validateSessionData(data);

  assert.equal(errors.length, 0);
  assert.ok(
    warnings.some(
      (warning) => warning.includes("alias") && warning.includes("does not match"),
    ),
    "an alias outside the character set must be reported",
  );
  assert.ok(
    warnings.some((warning) => warning.includes("is not a string")),
    "a non-string alias is a warning, not a crash",
  );
  assert.equal(data.annotations[0].alias, "头部 卡片");
  assert.equal(data.annotations[1].alias, 7);
});

test("a group naming an annotation that does not exist is an error", () => {
  const { errors, warnings } = validateSessionData(
    session({
      groups: [
        {
          id: "G1",
          name: "Hero 区",
          annotationIds: ["A1", "A9"],
          cohesion: "container",
          containerKey: "src/Hero.tsx:12#Hero",
        },
      ],
    }),
  );

  assert.ok(
    errors.some(
      (error) =>
        error.includes("groups[0].annotationIds") && error.includes("A9"),
    ),
    "membership must be checked against the session's own annotations",
  );
  assert.equal(
    warnings.some((warning) => warning.includes("A9")),
    false,
    "an unknown member is an error, not a warning",
  );
});

test("a well-formed group passes, and the name may be Chinese", () => {
  const { errors } = validateSessionData(
    session({
      groups: [
        {
          id: "G1",
          name: "Hero 区",
          annotationIds: ["A1", "A2"],
          cohesion: "component",
        },
      ],
    }),
  );
  assert.deepEqual(errors, []);
});

test("cohesion must be one of the three values, and container needs its key", () => {
  const unknown = validateSessionData(
    session({
      groups: [
        { id: "G1", name: "Hero", annotationIds: ["A1"], cohesion: "nearby" },
      ],
    }),
  );
  assert.ok(
    unknown.errors.some((error) => error.includes("cohesion")),
    "an unknown cohesion must be rejected",
  );

  const noContainer = validateSessionData(
    session({
      groups: [
        { id: "G1", name: "Hero", annotationIds: ["A1"], cohesion: "container" },
      ],
    }),
  );
  assert.ok(
    noContainer.errors.some((error) => error.includes("containerKey")),
    "a container group has to name its container",
  );

  const unnamed = validateSessionData(
    session({
      groups: [
        { id: "G1", name: "  ", annotationIds: ["A1"], cohesion: "mixed" },
      ],
    }),
  );
  assert.ok(
    unnamed.errors.some((error) => error.includes("name")),
    "a group without a name is an error",
  );
});

test("reference is optional, and must carry a styleTarget when present", () => {
  assert.deepEqual(validateSessionData(session({ reference: null })).errors, []);
  assert.deepEqual(
    validateSessionData(
      session({ reference: { styleTarget: "reference/style-target.json" } }),
    ).errors,
    [],
  );
  assert.ok(
    validateSessionData(session({ reference: { styleTarget: "" } })).errors.some(
      (error) => error.includes("reference.styleTarget"),
    ),
  );
  assert.ok(
    validateSessionData(session({ reference: "style-target.json" })).errors.some(
      (error) => error.includes("reference"),
    ),
  );
});

// ---------------------------------------------------------------------------
// build-change-spec rendering
// ---------------------------------------------------------------------------

test("the change request prints the alias beside the id and the anchor", () => {
  const annotations = [
    resolved(
      annotation("A1", {
        alias: "HeaderCard",
        target: {
          tag: "div",
          testId: "card",
          sourceFile: "src/Hero.tsx",
          sourceLine: 12,
        },
      }),
      [candidate()],
    ),
  ];
  const request = changeRequestMarkdown(
    session(),
    annotations,
    "/tmp/session",
    INDEX,
  );
  const prompt = implementationPrompt(
    session(),
    annotations,
    "/tmp/session",
    INDEX,
  );

  assert.ok(request.includes("- Name: HeaderCard"), "the request names it");
  assert.ok(request.includes("### A1 —"), "the id still keys the section");
  assert.ok(
    request.includes("src/Hero.tsx:12"),
    "the anchor is still printed next to the name",
  );
  assert.ok(
    request.includes("- [ ] A1 (HeaderCard):"),
    "acceptance criteria carry both",
  );
  assert.ok(
    prompt.includes("- A1 (HeaderCard) @ src/Hero.tsx:12 (high)"),
    "the agent prompt carries the name with the id and the anchor",
  );
});

test("a manipulation renders as geometry truth plus a semantic hint", () => {
  const annotations = [
    resolved(
      annotation("A1", {
        alias: "HeaderCard",
        intent: {
          operations: ["layout"],
          expected: "在这一行里均匀排布，不再靠绝对位移",
          scope: "repeated",
          breakpoint: "desktop",
          priority: "must",
        },
        manipulation: manipulation(),
      }),
      [candidate()],
    ),
  ];
  // With an expected result the annotation is a real change: not blocked.
  const request = changeRequestMarkdown(
    session(),
    annotations,
    "/tmp/session",
    INDEX,
  );
  const prompt = implementationPrompt(
    session(),
    annotations,
    "/tmp/session",
    INDEX,
  );

  assert.ok(request.includes("Manipulation (geometry truth)"));
  assert.ok(request.includes("mode=move"));
  assert.ok(request.includes("key=`src/Hero.tsx:12#Hero`"));
  assert.ok(request.includes("before [x=100 y=200 w=120 h=40]"));
  assert.ok(request.includes("after [x=132 y=200 w=120 h=40]"));
  assert.ok(request.includes("delta [x=32 y=0 w=0 h=0] in CSS px"));
  assert.ok(request.includes("Manipulation (semantic hint)"));
  for (const mechanism of ["gap", "order", "flex-basis"]) {
    assert.ok(
      request.includes(mechanism),
      `the hint must name ${mechanism} as the source mechanism`,
    );
  }
  assert.ok(
    request.includes("Required responsive scope (breakpoint): desktop"),
    "the breakpoint is carried with the gesture",
  );
  assert.ok(prompt.includes("  - Manipulation (geometry truth)"));
  assert.ok(prompt.includes("  - Manipulation (semantic hint)"));
  assert.ok(
    request.includes("## Unresolved items") &&
      request.includes("- None detected by the deterministic resolver."),
    "a manipulation with an expected result is not a blocking problem",
  );
});

test("a manipulation with no expected result is blocked from the numbered changes", () => {
  const annotations = [
    resolved(
      annotation("A1", {
        alias: "HeaderCard",
        intent: {
          operations: ["layout"],
          expected: "   ",
          scope: "element",
          breakpoint: "all",
          priority: "must",
        },
        manipulation: manipulation(),
      }),
      [candidate()],
    ),
  ];
  const request = changeRequestMarkdown(
    session(),
    annotations,
    "/tmp/session",
    INDEX,
  );
  const unresolved = request.slice(request.indexOf("## Unresolved items"));

  assert.ok(
    unresolved.includes("A1: direct manipulation with no expected result"),
    "the blocked annotation must be listed under unresolved items",
  );
  assert.equal(
    unresolved.includes("None detected"),
    false,
    "the unresolved section must not claim there is nothing to resolve",
  );

  const prompt = implementationPrompt(
    session(),
    annotations,
    "/tmp/session",
    INDEX,
  );
  assert.ok(prompt.includes("Blocked — do not implement: A1"));
  const numbered = prompt.slice(prompt.indexOf("Numbered changes:"));
  assert.equal(
    /- A1\b/.test(numbered),
    false,
    "an unexportable manipulation must not appear as a numbered change",
  );
});

test("each cohesion gets its own wording, and mixed forbids inventing a container", () => {
  const data = session({
    groups: [
      {
        id: "G1",
        name: "Hero 区",
        annotationIds: ["A1", "A2"],
        cohesion: "container",
        containerKey: "src/Hero.tsx:12#Hero",
        container: { anchor: { file: "src/Hero.tsx", line: 12, component: "Hero" } },
      },
      { id: "G2", name: "Cards", annotationIds: ["A1"], cohesion: "component" },
      { id: "G3", name: "Bits", annotationIds: ["A1", "A2"], cohesion: "mixed" },
    ],
  });
  const annotations = [
    resolved(
      annotation("A1", {
        alias: "HeaderCard",
        target: { tag: "div", testId: "card", componentName: "Hero" },
      }),
      [candidate()],
    ),
    resolved(annotation("A2", { target: { tag: "p" } })),
  ];
  const request = changeRequestMarkdown(
    data,
    annotations,
    "/tmp/session",
    INDEX,
  );
  const prompt = implementationPrompt(data, annotations, "/tmp/session", INDEX);

  assert.ok(request.includes("## Groups"));
  assert.ok(prompt.includes("## Groups"), "both views carry the section");

  assert.ok(request.includes("### Hero 区 (cohesion: container)"));
  assert.ok(
    request.includes("- Members: A1 (HeaderCard), A2"),
    "members are listed by id with the alias beside it",
  );
  assert.ok(
    request.includes("`src/Hero.tsx:12 (Hero)`"),
    "a container group names the container anchor",
  );
  assert.ok(request.includes("One adjustment applied inside that container"));

  assert.ok(request.includes("(cohesion: component)"));
  assert.ok(
    request.includes("one component (`Hero`)") &&
      request.includes("rather than to a container"),
    "a component group names the component",
  );

  assert.ok(request.includes("(cohesion: mixed)"));
  assert.ok(
    request.includes("do not invent a container to group them behind"),
    "mixed must forbid the agent to invent a container",
  );
  assert.ok(
    request.includes("Change each member individually"),
    "mixed lists the members for individual changes",
  );
});

// ---------------------------------------------------------------------------
// consolidate-review
// ---------------------------------------------------------------------------

test("a closed annotation leaves its group, and an emptied group is dropped", () => {
  const groups = [
    {
      id: "G1",
      name: "Hero 区",
      annotationIds: ["A1", "A2"],
      cohesion: "container",
      containerKey: "src/Hero.tsx:12#Hero",
    },
    { id: "G2", name: "Cards", annotationIds: ["A2"], cohesion: "component" },
  ];
  const kept = pruneGroups(groups, ["A2"]);

  assert.deepEqual(
    kept.map((group) => group.id),
    ["G1"],
    "a group whose members all closed is dropped, not kept empty",
  );
  assert.deepEqual(kept[0].annotationIds, ["A1"]);
  assert.equal(
    kept[0].cohesion,
    "container",
    "cohesion is preserved, never recomputed from the surviving members",
  );
  assert.deepEqual(
    groups[0].annotationIds,
    ["A1", "A2"],
    "the input must not be mutated",
  );
});

test("consolidate keeps alias and groups end to end and drops the closed member", () => {
  const dir = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "symbui-alias-"),
  );
  const revision = (id, role) => ({
    id,
    roundIndex: role === "baseline" ? 0 : 1,
    role,
    createdAt: "2026-09-18T10:00:00.000Z",
    git: { head: null, dirty: null },
    states: [],
    inventory: null,
  });

  fs.writeFileSync(
    path.join(dir, "session.json"),
    JSON.stringify(
      {
        schemaVersion: "1.3",
        sessionId: "20260918-000000-alias",
        createdAt: "2026-09-18T10:00:00.000Z",
        repoPath: null,
        targetUrl: "http://localhost:5173/",
        revisions: [revision("rev-001", "baseline"), revision("rev-002", "result")],
        rounds: [
          {
            id: "R1",
            index: 1,
            fromRevision: "rev-001",
            toRevision: "rev-002",
            closedAt: "2026-09-18T10:05:00.000Z",
            annotations: [
              annotation("A1", { alias: "HeaderCard", revisionId: "rev-002" }),
              annotation("A2", { alias: "CardBody", revisionId: "rev-002" }),
            ],
            diff: null,
            verdicts: [
              { annotationId: "A1", status: "unverified", confidence: "low", evidence: [] },
              { annotationId: "A2", status: "satisfied", confidence: "high", evidence: [] },
            ],
            reviewAnnotations: [],
            consolidatedRequest: null,
          },
        ],
        groups: [
          {
            id: "G1",
            name: "Hero 区",
            annotationIds: ["A1", "A2"],
            cohesion: "container",
            containerKey: "src/Hero.tsx:12#Hero",
            container: {
              anchor: { file: "src/Hero.tsx", line: 12, component: "Hero" },
            },
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  /* `consolidate` reads the reviewer's decisions from the round directory, and
   * a legacy resolver treats a missing file as an error, so the empty payload
   * the review step would have written has to exist. */
  fs.mkdirSync(path.join(dir, "rounds", "R1"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "rounds", "R1", "review-annotations.json"),
    JSON.stringify({ verdicts: [], annotations: [] }, null, 2),
    "utf8",
  );

  /* The child gets its own HOME so a developer's `~/.symbui/config.json` cannot
   * change `review.maxRounds` under the test. */
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "symbui-home-"));
  const stdout = execFileSync(process.execPath, [CONSOLIDATE, "--session", dir], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });

  const written = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"));
  assert.deepEqual(
    written.groups.map((group) => group.id),
    ["G1"],
    "the group survives the round",
  );
  assert.deepEqual(
    written.groups[0].annotationIds,
    ["A1"],
    "the satisfied annotation must be removed from the group",
  );
  assert.equal(written.groups[0].name, "Hero 区");
  assert.equal(written.groups[0].cohesion, "container");

  const nextRound = written.rounds.find((round) => round.id === "R2");
  assert.ok(nextRound, "a pending next round is opened");
  assert.equal(nextRound.annotations.length, 1);
  assert.equal(
    nextRound.annotations[0].alias,
    "HeaderCard",
    "alias is carried into the next round",
  );

  const input = JSON.parse(
    fs.readFileSync(path.join(dir, "rounds", "R1", "review-input.json"), "utf8"),
  );
  assert.equal(input.find((item) => item.id === "A1").alias, "HeaderCard");
  assert.equal(
    input.find((item) => item.id === "A2"),
    undefined,
    "a closed annotation is not carried forward",
  );

  const requestMatch = /SYMBUI_CHANGE_REQUEST=(.+)/.exec(stdout);
  assert.ok(requestMatch, "the script reports the artifact it wrote");
  const request = fs.readFileSync(requestMatch[1].trim(), "utf8");
  assert.ok(request.includes("A1（HeaderCard）"), "the Chinese report prints alias with id");
  assert.ok(request.includes("## Groups"));
  assert.ok(request.includes("成员：A1（HeaderCard）"));
  assert.ok(
    request.includes("~~A2~~（CardBody）"),
    "the closed list prints the alias beside the id as well",
  );
  assert.ok(
    request.includes("container / 同一容器"),
    "the cohesion value and its meaning both survive the round",
  );
});

// ---------------------------------------------------------------------------
// Export gates: manipulation key, expected result, schema version
// ---------------------------------------------------------------------------

/* The schema states that a manipulating annotation with no `expected` must not
 * be exported. `build-change-spec` and the overlay both enforce it; consolidate
 * has to enforce it too, because it renders the re-issued annotations and the
 * ones drawn in the review UI straight into the next round's request. The
 * gate runs before anything is written, so a blocked round leaves no artifact
 * behind and opens no next round. */
test("consolidate refuses a bare delta and writes no artifact", () => {
  const dir = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "symbui-gate-"),
  );
  const revision = (id, role) => ({
    id,
    roundIndex: role === "baseline" ? 0 : 1,
    role,
    createdAt: "2026-09-18T10:00:00.000Z",
    git: { head: null, dirty: null },
    states: [],
    inventory: null,
  });

  fs.writeFileSync(
    path.join(dir, "session.json"),
    JSON.stringify(
      {
        schemaVersion: "1.3",
        sessionId: "20260918-000000-gate",
        createdAt: "2026-09-18T10:00:00.000Z",
        repoPath: null,
        targetUrl: "http://localhost:5173/",
        revisions: [revision("rev-001", "baseline"), revision("rev-002", "result")],
        rounds: [
          {
            id: "R1",
            index: 1,
            fromRevision: "rev-001",
            toRevision: "rev-002",
            closedAt: "2026-09-18T10:05:00.000Z",
            annotations: [
              annotation("A1", {
                revisionId: "rev-002",
                // A gesture with no stated result: a measurement, not an instruction.
                intent: {
                  operations: ["layout"],
                  expected: "   ",
                  scope: "element",
                  breakpoint: "all",
                  priority: "must",
                },
                manipulation: manipulation(),
              }),
            ],
            diff: null,
            verdicts: [],
            reviewAnnotations: [],
            consolidatedRequest: null,
          },
        ],
        groups: [],
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.mkdirSync(path.join(dir, "rounds", "R1"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "rounds", "R1", "review-annotations.json"),
    JSON.stringify({ verdicts: [], annotations: [] }, null, 2),
    "utf8",
  );

  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "symbui-home-"));
  let failure = null;
  try {
    execFileSync(process.execPath, [CONSOLIDATE, "--session", dir], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure, "a bare delta must stop the consolidation");
  assert.notEqual(failure.status, 0, "the script must exit non-zero");
  assert.match(
    String(failure.stderr),
    /A1/,
    "the blocked annotation must be named in the error",
  );

  const roundDir = path.join(dir, "rounds", "R1");
  const artifacts = fs
    .readdirSync(roundDir)
    .filter((name) =>
      /^(change-request-|implementation-prompt-|review-input\.json$)/.test(name),
    );
  assert.deepEqual(artifacts, [], "no artifact may be written when the round is blocked");

  const written = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"));
  assert.equal(written.rounds.length, 1, "no next round may be opened");
});

test("a manipulation key is required in 1.3 and only warned about before then", () => {
  const keyless = (schemaVersion) =>
    session({
      schemaVersion,
      annotations: [
        annotation("A1", {
          manipulation: manipulation({ key: undefined }),
        }),
      ],
    });

  const modern = validateSessionData(keyless("1.3"));
  assert.ok(
    modern.errors.some((error) => error.includes("manipulation.key")),
    "a manipulation without a key is an error from schema version 1.3 onwards",
  );
  assert.equal(
    modern.warnings.some((warning) => warning.includes("manipulation.key")),
    false,
    "a missing key in 1.3 is an error, not a warning",
  );

  const legacy = validateSessionData(keyless("1.2"));
  assert.deepEqual(
    legacy.errors,
    [],
    "a session written before 1.3 may carry a manipulation without a key",
  );
  assert.ok(
    legacy.warnings.some(
      (warning) =>
        warning.includes("manipulation") && warning.includes("no key"),
    ),
    "the legacy session is reported rather than rejected",
  );
});

test("a manipulation mode must be move or resize, and its delta must be numbers", () => {
  const badMode = validateSessionData(
    session({
      annotations: [
        annotation("A1", { manipulation: manipulation({ mode: "scale" }) }),
      ],
    }),
  );
  assert.ok(
    badMode.errors.some((error) => error.includes("manipulation.mode")),
    "an unknown mode must be rejected",
  );

  const badDelta = validateSessionData(
    session({
      annotations: [
        annotation("A1", {
          manipulation: manipulation({
            delta: { x: 32, y: 0, width: null, height: 0 },
          }),
        }),
      ],
    }),
  );
  assert.ok(
    badDelta.errors.some((error) => error.includes("manipulation.delta.width")),
    "every delta axis must be a finite number",
  );
});

test("an unknown schema version is refused instead of being rewritten", () => {
  assert.throws(
    () => normalizeSession({ schemaVersion: "9.9" }),
    /schemaVersion/,
    "a version that is not ours must not be stamped over and processed",
  );

  const supported = normalizeSession({ schemaVersion: "1.2" });
  assert.equal(supported.normalizedFrom, "1.2");
  assert.equal(supported.schemaVersion, "1.3");

  // A missing version is the historical 1.0 session, and stays accepted.
  const legacy = normalizeSession({ sessionId: "s" });
  assert.equal(legacy.normalizedFrom, "1.0");
  assert.equal(legacy.schemaVersion, "1.3");
});
