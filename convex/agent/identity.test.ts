import { buildIdentityAnchor, cosineSimilarity, identityPromptLines } from './identity';

describe('buildIdentityAnchor', () => {
  test('includes all provided persona facets', () => {
    const anchor = buildIdentityAnchor({
      name: 'Ada',
      identity: 'a curious engineer',
      values: 'honesty, craft',
      relationships: 'sister to Tom',
      longTermGoal: 'build a calculating engine',
    });
    expect(anchor).toContain('Name: Ada');
    expect(anchor).toContain('Core self: a curious engineer');
    expect(anchor).toContain('Values: honesty, craft');
    expect(anchor).toContain('Key relationships: sister to Tom');
    expect(anchor).toContain('Long-term goal: build a calculating engine');
  });
  test('falls back to plan when no explicit long-term goal', () => {
    const anchor = buildIdentityAnchor({ identity: 'x', plan: 'find love' });
    expect(anchor).toContain('Long-term goal: find love');
  });
  test('omits absent facets', () => {
    const anchor = buildIdentityAnchor({ identity: 'just me' });
    expect(anchor).toBe('Core self: just me');
  });
});

describe('identityPromptLines', () => {
  test('prefixes a who-you-are instruction', () => {
    const lines = identityPromptLines('Core self: x');
    expect(lines[0]).toMatch(/who you are/i);
    expect(lines).toContain('Core self: x');
  });
});

describe('cosineSimilarity (drift metric)', () => {
  test('identical vectors -> 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });
  test('orthogonal vectors -> 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });
  test('opposite vectors -> -1', () => {
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1);
  });
  test('zero vector -> 0 (no NaN)', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});
