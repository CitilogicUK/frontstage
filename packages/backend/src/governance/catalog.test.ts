import {
  ANNOTATION_LOCATION,
  ANNOTATION_ORIGIN_LOCATION,
} from '@backstage/catalog-model';
import { governanceCatalogEntity } from './catalog';
import type { GovernanceRecord } from './plugin';
import { appInput } from './policy';

const hosted = {
  provider: 'Example AI',
  workspace: 'Company',
  sharing: 'private' as const,
  dataAccess: 'none' as const,
};
const hostedAttestation = {
  at: '2026-04-01T00:00:00.000Z',
  nextDue: '2026-06-30T00:00:00.000Z',
};

const app: GovernanceRecord = {
  ...appInput.parse({
    name: 'Support assistant',
    purpose: 'Answer staff support questions.',
    type: 'provider-hosted app',
    platform: 'Hosted workspace & tools',
    sourceUrl: 'https://example.com/support-assistant',
    owner: 'user:default/owner',
    backupOwner: 'user:default/backup',
    team: 'group:default/support',
    lifecycle: 'active',
    audience: 'personal',
    classification: 'internal',
    models: ['test-model'],
    connections: [{ name: 'Help center', access: 'read' }],
    hosted,
  }),
  id: 'support-assistant',
  tier: 2,
  effectiveClassification: 'internal',
  reviewStatus: 'not required',
  lastReview: '2026-04-01T00:00:00.000Z',
  nextReview: '2027-04-01T00:00:00.000Z',
  discoverySource: 'registered',
  updatedAt: '2026-04-01T00:00:00.000Z',
  hostedAttestation,
};

describe('governance catalog projection', () => {
  it('publishes existing ownership, tier, lifecycle and source metadata', () => {
    expect(governanceCatalogEntity(app)).toMatchObject({
      apiVersion: 'governance.backstage.io/v1alpha1',
      kind: 'AIApp',
      metadata: {
        name: app.id,
        title: app.name,
        description: app.purpose,
        annotations: {
          [ANNOTATION_LOCATION]: 'governance:inventory',
          [ANNOTATION_ORIGIN_LOCATION]: 'governance:inventory',
        },
        links: [{ url: app.sourceUrl, title: 'Source' }],
      },
      spec: {
        owner: app.owner,
        backupOwner: app.backupOwner,
        team: app.team,
        lifecycle: app.lifecycle,
        tier: app.tier,
        sourceUrl: app.sourceUrl,
        discoverySource: app.discoverySource,
        hostedAttestation: app.hostedAttestation,
      },
    });
  });

  it('omits private and unrecognized values, including inside known objects', () => {
    const secret = 'private fixture value';
    const record = {
      ...app,
      hostedReconfirmationAt: '2026-04-02T00:00:00.000Z',
      reviewNotes: secret,
      reviewTicketUrl: 'https://example.com/reviewer-ticket',
      evidence: { tests: 'https://example.com/private-evidence' },
      privateFutureField: secret,
      hosted: { ...hosted, privateFutureField: secret },
      connections: [{ ...app.connections[0], privateFutureField: secret }],
      hostedAttestation: {
        ...hostedAttestation,
        privateFutureField: secret,
      },
    };

    const { spec } = governanceCatalogEntity(record);
    for (const field of [
      'hostedReconfirmationAt',
      'reviewNotes',
      'reviewTicketUrl',
      'evidence',
      'privateFutureField',
    ]) {
      expect(spec).not.toHaveProperty(field);
    }
    expect(spec?.hosted).toEqual(app.hosted);
    expect(spec?.connections).toEqual(app.connections);
    expect(spec?.hostedAttestation).toEqual(app.hostedAttestation);
  });
});
