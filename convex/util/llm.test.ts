import {
  extractJSON,
  getChatConfig,
  getEmbeddingConfig,
  chatCompletion,
  EMBEDDING_DIMENSION,
} from './llm';

// Snapshot and restore env around each test so cases don't leak into each other.
const SAVED = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED };
});

describe('extractJSON (compat layer ignores `strict`, so parse defensively)', () => {
  test('plain JSON array', () => {
    expect(extractJSON('[{"a":1}]')).toEqual([{ a: 1 }]);
  });
  test('fenced ```json block', () => {
    const raw = 'Sure!\n```json\n[{"insight":"x","statementIds":[0,1]}]\n```\n';
    expect(extractJSON(raw)).toEqual([{ insight: 'x', statementIds: [0, 1] }]);
  });
  test('JSON embedded in prose', () => {
    const raw = 'Here are the insights: [{"insight":"y","statementIds":[2]}] hope that helps';
    expect(extractJSON(raw)).toEqual([{ insight: 'y', statementIds: [2] }]);
  });
  test('object with nested braces and a string containing a brace', () => {
    const raw = 'noise {"k":"a}b","n":{"m":1}} trailing';
    expect(extractJSON(raw)).toEqual({ k: 'a}b', n: { m: 1 } });
  });
  test('throws on non-JSON', () => {
    expect(() => extractJSON('definitely not json')).toThrow();
  });
});

describe('completions provider switch', () => {
  test('COMPLETIONS_PROVIDER=haiku targets Anthropic OpenAI-compat endpoint', () => {
    process.env.COMPLETIONS_PROVIDER = 'haiku';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const cfg = getChatConfig();
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.url).toBe('https://api.anthropic.com');
    expect(cfg.chatModel).toBe('claude-haiku-4-5');
    expect(cfg.apiKey).toBe('sk-test');
  });
  test('COMPLETIONS_PROVIDER=ollama stays local', () => {
    process.env.COMPLETIONS_PROVIDER = 'ollama';
    const cfg = getChatConfig();
    expect(cfg.provider).toBe('ollama');
    expect(cfg.apiKey).toBeUndefined();
  });
  test('unknown provider throws', () => {
    process.env.COMPLETIONS_PROVIDER = 'gpt5';
    expect(() => getChatConfig()).toThrow(/Unknown COMPLETIONS_PROVIDER/);
  });
});

describe('embedding provider stays independent of chat provider', () => {
  test('defaults to local Ollama mxbai-embed-large @ 1024', () => {
    const cfg = getEmbeddingConfig();
    expect(cfg.provider).toBe('ollama');
    expect(cfg.embeddingModel).toBe('mxbai-embed-large');
    expect(cfg.dimension).toBe(1024);
    expect(EMBEDDING_DIMENSION).toBe(1024);
  });
  test('dimension mismatch fails loudly (the classic AI Town footgun)', () => {
    process.env.EMBEDDING_PROVIDER = 'openai'; // 1536 != 1024
    expect(() => getEmbeddingConfig()).toThrow(/dimension mismatch/i);
  });
});

describe('dry-run stub mode (free plumbing test)', () => {
  test('reflection-style prompt yields parseable JSON end-to-end', async () => {
    process.env.LLM_STUB = '1';
    const { content } = await chatCompletion({
      messages: [
        {
          role: 'user',
          content:
            'Return JSON insights. Example: [{insight:"...",statementIds:[1]}]. What insight do you infer?',
        },
      ],
    });
    const parsed = extractJSON<{ insight: string; statementIds: number[] }[]>(content);
    expect(Array.isArray(parsed)).toBe(true);
    expect(typeof parsed[0].insight).toBe('string');
    expect(Array.isArray(parsed[0].statementIds)).toBe(true);
  });
  test('importance-style prompt yields a number', async () => {
    process.env.LLM_STUB = '1';
    const { content } = await chatCompletion({
      messages: [{ role: 'user', content: 'On the scale of 0 to 9, rate the poignancy. Memory: x' }],
      max_tokens: 1,
    });
    expect(Number.isNaN(parseFloat(content))).toBe(false);
  });
});
