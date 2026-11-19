import { sdkPackages } from './sdkEvidence';

it('matches exact npm dependency names across the manifest maps', () => {
  expect(
    sdkPackages(
      'package.json',
      JSON.stringify({
        dependencies: {
          openai: '^4',
          'openai-wrapper': '^1',
          '@anthropic-ai/sdk': 'workspace:*',
        },
        devDependencies: { openai: '^4', '@google/genai': '^1' },
        peerDependencies: { ai: '>=4' },
        optionalDependencies: { '@azure/openai': '^2' },
        scripts: { example: 'mentions langchain' },
      }),
    ),
  ).toEqual([
    '@anthropic-ai/sdk',
    '@azure/openai',
    '@google/genai',
    'ai',
    'openai',
  ]);
  expect(sdkPackages('package.json', '{"dependencies":[] }')).toBeUndefined();
  expect(sdkPackages('package.json', 'not JSON')).toBeUndefined();
  expect(sdkPackages('package.json', '{}')).toEqual([]);
});

it('only extracts named Python requirements and handles duplicate spellings', () => {
  expect(
    sdkPackages(
      'requirements.txt',
      [
        '# litellm',
        '-r langchain.txt',
        'OpEnAi[realtime]>=1.0; python_version >= "3.11"',
        'openai==1.2.3',
        'google_genai>=0.7',
        'GOOGLE.GENAI',
        'anthropic @ https://example.com/package.whl',
        'openai-wrapper',
        'langchain usage appears in a comment',
      ].join('\r\n'),
    ),
  ).toEqual(['anthropic', 'google-genai', 'openai']);
  expect(sdkPackages('requirements.txt', '')).toEqual([]);
});
