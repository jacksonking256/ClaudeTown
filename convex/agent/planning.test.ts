import {
  hhmmToMinutes,
  minutesToHHMM,
  planIdForDate,
  currentBlock,
  parseSchedule,
  clampMinute,
  PlanBlock,
} from './planning';

describe('time math', () => {
  test('hhmmToMinutes parses valid times', () => {
    expect(hhmmToMinutes('00:00')).toBe(0);
    expect(hhmmToMinutes('08:30')).toBe(510);
    expect(hhmmToMinutes('23:59')).toBe(1439);
    expect(hhmmToMinutes(' 9:05 ')).toBe(545);
  });
  test('hhmmToMinutes rejects garbage', () => {
    expect(hhmmToMinutes('nope')).toBeNull();
    expect(hhmmToMinutes('25:00')).toBeNull();
    expect(hhmmToMinutes('10:99')).toBeNull();
  });
  test('minutesToHHMM round-trips', () => {
    expect(minutesToHHMM(510)).toBe('08:30');
    expect(minutesToHHMM(0)).toBe('00:00');
  });
  test('clampMinute bounds to a day', () => {
    expect(clampMinute(-5)).toBe(0);
    expect(clampMinute(99999)).toBe(1440);
  });
  test('planIdForDate is a stable local date key', () => {
    expect(planIdForDate(new Date(2026, 5, 15))).toBe('2026-06-15');
    expect(planIdForDate(new Date(2026, 0, 3))).toBe('2026-01-03');
  });
});

describe('currentBlock', () => {
  const blocks: PlanBlock[] = [
    { startMinute: 0, endMinute: 480, description: 'sleep' },
    { startMinute: 480, endMinute: 540, description: 'breakfast' },
    { startMinute: 600, endMinute: 720, description: 'work' },
  ];
  test('returns the block covering now', () => {
    expect(currentBlock(blocks, 500)?.description).toBe('breakfast');
    expect(currentBlock(blocks, 0)?.description).toBe('sleep');
  });
  test('in a gap, returns the next upcoming block', () => {
    expect(currentBlock(blocks, 560)?.description).toBe('work');
  });
  test('after the last block, returns the last block', () => {
    expect(currentBlock(blocks, 1000)?.description).toBe('work');
  });
  test('empty schedule -> null', () => {
    expect(currentBlock([], 100)).toBeNull();
  });
});

describe('parseSchedule', () => {
  test('parses a well-formed schedule', () => {
    const blocks = parseSchedule([
      { start: '08:00', end: '09:00', activity: 'jog', emoji: '🏃' },
      { start: '09:00', end: '10:00', activity: 'write' },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ startMinute: 480, endMinute: 540, description: 'jog', emoji: '🏃' });
  });
  test('accepts description as an alias for activity', () => {
    const blocks = parseSchedule([{ start: '07:00', end: '07:30', description: 'wake up' }]);
    expect(blocks[0].description).toBe('wake up');
  });
  test('repairs missing/invalid end times to +60m', () => {
    const blocks = parseSchedule([{ start: '12:00', activity: 'lunch' }]);
    expect(blocks[0]).toMatchObject({ startMinute: 720, endMinute: 780 });
  });
  test('drops entries with no start or no activity, and sorts', () => {
    const blocks = parseSchedule([
      { end: '10:00', activity: 'no-start' },
      { start: '09:00', activity: '' },
      { start: '14:00', activity: 'afternoon' },
      { start: '06:00', activity: 'dawn' },
    ]);
    expect(blocks.map((b) => b.description)).toEqual(['dawn', 'afternoon']);
  });
  test('non-array input -> empty', () => {
    expect(parseSchedule('nope')).toEqual([]);
    expect(parseSchedule(null)).toEqual([]);
  });
});
