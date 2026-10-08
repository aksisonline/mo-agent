# Setup and deployment

[← Overview](../README.md) · [Architecture](architecture.md) · [Setup](setup.md) · [API](api.md) · [Operations](operations.md)

## Requirements

Install Bun. You need your own Cloudflare account with Workers AI and SQLite-backed Durable Objects available, an AI Gateway named `default`, and an Ollama Cloud API key. Models and provider availability may vary; choose models your account can actually use. Remote inference can incur charges, including during local development.

JEV calls use the `default` AI Gateway with caching and gateway log collection disabled. Create that gateway in your account, or update both gateway settings in `src/services/jev.ts` to your gateway ID.

## Configure your agent

1. Edit `src/lib/knowledge.ts`: add your verified base identity/contact facts and the relevant experience, skills, projects, education and recognition sections. Set source and snapshot date if applicable. Leave unknown sections empty. Only add information you have permission to publish.
2. Edit `WEBSITE_CONTEXT` and `AGENT_INTENT` in `wrangler.jsonc` to describe your portfolio and intended scope. Do not put secrets in these fields.
3. Choose a unique Worker `name` and your Ollama reply/memory models in `wrangler.jsonc` and `.dev.vars`.
4. Optionally adjust the tone in `src/services/chat.ts` and fixed boundary replies in `src/lib/scope-replies.ts`.

Knowledge is bundled at deployment time. Mo does not browse or fetch visitor-provided URLs. Project-specific keyword selectors in `additionalKnowledge` can be extended when you add your own projects.

## Local development

```sh
bun install --frozen-lockfile
cp .dev.vars.example .dev.vars
bunx wrangler login
```

Set your `OLLAMA_API_KEY` in `.dev.vars`. Generate a signing secret and paste the output into `VISITOR_COOKIE_SECRET` in that file:

```sh
bun -e 'console.log(crypto.getRandomValues(new Uint8Array(32)).toHex())'
bun run typegen
bun run dev
```

`.dev.vars` is ignored. Never commit real credentials. `ACCESS_LOCAL_DEV=true` permits HTTP cookies only on localhost; production defaults to secure cookies. Workers AI remains remote during development.

In a second terminal, this request verifies chat integration. It stores the visitor cookie in a local file so later requests can use the same identity:

```sh
curl -N -c /tmp/mo-agent-cookie.txt http://localhost:8787/api/chat \
  -H 'Content-Type: application/json' \
  --data '{"turnId":"b05cab4a-0d46-4b32-8423-f8a17db0058e","messages":[{"role":"user","content":"Hello Mo"}],"memories":[]}'
```

Generate a new UUID for each chat turn. Replaying a turn returns a conflict.

## Deploy to your account

```sh
bun run typegen
bun run check
bun run lint
bun run format:check
bun test
bun run build
bunx wrangler secret put OLLAMA_API_KEY
bunx wrangler secret put VISITOR_COOKIE_SECRET
bun run deploy
```

Use a new random signing secret for production. `build` is a dry run; `deploy` publishes the Worker and provisions its quota namespace through the included migration. `workers_dev` is enabled so your deployment has a reachable URL. Add your own custom domain or same-origin proxy when connecting a portfolio frontend. Local secrets are not automatically uploaded. Changing the signing secret invalidates existing visitor cookies.
