import { portfolioCsv } from './portfolioExport';

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
