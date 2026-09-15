# Target Resolution

Resolve targets using evidence, not visual coordinates alone.

## Evidence order

1. Explicit development-only source file and line metadata.
2. `data-testid`, `data-test`, or another stable application ID.
3. Element ID.
4. ARIA role and accessible name.
5. Bounded visible text, placeholder, or stable link target.
6. A generated CSS path.
7. Viewport geometry as the final fallback.

Evidence 1 is worth creating rather than waiting for. The runtime probe can
recover it from framework internals, but that reports the *component* rather than
the element and disappears whenever a build turns the metadata off. Injecting
`data-ui-source` at compile time makes the strongest evidence in this list
available for every element. See [build-anchors.md](build-anchors.md).

## An anchor is not an identity

Every row of a repeated component reports the same file and line, so an anchor
identifies the component, not the instance. Two consequences:

- a cluster is aligned to a revision by `anchor + testId`, not by anchor alone;
  see the key order in [annotation-schema.md](annotation-schema.md);
- when matching an annotation back to a cluster, an anchor match is only
  accepted if the test ids agree. Without that check, an annotation on one card
  appears to name every card on the page.

An annotation with no test id of its own still matches every instance by anchor,
which is what `scope: repeated` is for. That is the intended reading, not a
false positive.

## DOM capture rules

- Capture only the selected node and a short ancestry chain.
- Remove scripts, styles, event-handler attributes, input values, and password
  content.
- Limit text and HTML excerpts.
- Record source metadata only when already exposed by the local development
  build. When the build-time injectors are installed this is always true; when
  they are not, `anchor` is `null` and that is an honest absence rather than a
  guess.
- Mark canvas, cross-origin iframe, and coordinate-only targets as visual-only.

## Repository matching

Search source-like files while excluding dependencies, generated output, VCS
metadata, coverage, and `.symbui` session artifacts.

Score exact stable IDs above text matches. Return multiple candidates when
scores are close. Do not convert a heuristic match into an asserted source
location.

The mechanism that enforces this is a symbol index rather than a text search:
evidence is matched against *typed sites*, so a `data-testid` attribute and the
same string inside a comment are no longer the same thing. Read
[source-resolution.md](source-resolution.md) before changing how evidence
becomes a `file:line` — it covers the two engines, the site weights, the i18n
reverse lookup, and why a lexically scanned file can never claim high
confidence.

