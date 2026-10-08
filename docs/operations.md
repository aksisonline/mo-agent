# Operations

[← Overview](../README.md) · [Architecture](architecture.md) · [Setup](setup.md) · [API](api.md) · [Operations](operations.md)

## Quotas and abuse controls

The included SQLite Durable Object keeps each signed visitor's quota separate. Defaults are 20 chat loops per calendar week, resetting Monday 00:00 UTC, and five reservation attempts per rolling minute. Edit `src/lib/quota.ts`, the reservation bounds in `src/services/access.ts`, and the quota message in `src/routes/api.ts` together if changing these defaults.

A turn reserves quota before inference. Duplicates and concurrent pending turns are denied. Pre-response provider failures refund quota. Stream errors or cancellation remain charged; a pending lock expires after 150 seconds. Memory grants last ten minutes, are issued only after validated completion, and can be consumed once. Prior-week records are cleaned on new reservations; inactive object rows are cleared by an alarm after two weeks. Cloudflare backups and provider retention are separate.

`X-Mo-Remaining` and `X-Mo-Resets-At` carry quota metadata. Exhaustion returns 429, duplicate/in-flight turns 409, missing memory grants 403, and access failures 503. An additional 30-attempt-per-minute IP limiter is isolate-local and best-effort. Cookies can be cleared to obtain a new visitor identity; these limits are not account authentication. Assess edge abuse controls and provider spending limits before exposing paid inference broadly.

## Privacy and limitations

Chat transcripts and notebooks are not persisted by this backend. The frontend owns them. The quota store persists operational turn/reservation IDs and counters; the signed cookie identifies a browser for 90 days. Clearing conversation history does not clear the quota cookie. Application logs contain event names, not conversation content or provider exception text.

Submitted messages and notebook context still reach Cloudflare and Ollama for inference. Provider privacy, logging, retention and billing policies apply independently. Disclose this to visitors. Name recall, scope decisions, sensitive-data exclusion and style are model-driven and probabilistic; evaluate your real models before launch.

Tests mock inference providers. Passing tests and a dry-run build do not verify account permissions, gateway/model availability or live model behavior.

## Source map

- `src/routes/api.ts`: request validation, cookies, reservations and streaming.
- `src/services/`: scope decisions, chat, memory, Ollama and quota adapter.
- `src/lib/knowledge.ts`: your publishable knowledge and detail selection.
- `src/lib/quota.ts`, `src/quota-worker.ts`: quota ledger and durable storage.
- `src/lib/`: state, cookie signing, IP burst limiting and stream validation.
- `src/schemas/`: bounded conversation and decision schemas.
- `tests/`: HTTP, provider mocks, notebook, state, streaming and quota regressions.

See [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/), [SQLite Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [JEV](https://developers.cloudflare.com/ai/models/typesafe/jev/) and [Ollama Cloud](https://docs.ollama.com/cloud) for provider documentation.
