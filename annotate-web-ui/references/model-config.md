# Model Configuration

The judgement layer — verdicts and consolidation — can run on either the agent
that opened this skill, or on a model you configure yourself. Evidence
generation never needs a model.

## Modes

### `host-agent` (default)

The skill writes the evidence to `review-input.json` and stops. The agent in the
current session reads it, writes `review-output.json`, and continues. Nothing is
sent anywhere, no credential is required, and the cost is whatever the current
session already costs.

Use this unless you have a reason not to.

### `byok`

`scripts/model-client.mjs` calls a provider directly. Use it when:

- you want a different model than the one driving the session;
- the loop must run unattended, for example in CI;
- you are comparing several models on the same review bundle.

## Configuration

Resolution order, first match wins:

1. `--config /absolute/path/to/config.json`
2. `<repoPath>/.symbui/config.json`
3. `~/.symbui/config.json`
4. built-in defaults

```json
{
  "review": {
    "model": {
      "mode": "host-agent",
      "provider": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4o-mini",
      "apiKeyEnv": "SYMBUI_MODEL_API_KEY",
      "apiKeyFile": "~/.symbui/credentials.json",
      "timeoutMs": 60000,
      "maxOutputTokens": 4096
    },
    "maxRounds": 3,
    "autoConsolidate": true,
    "pixelTolerance": 1
  }
}
```

| Field | Default | Meaning |
|-------|---------|---------|
| `mode` | `host-agent` | `host-agent` or `byok` |
| `provider` | `openai` | `openai`, `anthropic`, or `openai-compatible` |
| `baseUrl` | provider default | Override for self-hosted or gateway endpoints |
| `model` | none | Required in `byok` mode |
| `apiKeyEnv` | `SYMBUI_MODEL_API_KEY` | Environment variable holding the key |
| `apiKeyFile` | `~/.symbui/credentials.json` | Fallback file, `0600` |
| `timeoutMs` | `60000` | Per-request timeout |
| `maxOutputTokens` | `4096` | Response cap |
| `maxRounds` | `3` | Hard stop for the loop |
| `autoConsolidate` | `true` | Write the next request without asking |
| `pixelTolerance` | `1` | CSS-pixel tolerance for `moved` / `resized` |

A project config belongs in `.symbui/config.json`. Add `.symbui/` to
`.gitignore` if the session directory is not already ignored.

## Credentials

The key is read from `apiKeyEnv` first, then from `apiKeyFile`:

```json
{ "SYMBUI_MODEL_API_KEY": "sk-..." }
```

Create it with restrictive permissions:

```bash
mkdir -p ~/.symbui && chmod 700 ~/.symbui
printf '%s\n' '{"SYMBUI_MODEL_API_KEY":"sk-..."}' > ~/.symbui/credentials.json
chmod 600 ~/.symbui/credentials.json
```

Rules, enforced by `validate-session.mjs`:

- a credential is never written into a session artifact;
- a credential is never echoed to stdout, including in errors;
- `apiKeyFile` must live outside `repoPath` — a key inside the repository is a
  leaked key;
- if `byok` is configured but no key resolves, fail before the first request
  with a message naming both sources that were checked.

## Request shape

`model-client.mjs` sends one request per task and expects strict JSON back.

Verdict task — input `review-input.json`:

```json
{
  "task": "verdicts",
  "annotations": [],
  "clusters": [],
  "instructions": "..."
}
```

Output `review-output.json`:

```json
{
  "task": "verdicts",
  "verdicts": [
    {
      "annotationId": "A1",
      "status": "satisfied",
      "confidence": "high",
      "clusters": ["c3"],
      "evidence": ["borderRadius 12px -> 4px"],
      "note": ""
    }
  ]
}
```

Both modes produce the same file. Downstream steps never branch on the mode,
which is what makes the two interchangeable.

## Failure handling

- A malformed response is retried once with the parse error appended.
- A second failure marks the affected verdicts `unverified` with
  `source: "heuristic"` and falls back to the deterministic diff, rather than
  aborting the round.
- A network failure in `byok` mode never blocks the loop: it degrades to
  `host-agent` and says so.
