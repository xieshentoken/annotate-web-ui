# Annotate Web UI

A local-only Codex skill for converting visual annotations on a live or pure-static web page into an evidence-linked UI change request and implementation prompt.

## Repository layout

- `annotate-web-ui/` — installable Skill runtime
- `tests/` — deterministic static-server and isolated-Chrome regression tests

## Install locally

Copy the `annotate-web-ui/` directory into your Codex skills directory:

```bash
cp -R annotate-web-ui ~/.codex/skills/annotate-web-ui
```

## Use

Run the Skill against a local development URL, or a pure static directory/HTML document inside the selected repository:

```text
$annotate-web-ui 打开 '/absolute/path/to/project'
```

Pure static projects are served by the built-in loopback-only Node server; no Python server or `file://` access is required.

## Verify

Run the static server tests with Node:

```bash
node --test tests/static-site.test.mjs
```
