# AI Access API

Express API service for AI chat and transcript summarization across OpenAI, DeepSeek, and Anthropic.

## Features

- Multi-provider chat endpoints.
- Transcript-based summarization and tag generation.
- Firebase Firestore transcript lookup (`transcripts/{videoID}`).
- Production-safe error responses with server-side provider diagnostics.
- Configurable logging via `LOG_LEVEL`.

## Project Structure

- `api/index.js`: App entrypoint, routes, provider calls, and shared middleware/helpers.
- `api/routes.js`: Route registration and route handler implementations.
- `lib/compare.js`: Normalized multi-provider compare request parsing and execution.
- `api/prompts.js`: Centralized prompt templates for transcript summary/tag flows.
- `tests/smoke.test.js`: Smoke tests for health and production error sanitization.
- `.github/workflows/ci.yml`: CI checks for lint and tests.
- `vercel.json`: Vercel function timeout and rewrite configuration.

## Requirements

- Node.js 18+
- npm

## Setup

```bash
npm install
```

Create a local `.env` file with required variables:

```env
# Required for OpenAI routes
OPENAI_API_KEY=...

# Required for DeepSeek routes
DEEPSEEK_API_KEY=...

# Required for Anthropic routes
ANTHROPIC_API_KEY=...

# Required at startup (base64-encoded Firebase service account JSON)
FIREBASE_SERVICE_ACCOUNT_JSON=...

# Optional
OPENAI_MODEL=gpt-4o-mini
OPENAI_REASONING_EFFORT=low
DEEPSEEK_MODEL=deepseek-chat
ANTHROPIC_MODEL=claude-3-5-haiku-latest
PROMPT_VERSION_TRANSCRIPT_SUMMARY=v1
PROMPT_VERSION_TRANSCRIPT_SUMMARY_V2=v1
PROMPT_VERSION_TRANSCRIPT_TAGS=v1
ALLOWED_ORIGINS=http://localhost:3000
PORT=3001
LOG_LEVEL=info
NODE_ENV=development
```

## Run Locally

```bash
npm start
```

Default local URL: `http://localhost:3001`

## Test

```bash
npm test
```

Current smoke coverage:

- `GET /health` success path
- `POST /api/openai-chat` upstream failure returns sanitized `500` details in production mode
- Missing-key middleware branches for OpenAI, DeepSeek, and Anthropic (`500`)
- Transcript route error branches: missing `videoID` (`400`), Firebase unavailable (`503`), missing/empty transcript (`404`)

Local HTTP smoke checks (with app running):

```bash
./scripts/smoke-local.sh
```

Optional flags:

- `BASE_URL=http://localhost:3001 ./scripts/smoke-local.sh`
- `RUN_PROVIDERS=1 ./scripts/smoke-local.sh` (executes real provider-backed calls)

## Lint and Format

```bash
npm run lint
npm run format:check
npm run format
```

- `lint`: JS syntax checks + formatting checks.
- `format:check`: verifies whitespace/newline formatting rules.
- `format`: applies those formatting fixes.

## API Endpoints

Health/debug:

- `GET /health`, `GET /api/health`
- `GET /debug`, `GET /api/debug`

OpenAI:

- `POST /api/openai-chat`
- `POST /api/openai-chat-axios`
- `POST /api/openai-chat-youtube-transcript`
- `POST /api/openai-chat-youtube-transcript-v2`
- `POST /openai-chat-youtube-transcript-v2`

DeepSeek:

- `POST /api/deepseek-chat`
- `POST /api/deepseek-chat-axios`
- `POST /api/deepseek-chat-axios-youtube-transcript`

Anthropic:

- `POST /api/anthropic-chat`
- `POST /api/anthropic-chat-youtube-transcript`

Compare:

- `POST /api/compare`
  - Request:
    - `prompt` (string, required)
    - `imageUrl` (optional string, public image URL for vision-capable providers)
    - `providers` (optional array: `openai`, `deepseek`, `anthropic`; default is all)
    - `providerOptions` (optional object, supports per-provider token overrides and `timeoutMs`)
  - Response:
    - `request` metadata (`prompt`, `providers`, `timeoutMs`, `unsupportedProviders`)
    - `results[]` entries with `provider`, `status` (`success|error`), `latencyMs`, and either `text`/`model` or `error`
  - Behavior:
    - Providers run in parallel.
    - Failures are isolated per provider (partial success supported).
    - `imageUrl` is supported for OpenAI and Anthropic; DeepSeek returns explicit unsupported error for text model.

## Logging and Error Behavior

- `LOG_LEVEL`: `error | warn | info | debug` (default `info`).
- In `NODE_ENV=production`, client `500` responses return generic provider error details.
- Full upstream/provider diagnostic data is logged server-side.
- If Firebase is not configured/healthy, transcript routes return `503` while non-transcript routes stay available.

## Deployment (Vercel)

`vercel.json` rewrites all routes to `api/index.js` and sets max function duration to 60 seconds.

## CI Policy

GitHub Actions workflow at `.github/workflows/ci.yml` runs on pull requests and pushes to `main`:

- `npm ci`
- `npm run lint`
- `npm test`

Optional provider-backed smoke job:

- Runs automatically when `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, and `ANTHROPIC_API_KEY` secrets are configured.
- Can also be triggered manually via `workflow_dispatch` with `run_provider_smoke=true`.
- Uses `./scripts/smoke-local.sh` with `RUN_PROVIDERS=1`.

Public release notes:

- `scripts/generate-public-release-notes.sh` generates `PUBLIC_RELEASE_NOTES.md` for public mirror publishes.
- The mirror workflow writes this file into the public snapshot on each publish.
