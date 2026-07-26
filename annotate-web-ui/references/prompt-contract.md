# Prompt Contract

Generate two views over the same structured evidence.

## Human change request

`change-request.md` must contain:

- repository, URL, captured state, and viewport;
- one section per annotation ID;
- target evidence and geometry;
- expected result, scope, responsive range, priority, and invariants;
- ranked source candidates with confidence;
- acceptance criteria and unresolved ambiguity.

## Coding-agent prompt

`implementation-prompt.md` must:

- point to the change request, resolved annotation JSON, and screenshots;
- restrict implementation to numbered changes;
- require preservation of invariants;
- label source locations as candidates unless exact metadata exists;
- require existing checks and visible verification;
- tell the coding agent to stop and report ambiguity instead of guessing.

The generated prompt is not approval to edit. Present the human change request
for review before modifying application code.

