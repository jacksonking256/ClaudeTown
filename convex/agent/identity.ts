// Identity anchoring (ClaudeTown). A small, always-available persona summary —
// core self, values, key relationships, long-term goal — injected (or
// preferentially retrieved) on every cognition step. This fights the
// long-horizon persona drift that plagues these sims (the idea behind
// identity-retrieval approaches and Concordia's persona components).
//
// Pure helpers only — no Convex registration — so this module can be a new file
// without regenerating the API. DB-backed identity functions live in memory.ts.

export interface IdentityInput {
  name?: string;
  identity: string;
  plan?: string;
  values?: string;
  relationships?: string;
  longTermGoal?: string;
}

// Compose the compact anchor string injected into prompts.
export function buildIdentityAnchor(d: IdentityInput): string {
  const lines: string[] = [];
  if (d.name) lines.push(`Name: ${d.name}`);
  lines.push(`Core self: ${d.identity}`);
  if (d.values) lines.push(`Values: ${d.values}`);
  if (d.relationships) lines.push(`Key relationships: ${d.relationships}`);
  const goal = d.longTermGoal ?? d.plan;
  if (goal) lines.push(`Long-term goal: ${goal}`);
  return lines.join('\n');
}

// Lines to inject at the top of any cognition prompt.
export function identityPromptLines(anchor: string): string[] {
  return ['This is who you are; stay true to it in everything you do:', anchor];
}

// The prompt used by the periodic coherence check (guardrail: make drift
// measurable, not assumed).
export function restatementPrompt(name: string): string {
  return (
    `In two sentences, restate who you are at your core — your identity, your ` +
    `values, your key relationships, and your long-term goal. Speak in the ` +
    `first person as ${name}.`
  );
}

// Cosine similarity in [-1, 1]; 1 == identical direction. Drift = 1 - similarity.
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
