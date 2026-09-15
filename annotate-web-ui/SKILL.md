---
name: annotate-web-ui
description: Open a local development or pure static web page in an isolated browser, preserve its live interactions, collect DOM-aware visual annotations in a frozen viewport, generate an evidence-linked UI change specification and implementation prompt, then recapture the page after the edit, diff it against the previous revision, and present a before/after review where the user confirms or overrides each verdict and annotates the result directly. Optionally wires development-only build plugins that stamp every element with its own source file and line, which is what makes the diff able to tell a real change apart from a cascade of shifted siblings. Use when a user wants to point at, box, redact, drag, or describe exact changes on a local web application instead of relying on ambiguous natural-language references, or wants to verify that a change actually landed.
---

# Annotate Web UI

Turn visual annotations on a running local web application into a structured,
reviewable change request. Keep capture and specification generation separate
from source-code modification.

## Boundaries

- Accept either a local development URL on `localhost`, `127.0.0.1`, `[::1]`,
  or `*.localhost` over HTTP/HTTPS, or a pure static directory/HTML file inside
  the selected repository.
- Serve pure static targets through the built-in loopback-only Node server.
  Do not open them with `file://` or require a Python HTTP server.
- Launch an isolated Chrome profile. Do not reuse the user's normal browser
  profile, cookies, local storage, or signed-in sessions.
- Do not install dependencies or modify the target application to inject the
  toolbar.
- Write only the annotation session bundle under the selected output root.
- Recapture reads the page; it never edits the target application.
- Serve the review preview on loopback only, and never upload a screenshot.
- Never write a credential into a session artifact. In `byok` mode the key comes
  from the environment or from a `0600` file outside the repository.
- Do not resolve a conflict between two instructions on the same target. Report
  it and let the user decide.
- Stop after generating the change specification unless the user separately
  asks to implement the approved changes.

The build-time anchor injectors under `plugins/` are the one exception to "do not
modify the target application", and only because they are a source change the
user makes deliberately and keeps: a development-only Babel and Vue transform
that adds `data-ui-source` to the markup. Never install them silently. Offer
them, explain that they change the build, and let the user decide.

## Workflow

### 0. Offer source anchors before the first capture

Ask whether the target application can run with the injectors from
[references/build-anchors.md](references/build-anchors.md). Without them the
probe falls back to framework internals, which report the component rather than
the element and can vanish; with them every element carries its own file and
line, and the revision diff can tell a real change apart from a cascade of
shifted siblings.

This is a change to the user's build configuration, so it is a question, not a
default. If they decline, carry on — the session degrades to weaker evidence
rather than failing. Be specific about what is lost: without them no candidate
can reach `exact` confidence, so every change is reported as an unresolved
target the coding agent has to confirm against the file itself. Both the first
change request and each consolidated round report this under
`Build-time anchors`.

### 1. Establish the target

Obtain:

- an absolute repository path;
- either a currently reachable local-development URL or a pure static
  directory/HTML file inside the repository;
- an optional output root.

If a configured development command exists, use it and attach with `--url`.
When the project is pure HTML/CSS/JavaScript and has no server, use `--static`.
Do not install missing packages automatically.

### 2. Start the annotation session

Resolve this skill directory and run:

```bash
node scripts/start-session.mjs \
  --url http://localhost:5173 \
  --repo /absolute/path/to/project
```

For a pure static site, run:

```bash
node scripts/start-session.mjs \
  --static /absolute/path/to/project-or-index.html \
  --repo /absolute/path/to/project
```

`--static` without a value serves the repository root. The static path must stay
inside the repository and a directory must contain `index.html` or `index.htm`.
The random loopback server starts and stops with the annotation controller.
`--keep-browser` is unavailable in static mode because the page server does not
outlive the session.

Use a PTY because the controller stays active while the user annotates. The
default output location is:

```text
<repo>/.symbui/sessions/<session-id>/
```

Pass `--output-root /absolute/path` to override it, or `--chrome /absolute/path`
when Google Chrome is not in a standard location.

Tell the user that the isolated browser is ready. Let the user operate the page
and annotation panel directly. Wait for the controller to print
`SYMBUI_SESSION_DIR=...`.

### 3. Review the generated bundle

The controller validates and compiles the session automatically. Read:

- `change-request.md` for the human-reviewable specification;
- `implementation-prompt.md` for the coding-agent prompt;
- `annotations.resolved.json` for source candidates and confidence;
- screenshots for visual evidence.

If a session was captured but compilation was interrupted, run:

```bash
node scripts/validate-session.mjs /absolute/path/to/session
node scripts/build-change-spec.mjs \
  --session /absolute/path/to/session \
  --repo /absolute/path/to/project
```

### 4. Resolve ambiguity before implementation

Treat `annotations.json` and the screenshots as evidence. Treat source matches as
candidates unless they are backed by explicit development-only source metadata.

Do not invent a component or file. Ask for clarification when:

- an annotation has no expected result;
- a region has no stable DOM target and its intent is unclear;
- multiple source candidates have similar confidence;
- requested behavior conflicts with a protected invariant.

### 5. Hand off only the approved request

Present the change request before editing application code. After approval, use
the implementation prompt as a scoped input.

### 6. Close the loop after the edit

Do not accept the coding agent's word that the change landed. Recapture and
compare:

```bash
node scripts/review-session.mjs --session <session-dir> --serve
```

This captures the result revision, diffs it against the previous one, proposes a
verdict per annotation, and serves the before/after preview on loopback. Tell
the user the preview URL and let them work in it. The step ends when they press
**保存复审结果**, or on `Ctrl-C`.

In the preview the user compares the two revisions (side by side, wipe slider,
blink, or pixel heatmap), then either confirms the proposed verdicts or
overrides them, and annotates the result directly: box-select to batch, drag to
move, resize from the handles. A drag is recorded as an exact `delta` in CSS
pixels, which is far less ambiguous than prose.

Then fold the round into the next request:

```bash
node scripts/consolidate-review.mjs --session <session-dir>
```

The result contains only the delta: annotations that were not satisfied, plus
whatever the reviewer drew on the result. Satisfied ones are listed as closed
and dropped. Repeat from step 5 until every verdict is `satisfied` and the round
produced no new annotations, or until `review.maxRounds` is reached.

Never consolidate a round that still has an unresolved conflict on the same
target. Report it and let the user decide.

## Runtime behavior

The injected toolbar provides:

- live browsing;
- a draggable, viewport-clamped floating panel;
- DOM-aware element picking;
- viewport freezing through a native browser screenshot;
- deletion of a frozen page together with its annotations and captured files;
- box, point, arrow, and redaction annotations;
- structured intent fields;
- multiple captured page states;
- undo, deletion, and local export.

Use the keyboard shortcut `Control/Command + Shift + A` to freeze or return to
the live page without dismissing an open menu or tooltip.

## References

- Read [references/build-anchors.md](references/build-anchors.md) when wiring the
  build-time anchor injectors, when anchors are missing from the inventory, or
  when the user asks why an element has no source location.
- Read [references/review-loop.md](references/review-loop.md) when changing the
  round protocol, the diff rules, or the preview workflow.
- Read [references/model-config.md](references/model-config.md) when changing
  how verdicts are produced, or when the user asks about model configuration.
- Read [references/annotation-schema.md](references/annotation-schema.md) when
  validating or extending the session format.
- Read [references/target-resolution.md](references/target-resolution.md) when
  changing DOM evidence or source matching.
- Read [references/source-resolution.md](references/source-resolution.md) when
  changing how an annotation becomes a `file:line`, when candidates are missing
  or land on the wrong line, when the project is localized and the annotated
  text is not the source text, or when the resolver reports a degraded engine.
- Read [references/prompt-contract.md](references/prompt-contract.md) when
  changing generated Markdown or handoff behavior.
