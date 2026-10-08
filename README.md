<div align="center">

![Mo Agent](https://img.shields.io/badge/MO_AGENT-18181B?style=for-the-badge&logo=dependabot&logoColor=white)

**A small, cost-conscious agent on Cloudflare, with built-in usage guardrails.**

JEV-guided inference · Bounded usage · Browser-owned memory

[![Bun](https://img.shields.io/badge/Bun-000000?style=flat-square&logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare_Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/)
[![JEV](https://img.shields.io/badge/Decision_engine-JEV-6366F1?style=flat-square)](https://developers.cloudflare.com/ai/models/typesafe/jev/)
[![Ollama](https://img.shields.io/badge/Generation-Ollama-181818?style=flat-square&logo=ollama&logoColor=white)](https://docs.ollama.com/cloud)

[Architecture](docs/architecture.md) · [JEV integration](docs/architecture.md#why-jev) · [Setup](docs/setup.md) · [API](docs/api.md)

</div>

---

Mo is a mini agent designed to keep conversational AI useful within a bounded scope and a controlled usage budget. It runs on Cloudflare Workers, uses JEV to decide what each turn needs, and enforces visitor quotas before inference. The included portfolio assistant is a practical starting point for that design.

The goal is cost-effective operation: skip unnecessary reply generation, send relevant context, keep responses short and compress memory only when it adds value. These controls aim to limit usage; actual cost depends on model selection and traffic, and savings have not been benchmarked.

Cloudflare hosts the agent, JEV decision layer and durable quota store. Ollama currently generates streamed replies and notebook updates. All application-level usage guardrails are included in this deployment.

## How it works

**Validate → reserve quota → evaluate with JEV → select context → stream with Ollama.**

JEV gates reply generation, selects useful notebook context and decides whether a memory update warrants compression. Fixed scope replies handle rejected or uncertain turns. The browser keeps conversation history and memories; a Durable Object tracks operational quotas.

## Get started

```sh
bun install --frozen-lockfile
cp .dev.vars.example .dev.vars
bunx wrangler login
```

Configure your knowledge, scope, provider keys and cookie signing secret, then run `bun run dev`. Follow the [setup guide](docs/setup.md) for the complete configuration and deployment steps.

## Documentation

| Guide                                       | Covers                                                                           |
| ------------------------------------------- | -------------------------------------------------------------------------------- |
| [Architecture](docs/architecture.md)        | Request flow, JEV thresholds, context selection, memory and conversational state |
| [Setup and deployment](docs/setup.md)       | Account requirements, customization, local development and deployment            |
| [API and frontend integration](docs/api.md) | Request schemas, streaming, browser persistence and memory updates               |
| [Operations](docs/operations.md)            | Quotas, access controls, privacy, limitations and source map                     |

## Development checks

```sh
bun run check
bun run lint
bun run format:check
bun test
bun run build
```

`build` performs a deployment dry run. Tests use mocked inference; evaluate your selected models and account integration before launch.
