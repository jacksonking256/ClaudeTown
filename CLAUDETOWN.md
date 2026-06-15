# ClaudeTown

A fork of [a16z-infra/ai-town](https://github.com/a16z-infra/ai-town) that
upgrades agent cognition toward the full Stanford "Generative Agents" (Park et
al., 2023) architecture, with design lessons from DeepMind's Concordia (read as
reference — **not** installed; this stays pure TypeScript / Convex).

Watchable Sims-like 2D town: agents move, talk, remember, score memory
importance, reflect, plan their day, and hold persona over multi-day runs.
Completions on Claude Haiku (via Anthropic's OpenAI-compatible endpoint),
embeddings on local Ollama, cheap-by-default (fully local Ollama for dev).

## Quick start

1. `npm install`
2. Install [Ollama](https://ollama.com), then `ollama pull mxbai-embed-large`
   (embeddings) and, for fully-local mode, `ollama pull llama3` (chat).
3. `npm run dev` (runs Convex backend + Vite frontend). On first run Convex
   prompts you to create/log in to a deployment.
4. Open the printed localhost URL — the PixiJS town renders and agents converse.

## LLM wiring (Phase 1 — done)

The LLM layer (`convex/util/llm.ts`) **decouples chat from embeddings**:

| Concern | Default (free/local) | Quality mode |
|---|---|---|
| Completions | Ollama `llama3` | Claude Haiku `claude-haiku-4-5` |
| Embeddings | Ollama `mxbai-embed-large` (1024-dim) | *(unchanged — still local Ollama)* |

One-line switch on the Convex deployment:

```sh
# Fully local (default)
npx convex env set COMPLETIONS_PROVIDER ollama

# Claude Haiku completions (embeddings stay local)
npx convex env set COMPLETIONS_PROVIDER haiku
npx convex env set ANTHROPIC_API_KEY sk-ant-...
```

Free plumbing test (no network, deterministic canned responses):

```sh
npx convex env set LLM_STUB 1     # or COGNITION_DRY_RUN=1
```

See `.env.local.example` for the full list.

### Caveats (logged, not blocking)

- **Compat layer is test-grade.** Anthropic positions the OpenAI-compatible
  endpoint as a way to test/compare models, not a long-term production path. The
  robust future swap is the native `/v1/messages` API; it's localized behind
  `getChatConfig()` / `chatCompletion()` so the change stays small.
- **`strict` is ignored** by the compat layer, so model JSON isn't
  schema-guaranteed. All model-JSON parsing goes through `extractJSON()`
  (fence-/prose-tolerant, balanced-scan fallback). Covered by `llm.test.ts`.
- **Embeddings need localhost Ollama**, even in Haiku mode. A Convex-cloud
  deploy can't reach your localhost Ollama without a tunnel — you'd switch
  `EMBEDDING_PROVIDER` to a hosted provider and match `EMBEDDING_DIMENSION`.

## Cognition roadmap

- **Phase 0** ✅ Vanilla fork imported as baseline.
- **Phase 1** ✅ LLM wiring (Haiku + local embeddings, dry-run, dimension
  guard, defensive JSON + smoke test).
- **Phase 2** Cognition upgrade — 3-factor retrieval weights, importance cache,
  reflection-tree with salient questions, hierarchical planning + reactive
  replanning (cost-capped), identity anchoring (+ measurable coherence check).
- **Phase 3** Custom personas/map.
- **Phase 4** Pause/resume, speed/run-length, `--dry-run`, end-of-run token + $
  cost summary for Haiku ($1/$5 per 1M in/out tokens).
- **Phase 5** (optional) Game-Master resolver, behind a flag.

## Verification note

The cognition modules are built to be inspectable and unit/dry-run testable
(`npm test`, `tsc`). The live browser/Ollama/Convex loop is verified on your
own machine — the dev container is headless with no GPU/Ollama.
