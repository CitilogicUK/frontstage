import { isReviewOverdue } from './reviewDue';

describe('isReviewOverdue', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  const app = {
    tier: 2,
    lifecycle: 'active',
    reviewStatus: 'not required',
    nextReview: null,
  };

  it('flags missing or invalid dates when a renewal should be scheduled', () => {
    expect(isReviewOverdue(app, now)).toBe(true);
    expect(
      isReviewOverdue({ ...app, tier: 3, reviewStatus: 'approved' }, now),
    ).toBe(true);
    expect(isReviewOverdue({ ...app, nextReview: 'invalid' }, now)).toBe(true);
  });

  it('distinguishes an initial decision and a retired app from overdue renewals', () => {
    expect(
      isReviewOverdue({ ...app, tier: 3, reviewStatus: 'pending' }, now),
    ).toBe(false);
    expect(isReviewOverdue({ ...app, lifecycle: 'retired' }, now)).toBe(false);
  });
});
