// ClaudeTown cognition configuration.
//
// Every knob the upgraded cognition uses lives here, read from the Convex
// deployment env at call time (so it's overridable and unit-testable). This is
// the Concordia-inspired "everything modular and tunable" lesson, reimplemented
// in TS — each cognition component reads only the slice it needs.

function num(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
}

function int(name: string, dflt: number): number {
  return Math.trunc(num(name, dflt));
}

function bool(name: string, dflt: boolean): boolean {
  const raw = (process.env[name] ?? '').toLowerCase();
  if (raw === '') return dflt;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

// --- 1. Three-factor retrieval -------------------------------------------
// Weighted, normalized sum of recency + importance + relevance (Stanford §4.1).
export function retrievalWeights() {
  return {
    recency: num('RETRIEVAL_WEIGHT_RECENCY', 1),
    importance: num('RETRIEVAL_WEIGHT_IMPORTANCE', 1),
    relevance: num('RETRIEVAL_WEIGHT_RELEVANCE', 1),
  };
}
// Exponential time decay applied per hour since a memory was last accessed.
export function recencyDecayPerHour(): number {
  return num('RETRIEVAL_RECENCY_DECAY', 0.99);
}
// How many extra recent / important memories to fold into the candidate set so
// salient-but-less-relevant memories aren't missed (the repo's own TODO).
export function retrievalAugment() {
  return {
    recent: int('RETRIEVAL_AUGMENT_RECENT', 3),
    important: int('RETRIEVAL_AUGMENT_IMPORTANT', 3),
  };
}

// --- 2. Importance scoring ------------------------------------------------
// Stanford uses 1..10 poignancy. Scores are cached by text hash and never
// recomputed (see importanceCache table).
export const IMPORTANCE_MIN = 1;
export const IMPORTANCE_MAX = 10;
export function importanceDefault(): number {
  return num('IMPORTANCE_DEFAULT', 5);
}

// --- 3. Reflection tree ---------------------------------------------------
export function reflection() {
  return {
    // Trigger when accumulated importance since the last reflection crosses this.
    importanceThreshold: num('REFLECTION_THRESHOLD', 500),
    // How many recent memories to look at when generating salient questions.
    recentWindow: int('REFLECTION_RECENT_WINDOW', 100),
    // Stanford: ask the few most salient questions, retrieve per question.
    numQuestions: int('REFLECTION_QUESTIONS', 3),
    memoriesPerQuestion: int('REFLECTION_MEMORIES_PER_QUESTION', 15),
    insightsPerQuestion: int('REFLECTION_INSIGHTS_PER_QUESTION', 2),
  };
}

// --- 4. Hierarchical planning + reactive replanning -----------------------
export function planning() {
  return {
    enabled: bool('ENABLE_PLANNING', true),
    // Cost guardrail: only replan on a *significant* observation, and cap the
    // number of replans per agent per simulated day. Without this, "replan when
    // an observation contradicts the plan" can fire an LLM call on nearly every
    // observation and multiply token use several times over.
    replanMaxPerDay: int('REPLAN_MAX_PER_DAY', 3),
    replanMinImportance: num('REPLAN_MIN_IMPORTANCE', 7),
    hourlyStepsTarget: int('PLAN_HOURLY_STEPS', 5),
    blockMinutes: int('PLAN_BLOCK_MINUTES', 15),
  };
}

// --- 5. Identity anchoring ------------------------------------------------
export function identity() {
  return {
    inject: bool('IDENTITY_INJECT', true),
    // Periodically have the agent restate its core identity so persona DRIFT is
    // measurable (surfaced in the debug panel next to the anchor), not assumed.
    coherenceCheckEnabled: bool('IDENTITY_COHERENCE_CHECK', true),
    coherenceIntervalMs: int('IDENTITY_COHERENCE_INTERVAL_MS', 6 * 60 * 60 * 1000),
  };
}

// --- 6. Game-Master resolver (stretch, off by default) --------------------
export function gameMasterEnabled(): boolean {
  return bool('ENABLE_GAME_MASTER', false);
}

// --- Cost summary ---------------------------------------------------------
// Haiku pricing (USD per 1M tokens), verified against docs.claude.com.
export function haikuPricing() {
  return {
    inputPerMTok: num('HAIKU_INPUT_PRICE', 1.0),
    outputPerMTok: num('HAIKU_OUTPUT_PRICE', 5.0),
  };
}
