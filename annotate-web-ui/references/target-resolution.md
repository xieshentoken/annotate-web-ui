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

## DOM capture rules

- Capture only the selected node and a short ancestry chain.
- Remove scripts, styles, event-handler attributes, input values, and password
  content.
- Limit text and HTML excerpts.
- Record source metadata only when already exposed by the local development
  build.
- Mark canvas, cross-origin iframe, and coordinate-only targets as visual-only.

## Repository matching

Search source-like files while excluding dependencies, generated output, VCS
metadata, coverage, and `.symbui` session artifacts.

Score exact stable IDs above text matches. Return multiple candidates when
scores are close. Do not convert a heuristic match into an asserted source
location.

