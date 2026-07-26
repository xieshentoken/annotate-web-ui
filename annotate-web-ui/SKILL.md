---
name: annotate-web-ui
description: Open a local development or pure static web page in an isolated browser, preserve its live interactions, collect DOM-aware visual annotations in a frozen viewport, and generate an evidence-linked UI change specification and implementation prompt. Use when a user wants to point at, box, redact, or describe exact changes on a local web application instead of relying on ambiguous natural-language references.
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
- Stop after generating the change specification unless the user separately
  asks to implement the approved changes.

## Workflow

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
the implementation prompt as a scoped input and verify the changed page at the
captured route and viewport.

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

- Read [references/annotation-schema.md](references/annotation-schema.md) when
  validating or extending the session format.
- Read [references/target-resolution.md](references/target-resolution.md) when
  changing DOM evidence or source matching.
- Read [references/prompt-contract.md](references/prompt-contract.md) when
  changing generated Markdown or handoff behavior.
