import {
  currentSignoffs,
  reviewTrackConfig,
  trackedReview,
  type Signoffs,
} from './reviewTracks';

const security = 'user:default/security';
const privacy = 'user:default/privacy';
const config = { security: [security], dataProtection: [privacy] };
const now = Date.parse('2026-11-18T00:00:00Z');
const one: Signoffs = {
  security: {
    status: 'approved',
    actor: security,
    at: '2026-10-01T00:00:00Z',
    notes: 'Reviewed',
  },
};
const both: Signoffs = {
  ...one,
  dataProtection: {
    status: 'approved',
    actor: privacy,
    at: '2026-11-01T00:00:00Z',
    notes: 'Reviewed',
  },
};

it('requires two current, assigned approvals and uses the earliest expiry', () => {
  expect(trackedReview(one, config, now).reviewStatus).toBe('pending');
  expect(trackedReview(both, config, now)).toEqual({
    reviewStatus: 'approved',
    nextReview: '2027-04-01T00:00:00.000Z',
  });
  expect(
    trackedReview(both, config, Date.parse('2027-04-01T00:00:00Z')),
  ).toEqual({
    reviewStatus: 'pending',
    nextReview: '2027-04-01T00:00:00.000Z',
  });
  expect(
    trackedReview(
      both,
      { ...config, security: ['user:default/replacement'] },
      now,
    ),
  ).toEqual({ reviewStatus: 'pending', nextReview: null });
});

it('blocks a requested change and rejects overlapping reviewer assignments', () => {
  expect(
    trackedReview(
      {
        ...one,
        dataProtection: {
          status: 'changes needed',
          actor: privacy,
          at: '2026-11-01T00:00:00Z',
          notes: 'Revise',
        },
      },
      config,
      now,
    ).reviewStatus,
  ).toBe('changes needed');
  expect(
    reviewTrackConfig.safeParse({
      security: [security],
      dataProtection: [security],
    }).success,
  ).toBe(false);
});

it('shows only current or actionable decisions without changing the recorded signoffs', () => {
  expect(currentSignoffs(both, config, now)).toEqual(both);
  expect(
    currentSignoffs(both, config, Date.parse('2027-04-01T00:00:00Z')),
  ).toEqual({
    dataProtection: both.dataProtection,
  });
  expect(
    currentSignoffs(
      both,
      { ...config, dataProtection: ['user:default/new'] },
      now,
    ),
  ).toEqual(one);
  expect(both).toHaveProperty('dataProtection.actor', privacy);
});

it('requires a new sign-off when an older approval has an invalid timestamp', () => {
  const legacy: Signoffs = {
    ...both,
    security: { ...both.security!, at: 'invalid' },
  };
  expect(currentSignoffs(legacy, config, now)).toEqual({
    dataProtection: both.dataProtection,
  });
  expect(trackedReview(legacy, config, now)).toEqual({
    reviewStatus: 'pending',
    nextReview: null,
  });
});
