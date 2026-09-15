# Prompt Contract

Generate two views over the same structured evidence.

## Human change request

`change-request.md` must contain:

- repository, URL, captured state, and viewport;
- a `## Resolver` section stating which engine resolved the anchors, how many
  files parsed, and whether locale files were indexed — a resolver that
  degrades silently is worse than one that fails, so the reader must be able to
  tell a precise answer from a recovered one;
- one section per annotation ID;
- target evidence and geometry;
- expected result, scope, responsive range, priority, and invariants;
- ranked source candidates with confidence, `resolver`, the enclosing element
  and component, and the i18n key when the match came through one;
- acceptance criteria and unresolved ambiguity. An annotation whose best
  candidate is not `high` or `exact` is listed as unresolved: the agent has to
  confirm the element before editing it.

## Coding-agent prompt

`implementation-prompt.md` must:

- point to the change request, resolved annotation JSON, and screenshots;
- state the source resolution engine, so the agent knows how much to trust the
  line numbers it is given;
- restrict implementation to numbered changes;
- require preservation of invariants;
- label source locations as candidates unless exact metadata exists, and tell
  the agent to open the file when confidence is not `high` or `exact`;
- name the enclosing element and component per change, and say that the element
  wins over the line number when they disagree;
- require existing checks and visible verification;
- tell the coding agent to stop and report ambiguity instead of guessing.

The generated prompt is not approval to edit. Present the human change request
for review before modifying application code.

