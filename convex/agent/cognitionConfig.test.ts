import {
  retrievalWeights,
  recencyDecayPerHour,
  retrievalAugment,
  reflection,
  planning,
  identity,
  gameMasterEnabled,
  IMPORTANCE_MIN,
  IMPORTANCE_MAX,
} from './cognitionConfig';

const SAVED = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED };
});

describe('cognition config defaults', () => {
  test('retrieval weights default to equal 1s', () => {
    expect(retrievalWeights()).toEqual({ recency: 1, importance: 1, relevance: 1 });
  });
  test('recency decay default 0.99/hour', () => {
    expect(recencyDecayPerHour()).toBeCloseTo(0.99);
  });
  test('importance scale is 1..10', () => {
    expect([IMPORTANCE_MIN, IMPORTANCE_MAX]).toEqual([1, 10]);
  });
  test('planning is on with cost caps by default', () => {
    const p = planning();
    expect(p.enabled).toBe(true);
    expect(p.replanMaxPerDay).toBeGreaterThan(0);
    expect(p.replanMinImportance).toBeGreaterThan(0);
  });
  test('game master off by default (stretch, flagged)', () => {
    expect(gameMasterEnabled()).toBe(false);
  });
  test('identity injection + coherence check on by default', () => {
    const i = identity();
    expect(i.inject).toBe(true);
    expect(i.coherenceCheckEnabled).toBe(true);
  });
});

describe('cognition config env overrides', () => {
  test('retrieval weights are tunable', () => {
    process.env.RETRIEVAL_WEIGHT_RECENCY = '0.5';
    process.env.RETRIEVAL_WEIGHT_IMPORTANCE = '2';
    process.env.RETRIEVAL_WEIGHT_RELEVANCE = '3';
    expect(retrievalWeights()).toEqual({ recency: 0.5, importance: 2, relevance: 3 });
  });
  test('reflection threshold + question counts are tunable', () => {
    process.env.REFLECTION_THRESHOLD = '120';
    process.env.REFLECTION_QUESTIONS = '5';
    const r = reflection();
    expect(r.importanceThreshold).toBe(120);
    expect(r.numQuestions).toBe(5);
  });
  test('replan caps are tunable (cost guardrail)', () => {
    process.env.REPLAN_MAX_PER_DAY = '1';
    process.env.REPLAN_MIN_IMPORTANCE = '9';
    const p = planning();
    expect(p.replanMaxPerDay).toBe(1);
    expect(p.replanMinImportance).toBe(9);
  });
  test('augmentation counts are tunable', () => {
    process.env.RETRIEVAL_AUGMENT_RECENT = '0';
    process.env.RETRIEVAL_AUGMENT_IMPORTANT = '7';
    expect(retrievalAugment()).toEqual({ recent: 0, important: 7 });
  });
  test('garbage values fall back to defaults', () => {
    process.env.RETRIEVAL_WEIGHT_RECENCY = 'not-a-number';
    expect(retrievalWeights().recency).toBe(1);
  });
});
