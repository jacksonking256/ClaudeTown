// That's right! No imports and no dependencies 🤯
//
// ClaudeTown wiring notes
// -----------------------
// AI Town shipped a SINGLE provider used for both chat completions and
// embeddings. ClaudeTown decouples them, because:
//   * Completions can run on Claude Haiku via Anthropic's OpenAI-compatible
//     endpoint (https://api.anthropic.com/v1/), which slots into this
//     OpenAI-style layer with only a base-URL + key change.
//   * Anthropic does NOT serve an embeddings endpoint, so embeddings always
//     come from a separate provider (local Ollama by default, free).
//
// Caveats worth knowing (logged, not blocking):
//   * The OpenAI-compatibility layer is positioned by Anthropic as a way to
//     TEST/compare models, not a long-term production path. The "robust"
//     version would call the native /v1/messages API instead. We keep the LLM
//     layer behind getChatConfig()/chatCompletion() so that swap stays local.
//   * The compat layer IGNORES the `strict` flag for tool/function calling, so
//     JSON output is NOT guaranteed to follow a schema. Anywhere we parse model
//     JSON we must parse defensively — see extractJSON() below.
//   * Embeddings stay on localhost Ollama even in Haiku mode, so the town
//     always needs Ollama reachable. A Convex-cloud deploy would need a hosted
//     embedding provider (set EMBEDDING_PROVIDER) + matching EMBEDDING_DIMENSION.

const OPENAI_EMBEDDING_DIMENSION = 1536;
const TOGETHER_EMBEDDING_DIMENSION = 768;
const OLLAMA_EMBEDDING_DIMENSION = 1024; // mxbai-embed-large

// The vector index in convex/agent/schema.ts is built with this dimension, so
// it must match the embedding model's output. Changing it requires a schema
// redeploy.
export const EMBEDDING_DIMENSION: number = OLLAMA_EMBEDDING_DIMENSION;

export type ChatProvider = 'anthropic' | 'openai' | 'together' | 'ollama' | 'custom';
export type EmbeddingProvider = 'ollama' | 'openai' | 'together' | 'custom';

export interface ChatConfig {
  provider: ChatProvider;
  url: string; // No trailing slash; '/v1/chat/completions' is appended.
  chatModel: string;
  stopWords: string[];
  apiKey: string | undefined;
  // Dry-run / stub mode: no network calls, canned deterministic responses.
  // Lets us exercise the full plumbing for free (Phase 4 --dry-run lever).
  stub: boolean;
}

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  url: string;
  embeddingModel: string;
  apiKey: string | undefined;
  dimension: number;
  stub: boolean;
}

function isStub(): boolean {
  const v = (process.env.LLM_STUB ?? process.env.COGNITION_DRY_RUN ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

// ---------------------------------------------------------------------------
// Chat (completions) config
// ---------------------------------------------------------------------------

function anthropicChatConfig(stub: boolean): ChatConfig {
  return {
    provider: 'anthropic',
    // Anthropic OpenAI-compatible endpoint. chatCompletion() appends
    // '/v1/chat/completions' -> https://api.anthropic.com/v1/chat/completions
    url: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
    chatModel: process.env.ANTHROPIC_CHAT_MODEL ?? 'claude-haiku-4-5',
    stopWords: [],
    apiKey: process.env.ANTHROPIC_API_KEY,
    stub,
  };
}

function ollamaChatConfig(stub: boolean): ChatConfig {
  return {
    provider: 'ollama',
    url: process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434',
    chatModel: process.env.OLLAMA_MODEL ?? 'llama3',
    stopWords: ['<|eot_id|>'],
    apiKey: undefined,
    stub,
  };
}

function openaiChatConfig(stub: boolean): ChatConfig {
  return {
    provider: 'openai',
    url: 'https://api.openai.com',
    chatModel: process.env.OPENAI_CHAT_MODEL ?? 'gpt-4o-mini',
    stopWords: [],
    apiKey: process.env.OPENAI_API_KEY,
    stub,
  };
}

function togetherChatConfig(stub: boolean): ChatConfig {
  return {
    provider: 'together',
    url: 'https://api.together.xyz',
    chatModel: process.env.TOGETHER_CHAT_MODEL ?? 'meta-llama/Llama-3-8b-chat-hf',
    stopWords: ['<|eot_id|>'],
    apiKey: process.env.TOGETHER_API_KEY,
    stub,
  };
}

function customChatConfig(stub: boolean): ChatConfig {
  const url = process.env.LLM_API_URL;
  const chatModel = process.env.LLM_MODEL;
  if (!url) throw new Error('LLM_API_URL is required for COMPLETIONS_PROVIDER=custom');
  if (!chatModel) throw new Error('LLM_MODEL is required for COMPLETIONS_PROVIDER=custom');
  return {
    provider: 'custom',
    url,
    chatModel,
    stopWords: [],
    apiKey: process.env.LLM_API_KEY,
    stub,
  };
}

// One-line switch between fully-local (Ollama) and Haiku completions.
// COMPLETIONS_PROVIDER = haiku | ollama | openai | together | custom.
// When unset, fall back to AI Town's legacy auto-detect, then Ollama.
export function getChatConfig(): ChatConfig {
  const stub = isStub();
  const provider = (process.env.COMPLETIONS_PROVIDER || '').toLowerCase();
  switch (provider) {
    case 'haiku':
    case 'anthropic':
      return anthropicChatConfig(stub);
    case 'ollama':
      return ollamaChatConfig(stub);
    case 'openai':
      return openaiChatConfig(stub);
    case 'together':
      return togetherChatConfig(stub);
    case 'custom':
      return customChatConfig(stub);
    case '':
      break;
    default:
      throw new Error(
        `Unknown COMPLETIONS_PROVIDER='${provider}'. Use haiku|ollama|openai|together|custom.`,
      );
  }
  // Legacy auto-detect (kept for back-compat with upstream AI Town env setups).
  if (process.env.ANTHROPIC_API_KEY) return anthropicChatConfig(stub);
  if (process.env.OPENAI_API_KEY) return openaiChatConfig(stub);
  if (process.env.TOGETHER_API_KEY) return togetherChatConfig(stub);
  if (process.env.LLM_API_URL) return customChatConfig(stub);
  return ollamaChatConfig(stub);
}

// ---------------------------------------------------------------------------
// Embedding config (independent of chat provider; defaults to local Ollama)
// ---------------------------------------------------------------------------

export function getEmbeddingConfig(): EmbeddingConfig {
  const stub = isStub();
  const provider = (process.env.EMBEDDING_PROVIDER || 'ollama').toLowerCase();
  let cfg: EmbeddingConfig;
  switch (provider) {
    case 'openai':
      cfg = {
        provider: 'openai',
        url: 'https://api.openai.com',
        embeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
        apiKey: process.env.OPENAI_API_KEY,
        dimension: OPENAI_EMBEDDING_DIMENSION,
        stub,
      };
      break;
    case 'together':
      cfg = {
        provider: 'together',
        url: 'https://api.together.xyz',
        embeddingModel:
          process.env.TOGETHER_EMBEDDING_MODEL ?? 'togethercomputer/m2-bert-80M-8k-retrieval',
        apiKey: process.env.TOGETHER_API_KEY,
        dimension: TOGETHER_EMBEDDING_DIMENSION,
        stub,
      };
      break;
    case 'custom':
      cfg = {
        provider: 'custom',
        url: process.env.LLM_EMBEDDING_API_URL ?? process.env.LLM_API_URL ?? '',
        embeddingModel: process.env.LLM_EMBEDDING_MODEL ?? '',
        apiKey: process.env.LLM_EMBEDDING_API_KEY ?? process.env.LLM_API_KEY,
        dimension: EMBEDDING_DIMENSION,
        stub,
      };
      if (!cfg.url)
        throw new Error('LLM_EMBEDDING_API_URL (or LLM_API_URL) required for EMBEDDING_PROVIDER=custom');
      if (!cfg.embeddingModel)
        throw new Error('LLM_EMBEDDING_MODEL required for EMBEDDING_PROVIDER=custom');
      break;
    case 'ollama':
    default:
      cfg = {
        provider: 'ollama',
        url: process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434',
        embeddingModel: process.env.OLLAMA_EMBEDDING_MODEL ?? 'mxbai-embed-large',
        apiKey: undefined,
        dimension: OLLAMA_EMBEDDING_DIMENSION,
        stub,
      };
      break;
  }
  if (cfg.dimension !== EMBEDDING_DIMENSION) {
    throw new Error(
      `Embedding dimension mismatch: EMBEDDING_PROVIDER='${provider}' outputs ${cfg.dimension} ` +
        `but EMBEDDING_DIMENSION=${EMBEDDING_DIMENSION}. Set EMBEDDING_DIMENSION to ${cfg.dimension} ` +
        `in convex/util/llm.ts (env override) and redeploy the schema, or pick a matching model.`,
    );
  }
  return cfg;
}

// Called from init.ts to fail fast on a misconfigured environment.
export function detectMismatchedLLMProvider() {
  const chat = getChatConfig();
  if (!chat.stub && !chat.apiKey) {
    if (chat.provider === 'anthropic') {
      throw new Error(
        "COMPLETIONS_PROVIDER=haiku needs an API key. Run: npx convex env set ANTHROPIC_API_KEY 'your-key'",
      );
    }
    if (chat.provider === 'openai') {
      throw new Error("Missing OPENAI_API_KEY. Run: npx convex env set OPENAI_API_KEY 'your-key'");
    }
    if (chat.provider === 'together') {
      throw new Error(
        "Missing TOGETHER_API_KEY. Run: npx convex env set TOGETHER_API_KEY 'your-key'",
      );
    }
  }
  // Throws on a dimension mismatch (the classic AI Town footgun).
  getEmbeddingConfig();
}

const AuthHeaders = (apiKey: string | undefined): Record<string, string> =>
  apiKey ? { Authorization: 'Bearer ' + apiKey } : {};

// ---------------------------------------------------------------------------
// Usage accounting (for the Phase 4 cost summary). Captured per chat call.
// ---------------------------------------------------------------------------
export interface LLMUsage {
  provider: ChatProvider;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// Overload for non-streaming
export async function chatCompletion(
  body: Omit<CreateChatCompletionRequest, 'model'> & {
    model?: CreateChatCompletionRequest['model'];
  } & {
    stream?: false | null | undefined;
  },
): Promise<{ content: string; retries: number; ms: number; usage: LLMUsage | undefined }>;
// Overload for streaming
export async function chatCompletion(
  body: Omit<CreateChatCompletionRequest, 'model'> & {
    model?: CreateChatCompletionRequest['model'];
  } & {
    stream?: true;
  },
): Promise<{ content: ChatCompletionContent; retries: number; ms: number; usage: LLMUsage | undefined }>;
export async function chatCompletion(
  body: Omit<CreateChatCompletionRequest, 'model'> & {
    model?: CreateChatCompletionRequest['model'];
  },
) {
  const config = getChatConfig();
  body.model = body.model ?? config.chatModel;
  const stopWords = body.stop ? (typeof body.stop === 'string' ? [body.stop] : body.stop) : [];
  if (config.stopWords) stopWords.push(...config.stopWords);

  // Dry-run: return a canned response without touching the network.
  if (config.stub) {
    const content = stubChatCompletion(body);
    if (body.stream) {
      return {
        content: ChatCompletionContent.fromString(content, stopWords),
        retries: 0,
        ms: 0,
        usage: undefined,
      };
    }
    return { content, retries: 0, ms: 0, usage: undefined };
  }

  let usage: LLMUsage | undefined;
  const {
    result: content,
    retries,
    ms,
  } = await retryWithBackoff(async () => {
    const result = await fetch(config.url + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...AuthHeaders(config.apiKey),
      },

      body: JSON.stringify(body),
    });
    if (!result.ok) {
      const error = await result.text();
      console.error({ error });
      if (result.status === 404 && config.provider === 'ollama') {
        await tryPullOllama(body.model!, error);
      }
      throw {
        retry: result.status === 429 || result.status >= 500,
        error: new Error(`Chat completion failed with code ${result.status}: ${error}`),
      };
    }
    if (body.stream) {
      return new ChatCompletionContent(result.body!, stopWords);
    } else {
      const text = await result.text();
      let json: CreateChatCompletionResponse;
      try {
        json = JSON.parse(text) as CreateChatCompletionResponse;
      } catch (e) {
        throw new Error(
          `Chat completion response invalid JSON (status ${result.status}): ${
            e instanceof Error ? e.message : String(e)
          }\nresponse body:\n${text}`,
        );
      }
      const content = json.choices[0].message?.content;
      if (content === undefined) {
        throw new Error('Unexpected result from OpenAI: ' + JSON.stringify(json));
      }
      if (json.usage) {
        usage = {
          provider: config.provider,
          model: json.model ?? body.model!,
          prompt_tokens: json.usage.prompt_tokens ?? 0,
          completion_tokens: json.usage.completion_tokens ?? 0,
          total_tokens:
            json.usage.total_tokens ??
            (json.usage.prompt_tokens ?? 0) + (json.usage.completion_tokens ?? 0),
        };
      }
      return content;
    }
  });

  return {
    content,
    retries,
    ms,
    usage,
  };
}

// Deterministic canned completion for dry-run plumbing tests. Returns valid
// JSON for prompts that look like they expect it (reflections, importance).
function stubChatCompletion(body: { messages: LLMMessage[] }): string {
  const text = body.messages
    .map((m) => m.content ?? '')
    .join('\n')
    .toLowerCase();
  if (text.includes('scale of 0 to 9') || text.includes('poignancy')) {
    return '5';
  }
  if (text.includes('json') && text.includes('insight')) {
    return '[{"insight":"(stub) I value my routines and the people around me.","statementIds":[0]}]';
  }
  return '(stub completion)';
}

export async function tryPullOllama(model: string, error: string) {
  if (error.includes('try pulling')) {
    console.error('Embedding model not found, pulling from Ollama');
    const pullResp = await fetch(getEmbeddingConfig().url + '/api/pull', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: model }),
    });
    console.log('Pull response', await pullResp.text());
    throw { retry: true, error: `Dynamically pulled model. Original error: ${error}` };
  }
}

export async function fetchEmbeddingBatch(texts: string[]) {
  const config = getEmbeddingConfig();
  if (config.stub) {
    return {
      ollama: true as const,
      embeddings: texts.map((t) => stubEmbedding(t, config.dimension)),
    };
  }
  if (config.provider === 'ollama') {
    return {
      ollama: true as const,
      embeddings: await Promise.all(
        texts.map(async (t) => (await ollamaFetchEmbedding(t)).embedding),
      ),
    };
  }
  const {
    result: json,
    retries,
    ms,
  } = await retryWithBackoff(async () => {
    const result = await fetch(config.url + '/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...AuthHeaders(config.apiKey),
      },

      body: JSON.stringify({
        model: config.embeddingModel,
        input: texts.map((text) => text.replace(/\n/g, ' ')),
      }),
    });
    const text = await result.text();
    if (!result.ok) {
      throw {
        retry: result.status === 429 || result.status >= 500,
        error: new Error(`Embedding failed with code ${result.status}: ${text}`),
      };
    }
    try {
      return JSON.parse(text) as CreateEmbeddingResponse;
    } catch (e) {
      throw {
        retry: false,
        error: new Error(
          `Embedding response invalid JSON (status ${result.status}): ${
            e instanceof Error ? e.message : String(e)
          }\nresponse body:\n${text}`,
        ),
      };
    }
  });
  if (json.data.length !== texts.length) {
    console.error(json);
    throw new Error('Unexpected number of embeddings');
  }
  const allembeddings = json.data;
  allembeddings.sort((a, b) => a.index - b.index);
  return {
    ollama: false as const,
    embeddings: allembeddings.map(({ embedding }) => embedding),
    usage: json.usage?.total_tokens,
    retries,
    ms,
  };
}

export async function fetchEmbedding(text: string) {
  const { embeddings, ...stats } = await fetchEmbeddingBatch([text]);
  return { embedding: embeddings[0], ...stats };
}

// Deterministic pseudo-embedding for dry-run mode: a normalized vector seeded
// from the text so identical text yields identical vectors (cache-friendly).
function stubEmbedding(text: string, dimension: number): number[] {
  let seed = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    seed ^= text.charCodeAt(i);
    seed = Math.imul(seed, 16777619) >>> 0;
  }
  const out = new Array<number>(dimension);
  let norm = 0;
  for (let i = 0; i < dimension; i++) {
    // xorshift32
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    const v = (seed / 0xffffffff) * 2 - 1;
    out[i] = v;
    norm += v * v;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dimension; i++) out[i] /= norm;
  return out;
}

export async function fetchModeration(content: string) {
  // Note: only OpenAI serves /v1/moderations. Unused by default in ClaudeTown
  // (Haiku/Ollama have no moderation endpoint); kept for OpenAI-mode parity.
  const config = getChatConfig();
  const { result: flagged } = await retryWithBackoff(async () => {
    const result = await fetch(config.url + '/v1/moderations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...AuthHeaders(config.apiKey),
      },

      body: JSON.stringify({
        input: content,
      }),
    });
    if (!result.ok) {
      throw {
        retry: result.status === 429 || result.status >= 500,
        error: new Error(`Embedding failed with code ${result.status}: ${await result.text()}`),
      };
    }
    return (await result.json()) as { results: { flagged: boolean }[] };
  });
  return flagged;
}

// ---------------------------------------------------------------------------
// Defensive JSON extraction. The Anthropic compat layer ignores `strict`, so
// model JSON can arrive wrapped in prose or ```json fences. Pull the first
// balanced JSON value out instead of a bare JSON.parse() that throws.
// ---------------------------------------------------------------------------
export function extractJSON<T = unknown>(raw: string): T {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // fall through to fenced / embedded extraction
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : trimmed;
  try {
    return JSON.parse(candidate) as T;
  } catch {
    // fall through to balanced-scan
  }
  const start = candidate.search(/[[{]/);
  if (start !== -1) {
    const open = candidate[start];
    const close = open === '[' ? ']' : '}';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          return JSON.parse(candidate.slice(start, i + 1)) as T;
        }
      }
    }
  }
  throw new Error('extractJSON: no parseable JSON found in model output');
}

// Retry after this much time, based on the retry number.
const RETRY_BACKOFF = [1000, 10_000, 20_000]; // In ms
const RETRY_JITTER = 100; // In ms
type RetryError = { retry: boolean; error: any };

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
): Promise<{ retries: number; result: T; ms: number }> {
  let i = 0;
  for (; i <= RETRY_BACKOFF.length; i++) {
    try {
      const start = Date.now();
      const result = await fn();
      const ms = Date.now() - start;
      return { result, retries: i, ms };
    } catch (e) {
      const retryError = e as RetryError;
      if (i < RETRY_BACKOFF.length) {
        if (retryError.retry) {
          console.log(
            `Attempt ${i + 1} failed, waiting ${RETRY_BACKOFF[i]}ms to retry...`,
            Date.now(),
          );
          await new Promise((resolve) =>
            setTimeout(resolve, RETRY_BACKOFF[i] + RETRY_JITTER * Math.random()),
          );
          continue;
        }
      }
      if (retryError.error) throw retryError.error;
      else throw e;
    }
  }
  throw new Error('Unreachable');
}

// Lifted from openai's package
export interface LLMMessage {
  /**
   * The contents of the message. `content` is required for all messages, and may be
   * null for assistant messages with function calls.
   */
  content: string | null;

  /**
   * The role of the messages author. One of `system`, `user`, `assistant`, or
   * `function`.
   */
  role: 'system' | 'user' | 'assistant' | 'function';

  /**
   * The name of the author of this message. `name` is required if role is
   * `function`, and it should be the name of the function whose response is in the
   * `content`. May contain a-z, A-Z, 0-9, and underscores, with a maximum length of
   * 64 characters.
   */
  name?: string;

  /**
   * The name and arguments of a function that should be called, as generated by the model.
   */
  function_call?: {
    // The name of the function to call.
    name: string;
    /**
     * The arguments to call the function with, as generated by the model in
     * JSON format. Note that the model does not always generate valid JSON,
     * and may hallucinate parameters not defined by your function schema.
     * Validate the arguments in your code before calling your function.
     */
    arguments: string;
  };
}

// Non-streaming chat completion response
interface CreateChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index?: number;
    message?: {
      role: 'system' | 'user' | 'assistant';
      content: string;
    };
    finish_reason?: string;
  }[];
  usage?: {
    completion_tokens: number;

    prompt_tokens: number;

    total_tokens: number;
  };
}

interface CreateEmbeddingResponse {
  data: {
    index: number;
    object: string;
    embedding: number[];
  }[];
  model: string;
  object: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

export interface CreateChatCompletionRequest {
  /**
   * ID of the model to use.
   * @type {string}
   * @memberof CreateChatCompletionRequest
   */
  model: string;
  // | 'gpt-4'
  // | 'gpt-4-0613'
  // | 'gpt-4-32k'
  // | 'gpt-4-32k-0613'
  // | 'gpt-3.5-turbo'; // <- our default
  /**
   * The messages to generate chat completions for, in the chat format:
   * https://platform.openai.com/docs/guides/chat/introduction
   * @type {Array<ChatCompletionRequestMessage>}
   * @memberof CreateChatCompletionRequest
   */
  messages: LLMMessage[];
  /**
   * What sampling temperature to use, between 0 and 2. Higher values like 0.8 will make the output more random, while lower values like 0.2 will make it more focused and deterministic.  We generally recommend altering this or `top_p` but not both.
   * @type {number}
   * @memberof CreateChatCompletionRequest
   */
  temperature?: number | null;
  /**
   * An alternative to sampling with temperature, called nucleus sampling, where the model considers the results of the tokens with top_p probability mass. So 0.1 means only the tokens comprising the top 10% probability mass are considered.  We generally recommend altering this or `temperature` but not both.
   * @type {number}
   * @memberof CreateChatCompletionRequest
   */
  top_p?: number | null;
  /**
   * How many chat completion choices to generate for each input message.
   * @type {number}
   * @memberof CreateChatCompletionRequest
   */
  n?: number | null;
  /**
   * If set, partial message deltas will be sent, like in ChatGPT. Tokens will be sent as data-only [server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#Event_stream_format) as they become available, with the stream terminated by a `data: [DONE]` message.
   * @type {boolean}
   * @memberof CreateChatCompletionRequest
   */
  stream?: boolean | null;
  /**
   *
   * @type {CreateChatCompletionRequestStop}
   * @memberof CreateChatCompletionRequest
   */
  stop?: Array<string> | string;
  /**
   * The maximum number of tokens allowed for the generated answer. By default,
   * the number of tokens the model can return will be (4096 - prompt tokens).
   * @type {number}
   * @memberof CreateChatCompletionRequest
   */
  max_tokens?: number;
  /**
   * Number between -2.0 and 2.0. Positive values penalize new tokens based on
   * whether they appear in the text so far, increasing the model\'s likelihood
   * to talk about new topics. See more information about frequency and
   * presence penalties:
   * https://platform.openai.com/docs/api-reference/parameter-details
   * @type {number}
   * @memberof CreateChatCompletionRequest
   */
  presence_penalty?: number | null;
  /**
   * Number between -2.0 and 2.0. Positive values penalize new tokens based on
   * their existing frequency in the text so far, decreasing the model\'s
   * likelihood to repeat the same line verbatim. See more information about
   * presence penalties:
   * https://platform.openai.com/docs/api-reference/parameter-details
   * @type {number}
   * @memberof CreateChatCompletionRequest
   */
  frequency_penalty?: number | null;
  /**
   * Modify the likelihood of specified tokens appearing in the completion.
   * Accepts a json object that maps tokens (specified by their token ID in the
   * tokenizer) to an associated bias value from -100 to 100. Mathematically,
   * the bias is added to the logits generated by the model prior to sampling.
   * The exact effect will vary per model, but values between -1 and 1 should
   * decrease or increase likelihood of selection; values like -100 or 100
   * should result in a ban or exclusive selection of the relevant token.
   * @type {object}
   * @memberof CreateChatCompletionRequest
   */
  logit_bias?: object | null;
  /**
   * A unique identifier representing your end-user, which can help OpenAI to
   * monitor and detect abuse. Learn more:
   * https://platform.openai.com/docs/guides/safety-best-practices/end-user-ids
   * @type {string}
   * @memberof CreateChatCompletionRequest
   */
  user?: string;
  tools?: {
    // The type of the tool. Currently, only function is supported.
    type: 'function';
    function: {
      /**
       * The name of the function to be called. Must be a-z, A-Z, 0-9, or
       * contain underscores and dashes, with a maximum length of 64.
       */
      name: string;
      /**
       * A description of what the function does, used by the model to choose
       * when and how to call the function.
       */
      description?: string;
      /**
       * The parameters the functions accepts, described as a JSON Schema
       * object. See the guide[1] for examples, and the JSON Schema reference[2]
       * for documentation about the format.
       * [1]: https://platform.openai.com/docs/guides/gpt/function-calling
       * [2]: https://json-schema.org/understanding-json-schema/
       * To describe a function that accepts no parameters, provide the value
       * {"type": "object", "properties": {}}.
       */
      parameters: object;
    };
  }[];
  /**
   * Controls which (if any) function is called by the model. `none` means the
   * model will not call a function and instead generates a message.
   * `auto` means the model can pick between generating a message or calling a
   * function. Specifying a particular function via
   * {"type: "function", "function": {"name": "my_function"}} forces the model
   * to call that function.
   *
   * `none` is the default when no functions are present.
   * `auto` is the default if functions are present.
   */
  tool_choice?:
    | 'none' // none means the model will not call a function and instead generates a message.
    | 'auto' // auto means the model can pick between generating a message or calling a function.
    // Specifies a tool the model should use. Use to force the model to call
    // a specific function.
    | {
        // The type of the tool. Currently, only function is supported.
        type: 'function';
        function: { name: string };
      };
  /**
   * An object specifying the format that the model must output.
   *
   * Setting to { "type": "json_object" } enables JSON mode, which guarantees
   * the message the model generates is valid JSON.
   * *Important*: when using JSON mode, you must also instruct the model to
   * produce JSON yourself via a system or user message. Without this, the model
   * may generate an unending stream of whitespace until the generation reaches
   * the token limit, resulting in a long-running and seemingly "stuck" request.
   * Also note that the message content may be partially cut off if
   * finish_reason="length", which indicates the generation exceeded max_tokens
   * or the conversation exceeded the max context length.
   */
  response_format?: { type: 'text' | 'json_object' };
}

// Checks whether a suffix of s1 is a prefix of s2. For example,
// ('Hello', 'Kira:') -> false
// ('Hello Kira', 'Kira:') -> true
const suffixOverlapsPrefix = (s1: string, s2: string) => {
  for (let i = 1; i <= Math.min(s1.length, s2.length); i++) {
    const suffix = s1.substring(s1.length - i);
    const prefix = s2.substring(0, i);
    if (suffix === prefix) {
      return true;
    }
  }
  return false;
};

export class ChatCompletionContent {
  private readonly body: ReadableStream<Uint8Array>;
  private readonly stopWords: string[];

  constructor(body: ReadableStream<Uint8Array>, stopWords: string[]) {
    this.body = body;
    this.stopWords = stopWords;
  }

  // Build a streaming-shaped result from a fixed string (dry-run mode).
  static fromString(content: string, stopWords: string[]): ChatCompletionContent {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const payload = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
        controller.enqueue(new TextEncoder().encode(payload));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new ChatCompletionContent(body, stopWords);
  }

  async *readInner() {
    for await (const data of this.splitStream(this.body)) {
      if (data.startsWith('data: ')) {
        try {
          const json = JSON.parse(data.substring('data: '.length)) as {
            choices: { delta: { content?: string } }[];
          };
          if (json.choices[0].delta.content) {
            yield json.choices[0].delta.content;
          }
        } catch (e) {
          // e.g. the last chunk is [DONE] which is not valid JSON.
        }
      }
    }
  }

  // stop words in OpenAI api don't always work.
  // So we have to truncate on our side.
  async *read() {
    let lastFragment = '';
    for await (const data of this.readInner()) {
      lastFragment += data;
      let hasOverlap = false;
      for (const stopWord of this.stopWords) {
        const idx = lastFragment.indexOf(stopWord);
        if (idx >= 0) {
          yield lastFragment.substring(0, idx);
          return;
        }
        if (suffixOverlapsPrefix(lastFragment, stopWord)) {
          hasOverlap = true;
        }
      }
      if (hasOverlap) continue;
      yield lastFragment;
      lastFragment = '';
    }
    yield lastFragment;
  }

  async readAll() {
    let allContent = '';
    for await (const chunk of this.read()) {
      allContent += chunk;
    }
    return allContent;
  }

  async *splitStream(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    let lastFragment = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          // Flush the last fragment now that we're done
          if (lastFragment !== '') {
            yield lastFragment;
          }
          break;
        }
        const data = new TextDecoder().decode(value);
        lastFragment += data;
        const parts = lastFragment.split('\n\n');
        // Yield all except for the last part
        for (let i = 0; i < parts.length - 1; i += 1) {
          yield parts[i];
        }
        // Save the last part as the new last fragment
        lastFragment = parts[parts.length - 1];
      }
    } finally {
      reader.releaseLock();
    }
  }
}

export async function ollamaFetchEmbedding(text: string) {
  const config = getEmbeddingConfig();
  const { result } = await retryWithBackoff(async () => {
    const resp = await fetch(config.url + '/api/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: config.embeddingModel, input: text }),
    });
    const textBody = await resp.text();
    if (!resp.ok) {
      if (resp.status === 404) {
        await tryPullOllama(config.embeddingModel, textBody);
      }
      throw {
        retry: resp.status === 429 || resp.status >= 500,
        error: new Error(
          `Ollama embedding failed ${resp.status} ${resp.statusText} at ${config.url}/api/embeddings: ${textBody}`,
        ),
      };
    }
    try {
      const json = JSON.parse(textBody) as { embedding: number[] };
      if (!Array.isArray(json.embedding)) {
        throw new Error(`Invalid embedding response shape: ${textBody}`);
      }
      return json.embedding;
    } catch (e) {
      throw {
        retry: false,
        error: new Error(
          `Ollama embedding response invalid JSON: ${
            e instanceof Error ? e.message : String(e)
          }\nresponse body:\n${textBody}`,
        ),
      };
    }
  });
  return { embedding: result };
}
