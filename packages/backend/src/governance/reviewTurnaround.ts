const dayMs = 86_400_000;

function weekdayDays(start: number, end: number) {
  const firstDay = Math.floor(start / dayMs);
  const lastDay = Math.floor(end / dayMs);
  const wholeWeeks = Math.floor((lastDay - firstDay) / 7);
  let weekdayMs = wholeWeeks * 5 * dayMs;
  for (let day = firstDay + wholeWeeks * 7; day < lastDay; day++) {
    const weekday = new Date(day * dayMs).getUTCDay();
    if (weekday > 0 && weekday < 6) weekdayMs += dayMs;
  }
  const startWeekday = new Date(start).getUTCDay();
  const endWeekday = new Date(end).getUTCDay();
  if (startWeekday > 0 && startWeekday < 6)
    weekdayMs -= start - firstDay * dayMs;
  if (endWeekday > 0 && endWeekday < 6) weekdayMs += end - lastDay * dayMs;
  return weekdayMs / dayMs;
}

export function reviewTurnaround(
  events: Array<{ app_id: string; event: string }>,
  now = Date.now(),
) {
  const submitted = new Map<string, number>();
  const decided = new Set<string>();
  const durations = [];
  for (const row of events) {
    if (decided.has(row.app_id)) continue;
    const { action, record } = JSON.parse(row.event) as {
      action: string;
      record: {
        updatedAt: string;
        tier: number;
        reviewStatus: string;
        lifecycle?: string;
      };
    };
    const at = Date.parse(record.updatedAt);
    if (record.tier !== 3 || record.lifecycle === 'retired') {
      submitted.delete(row.app_id);
      continue;
    }
    if (!Number.isFinite(at)) continue;
    if (
      action !== 'reviewed' &&
      record.reviewStatus === 'pending' &&
      !submitted.has(row.app_id)
    ) {
      submitted.set(row.app_id, at);
    }
    const start = submitted.get(row.app_id);
    if (
      start !== undefined &&
      at >= start &&
      action === 'reviewed' &&
      ['approved', 'changes needed'].includes(record.reviewStatus)
    ) {
      durations.push(weekdayDays(start, at));
      decided.add(row.app_id);
      submitted.delete(row.app_id);
    }
  }
  durations.sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const medianWorkingDays = durations.length
    ? (durations[middle] + durations[Math.floor((durations.length - 1) / 2)]) /
      2
    : null;
  let oldestPending: { appId: string; submittedAt: number } | undefined;
  for (const [appId, submittedAt] of submitted) {
    if (!oldestPending || submittedAt < oldestPending.submittedAt)
      oldestPending = { appId, submittedAt };
  }
  return {
    decisions: durations.length,
    medianWorkingDays,
    pending: submitted.size,
    oldestPending: oldestPending
      ? {
          appId: oldestPending.appId,
          workingDays: weekdayDays(
            oldestPending.submittedAt,
            Math.max(now, oldestPending.submittedAt),
          ),
        }
      : null,
  };
}
