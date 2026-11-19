import {
  calculateTier,
  effectiveClassification,
  evaluateTierPolicy,
  nextReview,
  sourceUrl,
  tierPolicyInput,
} from './policy';

const personal = {
  audience: 'personal',
  classification: 'internal',
  connections: [],
  takesActions: false,
  affectsPeople: false,
  critical: false,
  personalData: false,
} as const;

const base = { ...personal, connections: [] };

describe('governance policy', () => {
  it('validates existing HTTP URLs without rewriting their stored value', () => {
    const legacyUrl = 'https://example.com/legacy ';
    expect(sourceUrl.parse(legacyUrl)).toBe(legacyUrl);
    expect(sourceUrl.safeParse('ftp://example.com/file').success).toBe(false);
    expect(sourceUrl.safeParse('https://').success).toBe(false);
  });

  it('keeps personal tools with internal data in tier 1', () => {
    expect(calculateTier(base)).toBe(1);
  });

  it('treats read access and confidential data as tier 2', () => {
    expect(
      calculateTier({
        ...base,
        connections: [{ access: 'read' }],
      }),
    ).toBe(2);
    expect(calculateTier({ ...base, classification: 'confidential' })).toBe(2);
  });

  it('uses the highest applicable tier', () => {
    expect(
      calculateTier({ ...base, audience: 'team', personalData: true }),
    ).toBe(3);
    expect(
      calculateTier({
        ...base,
        connections: [{ access: 'write' }],
      }),
    ).toBe(3);
  });

  it('accounts for hosted sharing and connected data', () => {
    const hosted = {
      provider: 'Provider',
      workspace: 'Enterprise',
      dataAccess: 'reads connected data',
    } as const;
    expect(
      calculateTier({
        ...base,
        hosted: {
          ...hosted,
          sharing: 'private',
          dataClassification: 'confidential',
        },
      }),
    ).toBe(2);
    expect(
      calculateTier({
        ...base,
        hosted: {
          ...hosted,
          sharing: 'public link',
          dataClassification: 'internal',
        },
      }),
    ).toBe(3);
  });

  it('applies configured minimums without weakening built-in tiers', () => {
    const policy = tierPolicyInput.parse({
      audience: { team: 1 },
      classification: { confidential: 3 },
    });
    expect(calculateTier({ ...base, audience: 'team' }, policy)).toBe(2);
    expect(
      calculateTier({ ...base, classification: 'confidential' }, policy),
    ).toBe(3);
    expect(
      calculateTier(
        {
          ...base,
          hosted: { sharing: 'private', dataClassification: 'confidential' },
        },
        policy,
      ),
    ).toBe(3);
  });

  it('explains only rules that match the final tier', () => {
    expect(evaluateTierPolicy(base)).toEqual({ tier: 1, reasons: [] });
    expect(
      evaluateTierPolicy({
        ...base,
        audience: 'company',
        classification: 'confidential',
        hosted: { sharing: 'named people', dataClassification: 'confidential' },
        connections: [{ access: 'read' }, { access: 'read' }],
      }),
    ).toEqual({
      tier: 2,
      reasons: [
        'shared-audience',
        'shared-hosted-workspace',
        'confidential-data',
        'read-connection',
      ],
    });
    expect(
      evaluateTierPolicy({
        audience: 'external',
        classification: 'confidential',
        hosted: { sharing: 'public link', dataClassification: 'restricted' },
        connections: [{ access: 'write' }, { access: 'read' }],
        critical: true,
        affectsPeople: true,
        personalData: true,
        takesActions: true,
      }),
    ).toEqual({
      tier: 3,
      reasons: [
        'external-audience',
        'public-hosted-sharing',
        'restricted-data',
        'personal-data',
        'business-critical',
        'affects-people',
        'takes-actions',
        'write-connection',
      ],
    });
  });

  it('explains a configuration match only at the final tier', () => {
    const shared = { ...base, audience: 'team' } as const;
    expect(evaluateTierPolicy(shared, { audience: { team: 1 } })).toEqual({
      tier: 2,
      reasons: ['shared-audience'],
    });
    expect(evaluateTierPolicy(shared, { audience: { team: 2 } })).toEqual({
      tier: 2,
      reasons: ['shared-audience', 'configured-minimum'],
    });
    expect(evaluateTierPolicy(shared, { audience: { team: 3 } })).toEqual({
      tier: 3,
      reasons: ['configured-minimum'],
    });
  });

  it('retains the higher of declared and hosted data classifications', () => {
    expect(
      effectiveClassification({
        ...base,
        hosted: { sharing: 'private', dataClassification: 'confidential' },
      }),
    ).toBe('confidential');
    expect(
      effectiveClassification({
        classification: 'restricted',
        hosted: { sharing: 'private', dataClassification: 'internal' },
      }),
    ).toBe('restricted');
  });

  it('clamps review dates to the end of shorter months', () => {
    expect(nextReview(3, '2026-08-31T00:00:00.000Z')).toBe(
      '2027-02-28T00:00:00.000Z',
    );
    expect(nextReview(2, '2024-02-29T00:00:00.000Z')).toBe(
      '2025-02-28T00:00:00.000Z',
    );
    expect(nextReview(1, '2024-02-29T00:00:00.000Z')).toBeNull();
  });
});
