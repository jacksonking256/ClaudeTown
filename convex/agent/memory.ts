import { v } from 'convex/values';
import {
  ActionCtx,
  DatabaseReader,
  internalMutation,
  internalQuery,
  query,
} from '../_generated/server';
import { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { LLMMessage, chatCompletion, extractJSON, fetchEmbedding } from '../util/llm';
import { asyncMap } from '../util/asyncMap';
import { GameId, agentId, conversationId, playerId } from '../aiTown/ids';
import { SerializedPlayer } from '../aiTown/player';
import { memoryFields } from './schema';
import {
  retrievalWeights,
  recencyDecayPerHour,
  retrievalAugment,
  importanceDefault,
  IMPORTANCE_MIN,
  IMPORTANCE_MAX,
  reflection as reflectionCfg,
  identity as identityCfg,
  planning as planningCfg,
} from './cognitionConfig';
import { buildIdentityAnchor, cosineSimilarity, restatementPrompt } from './identity';
import * as planning from './planning';

// How long to wait before updating a memory's last access time.
export const MEMORY_ACCESS_THROTTLE = 300_000; // In ms
// We fetch 10x the number of memories by relevance, to have more candidates
// for sorting by relevance + recency + importance.
const MEMORY_OVERFETCH = 10;
const selfInternal = internal.agent.memory;

export type Memory = Doc<'memories'>;
export type MemoryType = Memory['data']['type'];
export type MemoryOfType<T extends MemoryType> = Omit<Memory, 'data'> & {
  data: Extract<Memory['data'], { type: T }>;
};

export async function rememberConversation(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  agentId: GameId<'agents'>,
  playerId: GameId<'players'>,
  conversationId: GameId<'conversations'>,
) {
  const data = await ctx.runQuery(selfInternal.loadConversation, {
    worldId,
    playerId,
    conversationId,
  });
  const { player, otherPlayer } = data;
  const messages = await ctx.runQuery(selfInternal.loadMessages, { worldId, conversationId });
  if (!messages.length) {
    return;
  }

  const llmMessages: LLMMessage[] = [
    {
      role: 'user',
      content: `You are ${player.name}, and you just finished a conversation with ${otherPlayer.name}. I would
      like you to summarize the conversation from ${player.name}'s perspective, using first-person pronouns like
      "I," and add if you liked or disliked this interaction.`,
    },
  ];
  const authors = new Set<GameId<'players'>>();
  for (const message of messages) {
    const author = message.author === player.id ? player : otherPlayer;
    authors.add(author.id as GameId<'players'>);
    const recipient = message.author === player.id ? otherPlayer : player;
    llmMessages.push({
      role: 'user',
      content: `${author.name} to ${recipient.name}: ${message.text}`,
    });
  }
  llmMessages.push({ role: 'user', content: 'Summary:' });
  const { content } = await chatCompletion({
    messages: llmMessages,
    max_tokens: 500,
  });
  const description = `Conversation with ${otherPlayer.name} at ${new Date(
    data.conversation._creationTime,
  ).toLocaleString()}: ${content}`;
  const importance = await calculateImportance(ctx, description);
  const { embedding } = await fetchEmbedding(description);
  authors.delete(player.id as GameId<'players'>);
  await ctx.runMutation(selfInternal.insertMemory, {
    agentId,
    playerId: player.id,
    description,
    importance,
    lastAccess: messages[messages.length - 1]._creationTime,
    data: {
      type: 'conversation',
      conversationId,
      playerIds: [...authors],
    },
    embedding,
  });
  await reflectOnMemories(ctx, worldId, playerId);
  // Persona-coherence check (rate-limited internally). Piggybacks on the
  // post-conversation cadence so no engine-tick surgery is needed.
  await maybeRunIdentityCoherenceCheck(ctx, worldId, playerId);
  // Treat the conversation summary as an observation: if it's significant
  // enough it may contradict the day's plan -> cost-capped reactive replan.
  await maybeReactivelyReplan(ctx, worldId, playerId, importance);
  return description;
}

export const loadConversation = internalQuery({
  args: {
    worldId: v.id('worlds'),
    playerId,
    conversationId,
  },
  handler: async (ctx, args) => {
    const world = await ctx.db.get(args.worldId);
    if (!world) {
      throw new Error(`World ${args.worldId} not found`);
    }
    const player = world.players.find((p) => p.id === args.playerId);
    if (!player) {
      throw new Error(`Player ${args.playerId} not found`);
    }
    const playerDescription = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .first();
    if (!playerDescription) {
      throw new Error(`Player description for ${args.playerId} not found`);
    }
    const conversation = await ctx.db
      .query('archivedConversations')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('id', args.conversationId))
      .first();
    if (!conversation) {
      throw new Error(`Conversation ${args.conversationId} not found`);
    }
    const otherParticipator = await ctx.db
      .query('participatedTogether')
      .withIndex('conversation', (q) =>
        q
          .eq('worldId', args.worldId)
          .eq('player1', args.playerId)
          .eq('conversationId', args.conversationId),
      )
      .first();
    if (!otherParticipator) {
      throw new Error(
        `Couldn't find other participant in conversation ${args.conversationId} with player ${args.playerId}`,
      );
    }
    const otherPlayerId = otherParticipator.player2;
    let otherPlayer: SerializedPlayer | Doc<'archivedPlayers'> | null =
      world.players.find((p) => p.id === otherPlayerId) ?? null;
    if (!otherPlayer) {
      otherPlayer = await ctx.db
        .query('archivedPlayers')
        .withIndex('worldId', (q) => q.eq('worldId', world._id).eq('id', otherPlayerId))
        .first();
    }
    if (!otherPlayer) {
      throw new Error(`Conversation ${args.conversationId} other player not found`);
    }
    const otherPlayerDescription = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', otherPlayerId))
      .first();
    if (!otherPlayerDescription) {
      throw new Error(`Player description for ${otherPlayerId} not found`);
    }
    return {
      player: { ...player, name: playerDescription.name },
      conversation,
      otherPlayer: { ...otherPlayer, name: otherPlayerDescription.name },
    };
  },
});

export async function searchMemories(
  ctx: ActionCtx,
  playerId: GameId<'players'>,
  searchEmbedding: number[],
  n: number = 3,
) {
  const candidates = await ctx.vectorSearch('memoryEmbeddings', 'embedding', {
    vector: searchEmbedding,
    filter: (q) => q.eq('playerId', playerId),
    limit: n * MEMORY_OVERFETCH,
  });
  const rankedMemories = await ctx.runMutation(selfInternal.rankAndTouchMemories, {
    playerId,
    candidates,
    n,
  });
  return rankedMemories.map(({ memory }) => memory);
}

function makeRange(values: number[]) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return [min, max] as const;
}

function normalize(value: number, range: readonly [number, number]) {
  const [min, max] = range;
  // Degenerate range (all equal, or no values) -> neutral 0 so the factor
  // contributes nothing rather than NaN.
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) return 0;
  return (value - min) / (max - min);
}

// Three-factor retrieval (Stanford §4.1): score each candidate by a weighted,
// normalized sum of recency (exponential decay since last access), importance
// (poignancy), and relevance (embedding cosine similarity). Weights and decay
// are config-driven. We also fold in the most recent and most important
// memories so salient-but-less-relevant ones aren't missed by vector search.
export const rankAndTouchMemories = internalMutation({
  args: {
    playerId,
    candidates: v.array(v.object({ _id: v.id('memoryEmbeddings'), _score: v.number() })),
    n: v.number(),
  },
  handler: async (ctx, args) => {
    const ts = Date.now();
    const weights = retrievalWeights();
    const decay = recencyDecayPerHour();
    const augment = retrievalAugment();

    // Relevance comes only from vector search; key it by memory id.
    const relevanceById = new Map<string, number>();
    const byId = new Map<string, Doc<'memories'>>();
    await asyncMap(args.candidates, async ({ _id, _score }) => {
      const memory = await ctx.db
        .query('memories')
        .withIndex('embeddingId', (q) => q.eq('embeddingId', _id))
        .first();
      if (!memory) throw new Error(`Memory for embedding ${_id} not found`);
      byId.set(memory._id, memory);
      relevanceById.set(memory._id, _score);
    });

    // Augment with recent + important memories (no vector relevance score).
    if (augment.recent > 0) {
      const recent = await ctx.db
        .query('memories')
        .withIndex('playerId', (q) => q.eq('playerId', args.playerId))
        .order('desc')
        .take(augment.recent);
      for (const m of recent) if (!byId.has(m._id)) byId.set(m._id, m);
    }
    if (augment.important > 0) {
      const important = await ctx.db
        .query('memories')
        .withIndex('playerId_importance', (q) => q.eq('playerId', args.playerId))
        .order('desc')
        .take(augment.important);
      for (const m of important) if (!byId.has(m._id)) byId.set(m._id, m);
    }

    const memories = [...byId.values()];
    if (memories.length === 0) return [];

    const recencyScore = memories.map((memory) => {
      const hoursSinceAccess = (ts - memory.lastAccess) / 1000 / 60 / 60;
      return decay ** Math.floor(Math.max(0, hoursSinceAccess));
    });
    // Relevance range is computed over vector scores; augmented memories with no
    // score fall to the bottom (normalized 0) instead of being dropped.
    const relevanceValues = [...relevanceById.values()];
    const relevanceRange = makeRange(relevanceValues);
    const relevanceMin = relevanceValues.length ? Math.min(...relevanceValues) : 0;
    const importanceRange = makeRange(memories.map((m) => m.importance));
    const recencyRange = makeRange(recencyScore);

    const memoryScores = memories.map((memory, idx) => {
      const relevance = relevanceById.has(memory._id)
        ? relevanceById.get(memory._id)!
        : relevanceMin;
      return {
        memory,
        overallScore:
          weights.relevance * normalize(relevance, relevanceRange) +
          weights.importance * normalize(memory.importance, importanceRange) +
          weights.recency * normalize(recencyScore[idx], recencyRange),
      };
    });
    memoryScores.sort((a, b) => b.overallScore - a.overallScore);
    const accessed = memoryScores.slice(0, args.n);
    await asyncMap(accessed, async ({ memory }) => {
      if (memory.lastAccess < ts - MEMORY_ACCESS_THROTTLE) {
        await ctx.db.patch(memory._id, { lastAccess: ts });
      }
    });
    return accessed;
  },
});

export const loadMessages = internalQuery({
  args: {
    worldId: v.id('worlds'),
    conversationId,
  },
  handler: async (ctx, args): Promise<Doc<'messages'>[]> => {
    const messages = await ctx.db
      .query('messages')
      .withIndex('conversationId', (q) =>
        q.eq('worldId', args.worldId).eq('conversationId', args.conversationId),
      )
      .collect();
    return messages;
  },
});

// Importance / poignancy scoring (Stanford §4.2), 1..10. Computed by a cheap
// chat call at write time and cached by text hash so it is never recomputed.
async function calculateImportance(ctx: ActionCtx, description: string): Promise<number> {
  const textHash = await hashText(description);
  const cached = await ctx.runQuery(selfInternal.getCachedImportance, { textHash });
  if (cached !== null) return cached;

  const { content: importanceRaw } = await chatCompletion({
    messages: [
      {
        role: 'user',
        content: `On the scale of ${IMPORTANCE_MIN} to ${IMPORTANCE_MAX}, where ${IMPORTANCE_MIN} is purely mundane (e.g., brushing teeth, making bed) and ${IMPORTANCE_MAX} is extremely poignant (e.g., a break up, college acceptance), rate the likely poignancy of the following piece of memory.
      Memory: ${description}
      Answer on a scale of ${IMPORTANCE_MIN} to ${IMPORTANCE_MAX}. Respond with number only, e.g. "5"`,
      },
    ],
    temperature: 0.0,
    max_tokens: 4,
  });

  let importance = parseFloat(importanceRaw);
  if (isNaN(importance)) {
    importance = +(importanceRaw.match(/\d+/)?.[0] ?? NaN);
  }
  if (isNaN(importance)) {
    console.debug('Could not parse memory importance from: ', importanceRaw);
    importance = importanceDefault();
  }
  importance = Math.max(IMPORTANCE_MIN, Math.min(IMPORTANCE_MAX, importance));
  await ctx.runMutation(selfInternal.setCachedImportance, { textHash, importance });
  return importance;
}

async function hashText(text: string): Promise<ArrayBuffer> {
  const buf = new TextEncoder().encode(text);
  if (typeof crypto === 'undefined') {
    const f = () => 'node:crypto';
    const nodeCrypto = (await import(f())) as typeof import('crypto');
    const hash = nodeCrypto.createHash('sha256');
    hash.update(buf);
    return hash.digest().buffer;
  }
  return await crypto.subtle.digest('SHA-256', buf);
}

export const getCachedImportance = internalQuery({
  args: { textHash: v.bytes() },
  handler: async (ctx, args): Promise<number | null> => {
    const row = await ctx.db
      .query('importanceCache')
      .withIndex('text', (q) => q.eq('textHash', args.textHash))
      .first();
    return row ? row.importance : null;
  },
});

export const setCachedImportance = internalMutation({
  args: { textHash: v.bytes(), importance: v.number() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('importanceCache')
      .withIndex('text', (q) => q.eq('textHash', args.textHash))
      .first();
    if (!existing) {
      await ctx.db.insert('importanceCache', {
        textHash: args.textHash,
        importance: args.importance,
      });
    }
  },
});

const { embeddingId: _embeddingId, ...memoryFieldsWithoutEmbeddingId } = memoryFields;

export const insertMemory = internalMutation({
  args: {
    agentId,
    embedding: v.array(v.float64()),
    ...memoryFieldsWithoutEmbeddingId,
  },
  handler: async (ctx, { agentId: _, embedding, ...memory }): Promise<void> => {
    const embeddingId = await ctx.db.insert('memoryEmbeddings', {
      playerId: memory.playerId,
      embedding,
    });
    await ctx.db.insert('memories', {
      ...memory,
      embeddingId,
    });
  },
});

export const insertReflectionMemories = internalMutation({
  args: {
    worldId: v.id('worlds'),
    playerId,
    reflections: v.array(
      v.object({
        description: v.string(),
        relatedMemoryIds: v.array(v.id('memories')),
        importance: v.number(),
        embedding: v.array(v.float64()),
      }),
    ),
  },
  handler: async (ctx, { playerId, reflections }) => {
    const lastAccess = Date.now();
    for (const { embedding, relatedMemoryIds, ...rest } of reflections) {
      const embeddingId = await ctx.db.insert('memoryEmbeddings', {
        playerId,
        embedding,
      });
      await ctx.db.insert('memories', {
        playerId,
        embeddingId,
        lastAccess,
        ...rest,
        data: {
          type: 'reflection',
          relatedMemoryIds,
        },
      });
    }
  },
});

async function reflectOnMemories(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  playerId: GameId<'players'>,
) {
  const cfg = reflectionCfg();
  const { memories, lastReflectionTs, name } = await ctx.runQuery(
    internal.agent.memory.getReflectionMemories,
    {
      worldId,
      playerId,
      numberOfItems: cfg.recentWindow,
    },
  );

  // Trigger only when accumulated importance since the last reflection crosses
  // the (configurable) threshold.
  const sumOfImportanceScore = memories
    .filter((m) => m._creationTime > (lastReflectionTs ?? 0))
    .reduce((acc, curr) => acc + curr.importance, 0);
  if (sumOfImportanceScore <= cfg.importanceThreshold) {
    return false;
  }
  console.debug(`Reflecting (importance ${sumOfImportanceScore} > ${cfg.importanceThreshold})...`);

  // Step 1 (Stanford §4.3): ask for the few most salient questions about the
  // recent memories.
  const qPrompt = [
    '[Output only JSON]',
    `You are ${name}. Recent statements about your life:`,
    ...memories.map((m, idx) => `Statement ${idx}: ${m.description}`),
    `Given only the above, what are the ${cfg.numQuestions} most salient high-level questions you could ask about the subjects in the statements?`,
    'Return a JSON array of question strings, e.g. ["...", "..."]. JSON only.',
  ].join('\n');
  const { content: qRaw } = await chatCompletion({
    messages: [{ role: 'user', content: qPrompt }],
    max_tokens: 400,
  });
  let questions: string[];
  try {
    questions = extractJSON<string[]>(qRaw).filter((q) => typeof q === 'string');
  } catch (e) {
    console.error('could not parse reflection questions; using a default', e);
    questions = ['What are the most important things I should reflect on right now?'];
  }
  questions = questions.slice(0, cfg.numQuestions);

  // Step 2: for each question, retrieve relevant memories (three-factor
  // retrieval, which itself includes prior reflections -> the tree), then
  // synthesize higher-level insights tagged with their supporting evidence.
  const reflectionsToSave: {
    description: string;
    embedding: number[];
    importance: number;
    relatedMemoryIds: Id<'memories'>[];
  }[] = [];

  for (const question of questions) {
    const { embedding: qEmbedding } = await fetchEmbedding(question);
    const relevant = await searchMemories(ctx, playerId, qEmbedding, cfg.memoriesPerQuestion);
    if (relevant.length === 0) continue;

    const sPrompt = [
      '[Output only JSON]',
      `You are ${name}. Question: ${question}`,
      'Relevant statements from your memory:',
      ...relevant.map((m, idx) => `Statement ${idx}: ${m.description}`),
      `What ${cfg.insightsPerQuestion} high-level insight(s) can you infer to answer the question?`,
      'Return JSON: [{"insight":"...","statementIds":[0,1]}]. statementIds index the statements above. JSON only.',
    ].join('\n');
    const { content: sRaw } = await chatCompletion({
      messages: [{ role: 'user', content: sPrompt }],
      max_tokens: 600,
    });
    let insights: { insight: string; statementIds: number[] }[];
    try {
      insights = extractJSON<{ insight: string; statementIds: number[] }[]>(sRaw);
    } catch (e) {
      console.error('could not parse reflection insights for a question; skipping', e);
      continue;
    }
    for (const item of insights.slice(0, cfg.insightsPerQuestion)) {
      if (!item || typeof item.insight !== 'string') continue;
      const relatedMemoryIds = (item.statementIds ?? [])
        .map((idx) => relevant[idx]?._id)
        .filter((id): id is Id<'memories'> => !!id);
      const importance = await calculateImportance(ctx, item.insight);
      const { embedding } = await fetchEmbedding(item.insight);
      reflectionsToSave.push({ description: item.insight, embedding, importance, relatedMemoryIds });
    }
  }

  if (reflectionsToSave.length === 0) return false;
  await ctx.runMutation(selfInternal.insertReflectionMemories, {
    worldId,
    playerId,
    reflections: reflectionsToSave,
  });
  return true;
}
export const getReflectionMemories = internalQuery({
  args: { worldId: v.id('worlds'), playerId, numberOfItems: v.number() },
  handler: async (ctx, args) => {
    const world = await ctx.db.get(args.worldId);
    if (!world) {
      throw new Error(`World ${args.worldId} not found`);
    }
    const player = world.players.find((p) => p.id === args.playerId);
    if (!player) {
      throw new Error(`Player ${args.playerId} not found`);
    }
    const playerDescription = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .first();
    if (!playerDescription) {
      throw new Error(`Player description for ${args.playerId} not found`);
    }
    const memories = await ctx.db
      .query('memories')
      .withIndex('playerId', (q) => q.eq('playerId', player.id))
      .order('desc')
      .take(args.numberOfItems);

    const lastReflection = await ctx.db
      .query('memories')
      .withIndex('playerId_type', (q) =>
        q.eq('playerId', args.playerId).eq('data.type', 'reflection'),
      )
      .order('desc')
      .first();

    return {
      name: playerDescription.name,
      memories,
      lastReflectionTs: lastReflection?._creationTime,
    };
  },
});

export async function latestMemoryOfType<T extends MemoryType>(
  db: DatabaseReader,
  playerId: GameId<'players'>,
  type: T,
) {
  const entry = await db
    .query('memories')
    .withIndex('playerId_type', (q) => q.eq('playerId', playerId).eq('data.type', type))
    .order('desc')
    .first();
  if (!entry) return null;
  return entry as MemoryOfType<T>;
}

// ---------------------------------------------------------------------------
// Identity anchoring (Stanford/Concordia-inspired persona coherence).
// ---------------------------------------------------------------------------

// Loads the persona anchor fields + the timestamp of the last coherence check.
export const loadIdentity = internalQuery({
  args: { worldId: v.id('worlds'), playerId },
  handler: async (ctx, args) => {
    const world = await ctx.db.get(args.worldId);
    if (!world) return null;
    const agent = world.agents.find((a) => a.playerId === args.playerId);
    if (!agent) return null;
    const agentDescription = await ctx.db
      .query('agentDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('agentId', agent.id))
      .first();
    if (!agentDescription) return null;
    const playerDescription = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .first();
    const lastCheck = await ctx.db
      .query('identityChecks')
      .withIndex('playerId', (q) => q.eq('playerId', args.playerId))
      .order('desc')
      .first();
    return {
      name: playerDescription?.name ?? 'Someone',
      identity: agentDescription.identity,
      plan: agentDescription.plan,
      values: agentDescription.values,
      relationships: agentDescription.relationships,
      longTermGoal: agentDescription.longTermGoal,
      lastCheckTs: lastCheck?._creationTime,
    };
  },
});

export const recordIdentityCheck = internalMutation({
  args: {
    worldId: v.id('worlds'),
    playerId,
    anchor: v.string(),
    restatement: v.string(),
    similarity: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('identityChecks', {
      worldId: args.worldId,
      playerId: args.playerId,
      anchor: args.anchor,
      restatement: args.restatement,
      similarity: args.similarity,
    });
  },
});

// Public query for the debug panel: latest coherence check for a player.
export const latestIdentityCheck = query({
  args: { worldId: v.id('worlds'), playerId },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query('identityChecks')
      .withIndex('playerId', (q) => q.eq('playerId', args.playerId))
      .order('desc')
      .first();
    if (!row) return null;
    return {
      anchor: row.anchor,
      restatement: row.restatement,
      similarity: row.similarity,
      // Drift in [0, ~2]; 0 = perfectly on-persona.
      drift: 1 - row.similarity,
      ts: row._creationTime,
    };
  },
});

// Restate-and-measure: ask the agent who it is, embed the restatement, and
// record cosine similarity to the anchor. Rate-limited by config interval.
export async function maybeRunIdentityCoherenceCheck(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  playerId: GameId<'players'>,
): Promise<{ restatement: string; similarity: number } | null> {
  const cfg = identityCfg();
  if (!cfg.coherenceCheckEnabled) return null;
  const data = await ctx.runQuery(selfInternal.loadIdentity, { worldId, playerId });
  if (!data) return null;
  if (data.lastCheckTs && Date.now() - data.lastCheckTs < cfg.coherenceIntervalMs) {
    return null;
  }
  const anchor = buildIdentityAnchor(data);
  const { content: restatement } = await chatCompletion({
    messages: [
      { role: 'system', content: anchor },
      { role: 'user', content: restatementPrompt(data.name) },
    ],
    max_tokens: 200,
  });
  const [anchorEmb, restateEmb] = await Promise.all([
    fetchEmbedding(anchor),
    fetchEmbedding(restatement),
  ]);
  const similarity = cosineSimilarity(anchorEmb.embedding, restateEmb.embedding);
  console.debug(`[identity] ${data.name} coherence similarity=${similarity.toFixed(3)}`);
  await ctx.runMutation(selfInternal.recordIdentityCheck, {
    worldId,
    playerId,
    anchor,
    restatement,
    similarity,
  });
  return { restatement, similarity };
}

// ---------------------------------------------------------------------------
// Hierarchical planning + reactive replanning (Stanford §4.4).
// ---------------------------------------------------------------------------

// Reads the day's plan-control row + the timed block memories for `planId`.
export const getPlanState = internalQuery({
  args: { playerId, planId: v.string() },
  handler: async (ctx, args) => {
    const meta = await ctx.db
      .query('planMeta')
      .withIndex('playerId_planId', (q) =>
        q.eq('playerId', args.playerId).eq('planId', args.planId),
      )
      .first();
    const planMemories = await ctx.db
      .query('memories')
      .withIndex('playerId_type', (q) => q.eq('playerId', args.playerId).eq('data.type', 'plan'))
      .collect();
    const blocks = planMemories
      .flatMap((m) => {
        if (m.data.type !== 'plan' || m.data.planId !== args.planId || m.data.level !== 'block') {
          return [];
        }
        return [
          {
            memoryId: m._id,
            startMinute: m.data.startMinute ?? 0,
            endMinute: m.data.endMinute ?? 0,
            description: m.description,
            emoji: m.data.emoji,
          },
        ];
      })
      .sort((a, b) => a.startMinute - b.startMinute);
    return {
      meta: meta ? { replans: meta.replans, agenda: meta.agenda } : null,
      blocks,
    };
  },
});

// Public query for the debug panel: today's agenda + remaining blocks.
export const latestPlan = query({
  args: { playerId },
  handler: async (ctx, args) => {
    const planId = planning.planIdForDate(new Date());
    const meta = await ctx.db
      .query('planMeta')
      .withIndex('playerId_planId', (q) => q.eq('playerId', args.playerId).eq('planId', planId))
      .first();
    if (!meta) return null;
    const planMemories = await ctx.db
      .query('memories')
      .withIndex('playerId_type', (q) => q.eq('playerId', args.playerId).eq('data.type', 'plan'))
      .collect();
    const blocks = planMemories
      .flatMap((m) =>
        m.data.type === 'plan' && m.data.planId === planId && m.data.level === 'block'
          ? [
              {
                start: planning.minutesToHHMM(m.data.startMinute ?? 0),
                end: planning.minutesToHHMM(m.data.endMinute ?? 0),
                description: m.description,
                emoji: m.data.emoji,
              },
            ]
          : [],
      )
      .sort((a, b) => (a.start < b.start ? -1 : 1));
    return { planId, agenda: meta.agenda, replans: meta.replans, blocks };
  },
});

export const savePlan = internalMutation({
  args: {
    worldId: v.id('worlds'),
    playerId,
    planId: v.string(),
    agenda: v.string(),
    agendaEmbedding: v.array(v.float64()),
    isReplan: v.boolean(),
    fromMinute: v.optional(v.number()),
    blocks: v.array(
      v.object({
        startMinute: v.number(),
        endMinute: v.number(),
        description: v.string(),
        emoji: v.optional(v.string()),
        embedding: v.array(v.float64()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('planMeta')
      .withIndex('playerId_planId', (q) =>
        q.eq('playerId', args.playerId).eq('planId', args.planId),
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        agenda: args.agenda,
        replans: existing.replans + (args.isReplan ? 1 : 0),
      });
    } else {
      await ctx.db.insert('planMeta', {
        worldId: args.worldId,
        playerId: args.playerId,
        planId: args.planId,
        agenda: args.agenda,
        replans: 0,
      });
    }

    // On a replan, drop the block memories from `fromMinute` forward so the new
    // ones replace them (the past is left as-is).
    if (args.isReplan && args.fromMinute !== undefined) {
      const planMemories = await ctx.db
        .query('memories')
        .withIndex('playerId_type', (q) =>
          q.eq('playerId', args.playerId).eq('data.type', 'plan'),
        )
        .collect();
      for (const m of planMemories) {
        if (
          m.data.type === 'plan' &&
          m.data.planId === args.planId &&
          m.data.level === 'block' &&
          (m.data.endMinute ?? 0) > args.fromMinute
        ) {
          await ctx.db.delete(m.embeddingId);
          await ctx.db.delete(m._id);
        }
      }
    }

    const ts = Date.now();
    // Day-level memory only on first generation (keeps the stream from filling
    // with duplicate agendas on replan).
    if (!args.isReplan) {
      const dayEmbeddingId = await ctx.db.insert('memoryEmbeddings', {
        playerId: args.playerId,
        embedding: args.agendaEmbedding,
      });
      await ctx.db.insert('memories', {
        playerId: args.playerId,
        description: args.agenda,
        embeddingId: dayEmbeddingId,
        importance: 5,
        lastAccess: ts,
        data: { type: 'plan', planId: args.planId, level: 'day' },
      });
    }
    for (const b of args.blocks) {
      const embeddingId = await ctx.db.insert('memoryEmbeddings', {
        playerId: args.playerId,
        embedding: b.embedding,
      });
      await ctx.db.insert('memories', {
        playerId: args.playerId,
        description: b.description,
        embeddingId,
        importance: 3,
        lastAccess: ts,
        data: {
          type: 'plan',
          planId: args.planId,
          level: 'block',
          startMinute: b.startMinute,
          endMinute: b.endMinute,
          emoji: b.emoji,
          status: 'pending',
        },
      });
    }
  },
});

// LLM orchestration: generate (or replan) the day's schedule. fromMinute set =>
// reactive replan that only rewrites the remainder of the day.
async function generatePlan(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  playerId: GameId<'players'>,
  planId: string,
  fromMinute?: number,
): Promise<planning.PlanBlock[]> {
  const cfg = planningCfg();
  const id = await ctx.runQuery(selfInternal.loadIdentity, { worldId, playerId });
  if (!id) return [];
  const anchor = buildIdentityAnchor(id);

  const { content: agenda } = await chatCompletion({
    messages: [{ role: 'user', content: planning.dailyAgendaPrompt(anchor, id.name, planId) }],
    max_tokens: 300,
  });
  const { content: scheduleRaw } = await chatCompletion({
    messages: [
      { role: 'user', content: planning.schedulePrompt(anchor, id.name, agenda, cfg.blockMinutes) },
    ],
    max_tokens: 1200,
  });
  let blocks: planning.PlanBlock[];
  try {
    blocks = planning.parseSchedule(extractJSON(scheduleRaw));
  } catch (e) {
    console.error('[planning] could not parse schedule', e);
    return [];
  }
  if (fromMinute !== undefined) {
    blocks = blocks.filter((b) => b.endMinute > fromMinute);
  }
  if (blocks.length === 0) return [];

  const agendaEmbedding = (await fetchEmbedding(agenda)).embedding;
  const withEmbeddings = await asyncMap(blocks, async (b) => ({
    ...b,
    embedding: (await fetchEmbedding(b.description)).embedding,
  }));
  await ctx.runMutation(selfInternal.savePlan, {
    worldId,
    playerId,
    planId,
    agenda,
    agendaEmbedding,
    isReplan: fromMinute !== undefined,
    fromMinute,
    blocks: withEmbeddings,
  });
  return blocks;
}

// Ensure today's plan exists (generate once per simulated morning), returning
// its blocks.
export async function ensureDayPlan(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  playerId: GameId<'players'>,
): Promise<planning.PlanBlock[]> {
  if (!planningCfg().enabled) return [];
  const planId = planning.planIdForDate(new Date());
  const state = await ctx.runQuery(selfInternal.getPlanState, { playerId, planId });
  if (state.blocks.length > 0) {
    return state.blocks.map((b) => ({
      startMinute: b.startMinute,
      endMinute: b.endMinute,
      description: b.description,
      emoji: b.emoji,
    }));
  }
  return await generatePlan(ctx, worldId, playerId, planId);
}

// The activity the agent should currently be doing per its plan, if any.
export async function currentPlannedActivity(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  playerId: GameId<'players'>,
): Promise<{ description: string; emoji?: string; durationMinutes: number } | null> {
  const blocks = await ensureDayPlan(ctx, worldId, playerId);
  if (blocks.length === 0) return null;
  const nowMinute = planning.minutesOfDay(new Date());
  const block = planning.currentBlock(blocks, nowMinute);
  if (!block) return null;
  const durationMinutes = Math.max(1, block.endMinute - Math.max(nowMinute, block.startMinute));
  return { description: block.description, emoji: block.emoji, durationMinutes };
}

// Reactive replanning, cost-capped: only when the observation is significant
// enough AND the per-day replan budget isn't exhausted.
export async function maybeReactivelyReplan(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  playerId: GameId<'players'>,
  observationImportance: number,
): Promise<boolean> {
  const cfg = planningCfg();
  if (!cfg.enabled) return false;
  if (observationImportance < cfg.replanMinImportance) return false;
  const planId = planning.planIdForDate(new Date());
  const state = await ctx.runQuery(selfInternal.getPlanState, { playerId, planId });
  // Nothing to contradict if there's no plan yet today.
  if (!state.meta) return false;
  if (state.meta.replans >= cfg.replanMaxPerDay) return false;
  const nowMinute = planning.minutesOfDay(new Date());
  console.debug(
    `[planning] reactive replan for ${playerId} (importance ${observationImportance}, replan #${
      state.meta.replans + 1
    })`,
  );
  const blocks = await generatePlan(ctx, worldId, playerId, planId, nowMinute);
  return blocks.length > 0;
}
