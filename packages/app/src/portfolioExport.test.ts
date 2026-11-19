import {
  hostedSnapshotCsv,
  pendingSignoffsCsv,
  portfolioCsv,
  registrationFeedbackCsv,
  registrationTimingCsv,
} from './portfolioExport';

it('exports hosted observations without inferring unsupplied declarations', () => {
  const csv = hostedSnapshotCsv([
    {
      name: '=formula',
      sourceUrl: 'https://example.com/app',
      appId: 'app',
      provider: 'Example AI',
      workspace: 'Corporate',
      sharing: 'private',
      dataClassification: 'internal',
      settingDifferences: [{ field: 'dataClassification', registered: null }],
    },
    {
      name: 'Wrong type',
      sourceUrl: 'https://example.com/wrong-type',
      appId: 'wrong-type',
      provider: 'Example AI',
      workspace: 'Corporate',
      sharing: 'private',
      mismatch: 'app-type',
    },
  ]);
  expect(csv.split('\r\n').slice(1, 3)).toEqual([
    `"'=formula","https://example.com/app","app","matched","Example AI","Corporate","Example AI","Corporate","","private","","internal","private","","","dataClassification",""`,
    `"Wrong type","https://example.com/wrong-type","wrong-type","matched","Example AI","Corporate","","","app-type","private","","","","","","",""`,
  ]);
});

it('preserves values and treats formula-like names as spreadsheet text', () => {
  const output = portfolioCsv([
    {
      from: '2026-11-01T00:00:00.000Z',
      appId: 'demo-id',
      appName: ' =SUM(1,2)',
      team: 'Team "North"',
      mode: 'simulation',
      model: 'example-model',
      successfulCalls: 2,
      blockedCalls: 0,
      estimatedCostUsd: 0.012,
    },
  ]);
  expect(output).toContain(`"' =SUM(1,2)","Team ""North"""`);
  expect(output).toContain(',"example-model","",2,0,0.012,"","",""\r\n');
});

it('exports recorded token totals and their coverage', () => {
  expect(
    portfolioCsv([
      {
        from: '2026-11-01T00:00:00.000Z',
        appId: 'one',
        appName: 'App',
        team: 'Team',
        mode: 'openai',
        successfulCalls: 3,
        blockedCalls: 0,
        estimatedCostUsd: 1,
        tokens: { calls: 2, input: 10, output: 0 },
      },
    ]),
  ).toContain(',3,0,1,2,10,0\r\n');
});

it('exports pending sign-off labels with spreadsheet-safe names and a blank unknown due date', () => {
  const output = pendingSignoffsCsv(
    [
      {
        id: 'app-one',
        name: ' =SUM(1,2)',
        owner: 'user:default/dana',
        team: 'Team "North"',
        missingTracks: ['security', 'dataProtection'],
        nextReview: null,
      },
      {
        id: 'app-two',
        name: '＋Example app',
        owner: 'user:default/taylor',
        team: 'group:default/engineering',
        missingTracks: ['security'],
        nextReview: '2026-12-01T00:00:00.000Z',
        firstDecisionWait: 0,
      },
    ],
    'https://frontstage.example.com/tools/?view=reviews#queue',
  );

  expect(output).toBe(
    [
      'app_id,app_name,owner,team,pending_sign_offs,next_review_utc,app_url,first_decision_wait_weekdays',
      `"app-one","' =SUM(1,2)","user:default/dana","Team ""North""","Security | Data Protection","","https://frontstage.example.com/tools/?app=app-one",""`,
      `"app-two","'＋Example app","user:default/taylor","group:default/engineering","Security","2026-12-01T00:00:00.000Z","https://frontstage.example.com/tools/?app=app-two",0`,
      '',
    ].join('\r\n'),
  );
});

it('exports only the aggregate registration feedback window and counts', () => {
  const report = {
    days: 30,
    windowStartUtc: '2026-08-01',
    windowEndUtc: '2026-08-30',
    eligibleCount: 8,
    responseCount: 4,
    satisfiedCount: 3,
    actor: 'user:default/private',
    feedbackToken: 'private-token',
  };
  expect(registrationFeedbackCsv(report)).toBe(
    'window_start_utc,window_end_utc,window_days,eligible_count,response_count,satisfied_count\r\n"2026-08-01","2026-08-30",30,8,4,3\r\n',
  );
});

it('exports aggregate Tier 1 timings and leaves an absent median blank', () => {
  const report = {
    days: 30,
    windowStartUtc: '2026-06-01',
    windowEndUtc: '2026-06-30',
    sampleCount: 2,
    medianSeconds: 20.5,
    appId: 'private-app',
  };
  const header =
    'window_start_utc,window_end_utc,window_days,sample_count,median_seconds';
  expect(registrationTimingCsv(report)).toBe(
    `${header}\r\n"2026-06-01","2026-06-30",30,2,20.5\r\n`,
  );
  expect(
    registrationTimingCsv({ ...report, sampleCount: 0, medianSeconds: null }),
  ).toBe(`${header}\r\n"2026-06-01","2026-06-30",30,0,""\r\n`);
});
