# API and frontend integration

[← Overview](../README.md) · [Architecture](architecture.md) · [Setup](setup.md) · [API](api.md) · [Operations](operations.md)

| Endpoint           | Result                                                                  |
| ------------------ | ----------------------------------------------------------------------- |
| `GET /api/health`  | Configured model metadata; does not test live inference                 |
| `POST /api/chat`   | Ollama-compatible NDJSON or a fixed scope reply                         |
| `POST /api/memory` | `{turnId, changed, memories?}`; a changed notebook replaces the old one |

Both POST endpoints accept the same conversation shape:

```json
{
  "turnId": "b05cab4a-0d46-4b32-8423-f8a17db0058e",
  "messages": [{ "role": "user", "content": "What projects has the owner built?" }],
  "memories": [],
  "agentState": { "frustration": 0, "updatedAt": 0 },
  "notebookTtlDays": 30
}
```

`agentState` and `notebookTtlDays` are optional. Requests are bounded to 128,000 bytes, 1–12 messages (at most 8,000 characters each), ending with a user message, and 24 notebook entries (at most 600 characters each). Notebook entries have UUID `id`, `kind` (`preference`, `decision`, `fact`, `open_loop`), `content`, millisecond `updatedAt` and `expiresAt`, and an optional `preferredName`. Expiry defaults to 30 days; requests can choose 1–90 days.

Your frontend must:

1. Keep history, notebook and agent state locally and include unexpired entries in requests. Send the visitor cookie with each request.
2. Consume the chat stream through `done: true` **and clean EOF**. Handle JSON errors separately. Save `X-Agent-State` and inspect `X-Agent-Policy`.
3. When `memoryAllowed` is true, optionally call `/api/memory` once within ten minutes using the same completed `turnId`, cookie and bounded conversation ending in a user message. The schema does not accept a final assistant message. Never retry a consumed memory grant.
4. Replace the notebook only when `changed` is true. Correlate responses by turn, prevent stale responses from overwriting newer notebook data, and coordinate across tabs where needed.
5. Provide a Forget control that clears local conversation state and ignores older in-flight results.

POST requests with a different `Origin` are rejected. Serve the frontend and backend through the same origin or proxy `/api/*` to this Worker. Cross-origin CORS is not included.
