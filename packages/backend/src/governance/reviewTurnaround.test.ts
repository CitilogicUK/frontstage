import { reviewTurnaround } from './reviewTurnaround';

function event(
  id: string,
  updatedAt: string,
  action: string,
  reviewStatus = 'pending',
  tier = 3,
) {
  return {
    app_id: id,
    event: JSON.stringify({
      action,
      record: { tier, updatedAt, reviewStatus },
    }),
  };
}

it('measures the first complete decision per app and excludes weekends', () => {
  expect(
    reviewTurnaround(
      [
        event('a', '2026-11-20T12:00:00Z', 'registered'),
        event('a', '2026-11-23T06:00:00Z', 'reviewed'),
        event('a', '2026-11-23T12:00:00Z', 'reviewed', 'approved'),
        event('a', '2026-11-24T12:00:00Z', 'reviewed', 'changes needed'),
        event('b', '2026-11-23T00:00:00Z', 'registered'),
        event('b', '2026-11-23T12:00:00Z', 'reviewed', 'changes needed'),
        event('c', '2026-11-23T12:00:00Z', 'registered'),
        event('d', '2026-11-20T12:00:00Z', 'registered'),
      ],
      Date.parse('2026-11-24T12:00:00Z'),
    ),
  ).toEqual({
    decisions: 2,
    medianWorkingDays: 0.75,
    pending: 2,
    pendingAppIds: ['d', 'c'],
    pendingApps: [
      { appId: 'd', workingDays: 2 },
      { appId: 'c', workingDays: 1 },
    ],
    oldestPending: { appId: 'd', workingDays: 2 },
  });
});

it('omits unfinished submissions and starts again after a tier downgrade', () => {
  expect(reviewTurnaround([])).toEqual({
    decisions: 0,
    medianWorkingDays: null,
    pending: 0,
    pendingAppIds: [],
    pendingApps: [],
    oldestPending: null,
  });
  expect(
    reviewTurnaround([
      event('a', '2026-11-20T00:00:00Z', 'registered'),
      event('a', '2026-11-23T00:00:00Z', 'updated', 'not required', 2),
      event('a', '2026-11-24T00:00:00Z', 'updated'),
      event('a', '2026-11-25T00:00:00Z', 'reviewed', 'approved'),
    ]),
  ).toEqual({
    decisions: 1,
    medianWorkingDays: 1,
    pending: 0,
    pendingAppIds: [],
    pendingApps: [],
    oldestPending: null,
  });
});
