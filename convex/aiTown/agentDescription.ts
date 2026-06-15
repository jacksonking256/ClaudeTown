import { ObjectType, v } from 'convex/values';
import { GameId, agentId, parseGameId } from './ids';

export class AgentDescription {
  agentId: GameId<'agents'>;
  identity: string;
  plan: string;
  // Identity-anchor fields (ClaudeTown). Optional + backward compatible: older
  // worlds and personas without them still load. These compose the always-
  // available persona anchor that fights long-horizon drift.
  values?: string;
  relationships?: string;
  longTermGoal?: string;

  constructor(serialized: SerializedAgentDescription) {
    const { agentId, identity, plan, values, relationships, longTermGoal } = serialized;
    this.agentId = parseGameId('agents', agentId);
    this.identity = identity;
    this.plan = plan;
    this.values = values;
    this.relationships = relationships;
    this.longTermGoal = longTermGoal;
  }

  serialize(): SerializedAgentDescription {
    const { agentId, identity, plan, values, relationships, longTermGoal } = this;
    return { agentId, identity, plan, values, relationships, longTermGoal };
  }
}

export const serializedAgentDescription = {
  agentId,
  identity: v.string(),
  plan: v.string(),
  values: v.optional(v.string()),
  relationships: v.optional(v.string()),
  longTermGoal: v.optional(v.string()),
};
export type SerializedAgentDescription = ObjectType<typeof serializedAgentDescription>;
