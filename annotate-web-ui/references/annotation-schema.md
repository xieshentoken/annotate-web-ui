# Annotation Session Schema

Use schema version `1.1`.

Readers must also accept legacy `1.0` sessions. A legacy single
`intent.operation` value normalizes to a one-item `intent.operations` array.

## Session

```json
{
  "schemaVersion": "1.1",
  "sessionId": "20260725-120000-ab12cd",
  "createdAt": "ISO-8601 timestamp",
  "completedAt": "ISO-8601 timestamp",
  "repoPath": "/absolute/project/path",
  "targetUrl": "http://localhost:5173/route",
  "states": [],
  "annotations": []
}
```

## Captured state

Each state records:

- `id`, `title`, `description`, `url`, and `capturedAt`;
- viewport `width`, `height`, and `deviceScaleFactor`;
- scroll `x` and `y`;
- relative `beforeImage` and `annotatedImage` paths.

One session may contain multiple states. A new freeze after returning to the live
page creates a new state.

## Annotation

Required fields:

- `id`: stable display ID such as `A1`;
- `stateId`: captured-state reference;
- `kind`: `element`, `box`, `point`, `arrow`, or `redact`;
- `geometry`: viewport CSS-pixel coordinates;
- `target`: sanitized DOM evidence or `null`;
- `intent`: structured intent for every non-redaction annotation.

Intent fields:

- `operations`: non-empty ordered array of `layout`, `style`, `content`,
  `interaction`, `add`, `remove`, or `fix`; values must be unique;
- `expected`: required result;
- `scope`: `element`, `repeated`, or `page`;
- `breakpoint`: `all`, `current`, `desktop`, `tablet`, or `mobile`;
- `priority`: `must` or `should`;
- `invariants`: behavior that must remain unchanged.

The UI presents these values as a visible multi-select checklist. Its labels may
be localized, but JSON values remain the stable identifiers above. Schema
`1.0` stored exactly one legacy `operation` string and must remain readable;
new sessions write only `operations`.

Never place screenshot data URLs, form values, cookies, storage, or credentials
inside JSON artifacts.
