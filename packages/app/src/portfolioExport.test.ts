import { pendingSignoffsCsv, portfolioCsv } from './portfolioExport';

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
  const output = pendingSignoffsCsv([
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
      name: 'Plain app',
      owner: 'user:default/taylor',
      team: 'group:default/engineering',
      missingTracks: ['security'],
      nextReview: '2026-12-01T00:00:00.000Z',
    },
  ]);

  expect(output).toBe(
    [
      'app_id,app_name,owner,team,pending_sign_offs,next_review_utc',
      `"app-one","' =SUM(1,2)","user:default/dana","Team ""North""","Security | Data Protection",""`,
      '"app-two","Plain app","user:default/taylor","group:default/engineering","Security","2026-12-01T00:00:00.000Z"',
      '',
    ].join('\r\n'),
  );
});
