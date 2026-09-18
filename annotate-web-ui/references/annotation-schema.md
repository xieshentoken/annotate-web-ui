# Annotation Session Schema

Use schema version `1.3`.

Readers must accept legacy `1.0`, `1.1`, and `1.2` sessions:

- `1.1` introduced `intent.operations` (an ordered array). A `1.0` single
  `intent.operation` string normalizes to a one-item `operations` array.
- `1.2` introduced `revisions`, `rounds`, `inventory`, and `verdicts`. A legacy
  session with top-level `states` and `annotations` normalizes to one baseline
  revision and one round with `index: 0`.
- `1.3` introduced `annotation.alias`, session `groups`, and `reference`. All
  three are optional, so a `1.2` session reads unchanged with no names and no
  groups. Readers must accept `1.0` through `1.3`, and `1.3` is what a writer
  stamps.

## Session

```json
{
  "schemaVersion": "1.3",
  "sessionId": "20260914-155200-ab12cd",
  "createdAt": "ISO-8601 timestamp",
  "completedAt": "ISO-8601 timestamp",
  "repoPath": "/absolute/project/path",
  "targetUrl": "http://localhost:5173/route",
  "revisions": [],
  "rounds": [],
  "groups": [],
  "reference": null,
  "config": {}
}
```

`config` mirrors the resolved review configuration for auditability. It must
never contain a credential.

## Revision

A revision is one immutable capture of the application at one point in time.
Every round compares exactly two revisions.

```json
{
  "id": "rev-001",
  "roundIndex": 0,
  "role": "baseline",
  "createdAt": "ISO-8601 timestamp",
  "git": { "head": "a24f480", "dirty": true },
  "states": [],
  "inventory": "inventory/rev-001.json"
}
```

`role` is `baseline` or `result`. `git.head` may be `null` outside a repository.

## Captured state

Each state records:

- `id`, `title`, `description`, `url`, and `capturedAt`;
- viewport `width`, `height`, and `deviceScaleFactor`;
- scroll `x` and `y`;
- relative `beforeImage` and `annotatedImage` paths.

One revision may contain multiple states. A new freeze after returning to the
live page creates a new state. State IDs must be stable across revisions so a
round can diff like-for-like; a revision that cannot reproduce a baseline state
records it under `missingStates`.

## Inventory

`inventory/<revisionId>.json` is the alignment substrate for diffing and for
direct-manipulation editing.

```json
{
  "revisionId": "rev-001",
  "states": [
    {
      "stateId": "s1",
      "viewport": { "width": 1280, "height": 800, "deviceScaleFactor": 1 },
      "elements": []
    }
  ]
}
```

Each element records:

- `key`: the stable alignment identity (see below);
- `anchor`: `{ file, line, column, component }` or `null`;
- `selector`, `testId`, `id`, `role`, `name`, `tag`;
- `rect`: viewport CSS-pixel `x`, `y`, `width`, `height`;
- `style`: the computed-style subset (`borderRadius`, `backgroundColor`,
  `color`, `fontSize`, `fontWeight`, `lineHeight`, `letterSpacing`, `padding`,
  `margin`, `gap`, `border`, `boxShadow`, `opacity`, `display`, `flexDirection`,
  `justifyContent`, `alignItems`). Size is deliberately excluded: `rect`
  already carries it, and duplicating it would make every element inside a
  resized container look restyled too;
- `tokens`: reverse-mapped design tokens per style key when the page exposes
  CSS custom properties or utility-class hints;
- `reuseCount`: how many live elements share this element's `key`;
- `visible`: whether the element has a non-empty box.

`key` is resolved in this order, first match wins:

1. `anchor.file + ":" + anchor.line + "#" + component + "[" + testId + "]"`
   when the element has both a source anchor and its own test id;
2. `anchor.file + ":" + anchor.line + "#" + component + "@" + occurrence`;
3. `testId`;
4. `id`;
5. `role + "|" + name`;
6. `selector`;
7. a geometry hash (last resort, marked `unstable: true`).

Rule 1 matters more than it looks. A list renders one anchor many times, so an
anchor alone cannot tell two rows apart. Ordering by occurrence means inserting
or removing a row shifts every later row and the diff reports a cascade of
spurious changes. When the item carries its own test id, that id is the stable
half of the key and the cascade disappears.

Anchors come from development-only source metadata. Prefer them: they survive
refactors, reordering, and copy changes that break every other key.

## Annotation

Required fields:

- `id`: stable display ID such as `A1`;
- `alias`: an optional human-typed identifier for the element, unique within the
  session. It is a display and prompt affordance, never an identity: `id` and
  `target` still decide which element is meant. Unlike a group `name`, an alias
  is written into prompts next to the annotation, so a short ASCII identifier
  (`^[A-Za-z][A-Za-z0-9_-]{0,63}$`) is recommended. A name outside that pattern
  is kept and warned about, never rewritten or dropped;
- `revisionId`: the revision the annotation was drawn on;
- `stateId`: captured-state reference;
- `kind`: `element`, `box`, `point`, `arrow`, or `redact`;
- `geometry`: viewport CSS-pixel coordinates;
- `target`: sanitized DOM evidence or `null`;
- `intent`: structured intent for every non-redaction annotation;
- `manipulation`: present only on an annotation that came from a drag or a
  resize, in either the first pass or the review pass.

Intent fields:

- `operations`: non-empty ordered array of `layout`, `style`, `content`,
  `interaction`, `add`, `remove`, or `fix`; values must be unique;
- `expected`: required result;
- `scope`: `element`, `repeated`, or `page`;
- `breakpoint`: `all`, `current`, `desktop`, `tablet`, or `mobile`;
- `priority`: `must` or `should`;
- `invariants`: behavior that must remain unchanged.

The UI presents these values as a visible multi-select checklist. Its labels may
be localized, but JSON values remain the stable identifiers above.

### Direct-manipulation intent

Dragging or resizing an element produces this, whether it was done in the first
annotation pass or in the review UI:

```json
{
  "kind": "element",
  "manipulation": {
    "mode": "move",
    "key": "src/components/Card.tsx:42#Card",
    "before": { "x": 100, "y": 200, "width": 120, "height": 40 },
    "after": { "x": 132, "y": 200, "width": 120, "height": 40 },
    "delta": { "x": 32, "y": 0, "width": 0, "height": 0 }
  }
}
```

`mode` is `move` or `resize`. `delta` is always expressed in CSS pixels in the
captured viewport's coordinate space. When `intent.scope` is `repeated`, the
manipulation applies to every element sharing the target's `key`.

Three rules keep a gesture from becoming an unusable instruction:

1. `intent.expected` is **required** on a manipulating annotation. A raw delta
   is a measurement, not an instruction: the source of truth for a `gap`, an
   `order`, or a `flex-basis` is not a pixel offset, and a coding agent given
   only `delta.x: 32` will write a brittle absolute value. A manipulating
   annotation without `expected` must not be exported.
2. `key` is required, and it is the manipulation's identity. It must be the key
   the inventory assigns to **that element** — never one inherited from an
   ancestor that happened to be captured instead. An ancestor's key silently
   attributes the gesture to its container, and the next capture then measures
   the wrong box. If the element cannot be given its own inventory key, the
   manipulation must not be recorded at all. `before` is the real captured
   geometry — never screenshot pixels — so the delta can be re-measured and
   reproduced. Sessions written before `1.3` may carry a manipulation without
   `key`; readers accept those and report them rather than rejecting them.
3. A manipulation records an **expected** state, never an observed one. The
   element in the DOM has not moved; the target layout exists only in this
   annotation. Recapture and diff must treat the delta as an instruction to
   satisfy, never as a change that already happened.

## Round

A round links the annotations that drove one change to the revision that
resulted from it, and records whether each annotation was satisfied.

```json
{
  "id": "R1",
  "index": 1,
  "fromRevision": "rev-001",
  "toRevision": "rev-002",
  "closedAt": "ISO-8601 timestamp",
  "annotations": [],
  "diff": { "path": "diff/R1.json", "summary": {} },
  "verdicts": [],
  "reviewAnnotations": [],
  "consolidatedRequest": "change-request-R2.md"
}
```

### Verdict

One verdict per input annotation.

```json
{
  "annotationId": "A1",
  "status": "satisfied",
  "confidence": "high",
  "clusters": ["c3"],
  "evidence": ["borderRadius 12px -> 4px on src/components/Card.tsx:42"],
  "note": "Applied to all 12 instances.",
  "source": "host-agent"
}
```

`status` is `satisfied`, `partial`, `violated`, or `unverified`. `confidence` is
`high`, `medium`, or `low`. `source` is `host-agent`, `byok`, or `heuristic`
when the deterministic diff alone produced the verdict. A verdict must cite at
least one cluster or explicitly state why no cluster could be attributed.

## Group

A group is a user-defined set of annotations that should be changed together.

```json
{
  "id": "G1",
  "name": "Hero 区",
  "annotationIds": ["A1", "A2"],
  "containerKey": "src/Hero.tsx:12#Hero",
  "container": { "anchor": { "file": "src/Hero.tsx", "line": 12, "component": "Hero" } },
  "cohesion": "container"
}
```

`cohesion` answers "do these members actually live together", computed when the
group is created:

- `container` — every member shares one captured ancestor, recorded in
  `containerKey` and `container`. A change request may name that container and
  ask for one adjustment applied inside it;
- `component` — no shared ancestor, but every member resolves to the same
  `anchor.component`, or failing that the same `anchor.file`. The request names
  the component, not a container;
- `mixed` — neither holds. The request must list the members individually and
  must not let a coding agent invent a container for them.

Membership is by annotation `id`. `name` is required but need not be unique;
`id` is the identity. A group naming an annotation that does not exist is a
validation error, not a group with fewer members.

## Reference

Optional, and present only when the user brought in a design reference.

```json
{
  "styleTarget": "reference/style-target.json",
  "sources": [{ "url": "https://example.com", "capturedAt": "ISO-8601 timestamp" }]
}
```

The reference states design intent in tokens. It is not a record of this
application's DOM, it must never be merged into `annotations`, and a generated
prompt must present it in its own section: an agent that cannot tell "what this
page does today" from "what the user wants instead" will implement the wrong
one. A conflict between a reference token and an element annotation is reported,
never resolved silently.

## Never store

Never place screenshot data URLs, form values, cookies, storage, credentials, or
API keys inside JSON artifacts. Credentials are read from the environment or
from a `0600` credential file outside the repository.
