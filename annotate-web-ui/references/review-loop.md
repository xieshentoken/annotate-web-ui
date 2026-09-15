# Review Loop

The skill is a convergence loop, not a one-shot handoff. Each pass produces
deterministic evidence, a human judgement, and the smallest next change request.

```text
annotate on rev N
      |
      v
change-request.md  -->  coding agent edits source
      |
      v
dev server reloads  -->  recapture rev N+1 (same states, same viewports)
      |
      v
diff(rev N, rev N+1)  -->  review.html  (before/after preview)
      |
      +--> verdicts per annotation: satisfied / partial / violated / unverified
      |
      +--> new annotations drawn on rev N+1 (box-select, drag, resize)
      |
      v
consolidate  -->  change-request-<round>.md   (delta only)
      |
      v
loop back to "coding agent edits source"
```

Stop when every verdict is `satisfied` and the round produced no review
annotations, or when `review.maxRounds` is reached.

## Why the loop exists

A single pass cannot answer the only question that matters to the user: *did the
page actually change the way I asked?* Without recapture and diff, that answer
comes from the coding agent's own claim. The loop replaces the claim with
evidence.

## Phase 1 — Recapture

Recapture must reproduce the baseline exactly: same state IDs, same routes, same
viewports, same scroll offsets. Otherwise the diff is noise.

The session controller stays alive across rounds. It writes
`<sessionDir>/cdp.json` once it is ready:

```json
{
  "webSocketDebuggerUrl": "ws://127.0.0.1:PORT/devtools/page/ID",
  "targetUrl": "http://localhost:5173/route",
  "states": []
}
```

`scripts/capture-revision.mjs` connects to that endpoint, replays each baseline
state, and writes:

- `revisions/<revisionId>/<stateId>.png` — the screenshot;
- `inventory/<revisionId>.json` — the element inventory.

If a baseline state cannot be reproduced, record it in `missingStates` and keep
going. Never silently substitute a different state.

## Phase 2 — Diff

`scripts/revision-diff.mjs` aligns the two inventories by element `key` and
emits change clusters.

Each cluster carries a `kinds` array, because one element can be both moved and
restyled in the same round. The array is ordered by significance, and the
cluster list is sorted so the most significant changes read first.

| Kind | Meaning |
|------|---------|
| `added` | present in the result, absent in the baseline |
| `removed` | present in the baseline, absent in the result |
| `moved` | same key, `x` or `y` changed by more than the tolerance |
| `resized` | same key, `width` or `height` changed by more than the tolerance |
| `restyled` | same key, at least one tracked style property changed |
| `reordered` | same key, sibling order changed |

Default tolerance is 1 CSS pixel; style comparison is exact string equality on
the tracked subset.

Each cluster records `before`, `after`, `delta`, a `region` (the union of both
rects, for the preview UI to highlight), and `relatedAnnotations` — the
annotations whose geometry intersects the region or whose target identity
matches the cluster key.

### Primary changes versus consequences

A raw element-level diff is unreadable. Change one card's padding and every
element inside it moves; remove one list row and every row after it shifts. A
fixture with six real changes produced thirty-three clusters before this rule
existed, and the six were buried.

So every cluster is either **primary** or **derived**:

- **derived** — displacement that follows from another change already in the
  list, or an added/removed element inside a subtree that was itself added or
  removed. `derivedReason` says which: `ancestor-changed`, `sibling-shift`,
  `subtree-added`, or `subtree-removed`.
- **primary** — everything else, including every restyle, because a style change
  is never a side effect of a container moving.

Two exceptions keep the rule honest:

- a cluster named by an annotation is always primary, even when its container
  also moved — explicit intent outranks inference;
- "named by" means an identity match on test id, selector, or source anchor.
  Geometric overlap alone is not naming. A box drawn around a card is evidence
  about its children, not an instruction to change each of them. Those clusters
  carry the annotation in `relatedAnnotations` but not in `directlyAnnotated`.

The preview shows primary changes by default and folds derived ones behind a
counter, so the reviewer sees the handful of changes that matter and can still
open the rest.

The diff is deterministic and depends on no model. This matters: the evidence a
verdict cites must be reproducible by anyone who re-runs the command.

## Phase 3 — Preview and re-annotate

`assets/review.html` opens the review bundle and shows the baseline and result
side by side. Four comparison modes:

- **side by side** — both panes, synchronised pan and zoom;
- **slider** — a wipe handle reveals one over the other;
- **blink** — toggles between them on a timer;
- **heatmap** — pixel differences painted over the result pane.

Pixel comparison runs in the page on a canvas. No dependency, and no image ever
leaves the machine.

On the result pane the user can:

- **box-select** several elements and annotate them as one batch;
- **drag** an element to move it, recording `delta.x` / `delta.y`;
- **resize** an element from its handles, recording `delta.width` /
  `delta.height`;
- **inspect** an element to see exactly which style properties changed;
- **confirm or reject** each verdict the diff proposed.

Direct manipulation is the point. "Move this 32px right" is unambiguous; "move
this a bit right" is not. Dragging converts a gesture into a number.

Element rects come from the inventory, so a drag is measured against the real
captured geometry, not against the screenshot's pixels.

## Phase 4 — Verdicts

A verdict answers: for this annotation's `expected`, did the result deliver?

The deterministic diff proposes a verdict when it can — a `restyled` cluster on
the same key that changes the property the annotation named is strong evidence.
Anything the diff cannot attribute goes to the judgement layer:

- `host-agent` (default) — the skill writes `review-input.json` and lets the
  coding agent in the current session produce `review-output.json`. No
  credential, no extra cost.
- `byok` — `scripts/model-client.mjs` calls the configured provider directly.
  Use this headless, in CI, or when you want a different model than the one
  driving the session.

See [model-config.md](model-config.md).

## Phase 5 — Consolidate

`scripts/consolidate-review.mjs` produces the next change request. It contains
only the delta:

- annotations whose verdict is not `satisfied` are re-issued, carrying the
  evidence of what was actually observed;
- review annotations drawn on the result revision are added;
- annotations whose verdict is `satisfied` are dropped and listed as closed;
- conflicts between a re-issued annotation and a new one are surfaced, never
  silently resolved.

The consolidated request replaces the previous one. Do not accumulate rounds
into a single growing document: the coding agent should read the smallest
correct instruction set.

## Boundaries

- Recapture never edits the target application.
- The diff never invents a source location; it reports keys and clusters.
- The preview never uploads a screenshot.
- Consolidation never resolves a conflict on the user's behalf.
- The loop stops after `review.maxRounds` even if not converged, and reports
  what remains open.
