# Prompt Contract

Generate two views over the same structured evidence.

## Human change request

`change-request.md` must contain:

- repository, URL, captured state, and viewport;
- a `## Resolver` section stating which engine resolved the anchors, how many
  files parsed, and whether locale files were indexed — a resolver that
  degrades silently is worse than one that fails, so the reader must be able to
  tell a precise answer from a recovered one;
- one section per annotation ID. When the annotation carries an `alias`, that
  name is printed on a `- Name:` line beside the ID and the source anchor — a
  name never replaces either of them, because the ID still keys the section and
  the anchor still says where the change goes;
- target evidence and geometry;
- expected result, scope, responsive range, priority, and invariants;
- ranked source candidates with confidence, `resolver`, the enclosing element
  and component, and the i18n key when the match came through one;
- a `## Groups` section whenever the session has groups: one subsection per
  group giving its name, its member IDs (each with its alias when it has one),
  and its `cohesion`. The wording must follow that value, because it is what
  says how far the agent may generalize — `container` names the shared
  container anchor recorded in `containerKey`/`container` and may ask for one
  adjustment applied inside it; `component` names the component the members
  resolve to and may ask for one adjustment to that component instead of a
  container; `mixed` lists every member individually and must forbid the coding
  agent to invent a container for them;
- for an annotation that came from a drag or a resize, `manipulation` is
  presented as two blocks, never one: the geometry truth (`mode`, the element's
  own inventory `key`, `before`, `after`, and the `delta` in CSS pixels) and a
  semantic hint. The `key` is the manipulation's identity, so the captured key
  itself is printed — never omitted, and never a container's key standing in for
  a child's. The hint must say that a delta is a measurement rather than CSS —
  the source mechanism it stands for is a `gap`, an `order`, a `flex-basis`, or
  a breakpoint-scoped rule — and it must carry the annotation's
  `intent.breakpoint` explicitly, because a delta measured at one viewport says
  nothing about the others;
- acceptance criteria and unresolved ambiguity. An annotation whose best
  candidate is not `high` or `exact` is listed as unresolved: the agent has to
  confirm the element before editing it.
- an annotation that carries a `manipulation` without an `intent.expected` is
  listed under unresolved items as a blocking problem, and must not be
  exported: without a stated expected result the gesture is a measurement, not
  an instruction, and there is nothing for the agent to implement. This gate
  holds on every path that writes either view, a consolidated round included —
  a bare delta must not reach a coding agent by the round-trip route either.

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
- carry `alias` beside `id` and the source anchor on every change it lists, and
  never instead of them: the ID names the change, the anchor locates it, and
  the alias is only how the human asked for it;
- include the `## Groups` section with the `cohesion`-specific wording above, so
  the agent can tell which groups may be satisfied by one container-level or
  component-level adjustment and which have to be changed member by member;
- present every `manipulation` as geometry truth plus a semantic hint, including
  the element's own inventory `key`, name the required `breakpoint`, and say
  plainly that the delta is not a CSS value;
- leave out any annotation whose `manipulation` has no `intent.expected`, and
  name it as blocked instead: it must not be implemented, only reported back.

The generated prompt is not approval to edit. Present the human change request
for review before modifying application code.

