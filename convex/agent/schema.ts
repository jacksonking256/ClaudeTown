import { v } from 'convex/values';
import { playerId, conversationId } from '../aiTown/ids';
import { defineTable } from 'convex/server';
import { EMBEDDING_DIMENSION } from '../util/llm';

export const memoryFields = {
  playerId,
  description: v.string(),
  embeddingId: v.id('memoryEmbeddings'),
  importance: v.number(),
  lastAccess: v.number(),
  data: v.union(
    // Setting up dynamics between players
    v.object({
      type: v.literal('relationship'),
      // The player this memory is about, from the perspective of the player
      // whose memory this is.
      playerId,
    }),
    v.object({
      type: v.literal('conversation'),
      conversationId,
      // The other player(s) in the conversation.
      playerIds: v.array(playerId),
    }),
    v.object({
      type: v.literal('reflection'),
      relatedMemoryIds: v.array(v.id('memories')),
    }),
    // A perception of the world or another player. Base of the memory stream
    // and the trigger surface for reactive replanning.
    v.object({
      type: v.literal('observation'),
      about: v.optional(playerId),
    }),
    // A hierarchical plan step (daily agenda -> hourly -> ~15-min block).
    v.object({
      type: v.literal('plan'),
      planId: v.string(),
      level: v.union(v.literal('day'), v.literal('hour'), v.literal('block')),
      parentId: v.optional(v.id('memories')),
      // Minutes from midnight in simulated local time.
      startMinute: v.optional(v.number()),
      endMinute: v.optional(v.number()),
      status: v.optional(
        v.union(
          v.literal('pending'),
          v.literal('active'),
          v.literal('done'),
          v.literal('skipped'),
        ),
      ),
    }),
    // The always-available persona anchor (core self, values, relationships,
    // long-term goal). Preferentially retrieved on every cognition step.
    v.object({
      type: v.literal('identity'),
    }),
  ),
};
export const memoryTables = {
  memories: defineTable(memoryFields)
    .index('embeddingId', ['embeddingId'])
    .index('playerId_type', ['playerId', 'data.type'])
    .index('playerId_importance', ['playerId', 'importance'])
    .index('playerId', ['playerId']),
  memoryEmbeddings: defineTable({
    playerId,
    embedding: v.array(v.float64()),
  }).vectorIndex('embedding', {
    vectorField: 'embedding',
    filterFields: ['playerId'],
    dimensions: EMBEDDING_DIMENSION,
  }),
};

export const agentTables = {
  ...memoryTables,
  embeddingsCache: defineTable({
    textHash: v.bytes(),
    embedding: v.array(v.float64()),
  }).index('text', ['textHash']),
  // Cache poignancy scores by text hash so importance is never recomputed.
  importanceCache: defineTable({
    textHash: v.bytes(),
    importance: v.number(),
  }).index('text', ['textHash']),
};
