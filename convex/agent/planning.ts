// Hierarchical planning with reactive replanning (Stanford §4.4), ClaudeTown.
//
// Each simulated morning an agent generates a broad daily agenda, then
// decomposes it top-down into a timed schedule of actions stored as `plan`
// memories. When a salient observation contradicts the plan, the agent may
// regenerate the plan from that point forward — cost-capped (see cognitionConfig
// planning(): replanMaxPerDay + replanMinImportance) so it can't fire an LLM
// call on nearly every observation.
//
// Pure helpers only (time math, prompts, schedule parsing). DB-registered
// functions and the LLM orchestration live in memory.ts.

export interface PlanBlock {
  startMinute: number; // minutes from local midnight
  endMinute: number;
  description: string;
  emoji?: string;
}

export function clampMinute(m: number): number {
  if (!Number.isFinite(m)) return 0;
  return Math.max(0, Math.min(24 * 60, Math.round(m)));
}

export function hhmmToMinutes(hhmm: string): number | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) return null;
  return clampMinute(h * 60 + min);
}

export function minutesToHHMM(min: number): string {
  const m = clampMinute(min);
  const h = Math.floor(m / 60) % 24;
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// Local date key used as planId, e.g. "2026-06-15".
export function planIdForDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

export function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

// The plan block covering `nowMinute` (or the next upcoming one if in a gap).
export function currentBlock(blocks: PlanBlock[], nowMinute: number): PlanBlock | null {
  const sorted = [...blocks].sort((a, b) => a.startMinute - b.startMinute);
  for (const b of sorted) {
    if (nowMinute >= b.startMinute && nowMinute < b.endMinute) return b;
  }
  // In a gap: return the next upcoming block so the agent has something to do.
  for (const b of sorted) {
    if (b.startMinute >= nowMinute) return b;
  }
  return sorted.length ? sorted[sorted.length - 1] : null;
}

// --- Prompts --------------------------------------------------------------

export function dailyAgendaPrompt(anchor: string, name: string, dateLabel: string): string {
  return [
    anchor,
    '',
    `Today is ${dateLabel}. In 3-5 short sentences, describe ${name}'s broad plan for the day`,
    `at a high level, consistent with who you are above. Write in the first person.`,
  ].join('\n');
}

export function schedulePrompt(
  anchor: string,
  name: string,
  agenda: string,
  blockMinutes: number,
): string {
  return [
    anchor,
    '',
    `${name}'s broad plan for today:`,
    agenda,
    '',
    `Break this into a concrete daily schedule of timed activities (roughly ${blockMinutes}-minute`,
    `granularity where it makes sense, coarser when idle). Cover waking hours.`,
    `Return ONLY JSON: an array of {"start":"HH:MM","end":"HH:MM","activity":"...","emoji":"X"}.`,
    `Times are 24-hour local. Keep activities short and concrete. JSON only.`,
  ].join('\n');
}

// --- Schedule parsing (compat layer ignores `strict`, so be defensive) ----

interface RawBlock {
  start?: string;
  end?: string;
  activity?: string;
  description?: string;
  emoji?: string;
}

export function parseSchedule(raw: unknown): PlanBlock[] {
  if (!Array.isArray(raw)) return [];
  const blocks: PlanBlock[] = [];
  for (const item of raw as RawBlock[]) {
    if (!item || typeof item !== 'object') continue;
    const desc = (item.activity ?? item.description ?? '').toString().trim();
    if (!desc) continue;
    const start = typeof item.start === 'string' ? hhmmToMinutes(item.start) : null;
    let end = typeof item.end === 'string' ? hhmmToMinutes(item.end) : null;
    if (start === null) continue;
    if (end === null || end <= start) end = clampMinute(start + 60);
    blocks.push({
      startMinute: start,
      endMinute: end,
      description: desc,
      emoji: typeof item.emoji === 'string' ? item.emoji.slice(0, 8) : undefined,
    });
  }
  blocks.sort((a, b) => a.startMinute - b.startMinute);
  return blocks;
}
