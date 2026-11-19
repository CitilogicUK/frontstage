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

it('reads PEP 621 project and optional dependencies with TOML syntax', () => {
  const manifest = `
[project]
name = 'example-tools'
dependencies = [
  'openai[realtime]>=1; python_version >= "3.11"',
  'google_genai>=0.7',
  'openai-wrapper',
]

[project.optional-dependencies]
examples = ['anthropic @ https://example.com/package.whl', 'OPENAI']
'extra.tests' = ['GOOGLE.GENAI', 'langchain-openai>=0.2']

[build-system]
requires = ['litellm']

[dependency-groups]
dev = ['langchain']
`;
  expect(sdkPackages('pyproject.toml', manifest)).toEqual([
    'anthropic',
    'google-genai',
    'langchain-openai',
    'openai',
  ]);
  expect(
    sdkPackages('pyproject.toml', '[project]\ndependencies = ['),
  ).toBeUndefined();
  expect(
    sdkPackages('pyproject.toml', "[project]\ndependencies = 'openai'"),
  ).toBeUndefined();
  expect(
    sdkPackages(
      'pyproject.toml',
      "[project.optional-dependencies]\ndev = 'openai'",
    ),
  ).toBeUndefined();
});

it('reads exact Poetry dependencies across main, legacy dev, and named groups', () => {
  const manifest = `
[project]
dependencies = ['openai>=1']

[tool.poetry]
name = 'langchain'
description = 'An example mentioning azure-ai-inference'

[tool.poetry.dependencies]
python = '^3.11'
OPENAI = [{version = '^1', python = '<3.12'}, {version = '^2', python = '>=3.12'}]
'google_genai' = {version = '^1', extras = ['example']}
'openai-wrapper' = '^1'

[tool.poetry.dev-dependencies]
'LangChain.OpenAI' = '^0.2'
'GOOGLE-GENAI' = '^1'

[tool.poetry.group.evaluation]
optional = true

[tool.poetry.group.evaluation.dependencies]
Anthropic = {version = '^0.50', optional = true}
llama-index = '^0.12'
anthropic-tools = '^1'

[tool.poetry.group.test.dependencies]
'LLAMA_INDEX' = '^0.12'
`;
  expect(sdkPackages('pyproject.toml', manifest)).toEqual([
    'anthropic',
    'google-genai',
    'langchain-openai',
    'llama-index',
    'openai',
  ]);
});

it('ignores Poetry metadata, build requirements, and PEP 735 dependency groups', () => {
  const manifest = `
[tool.poetry]
name = 'openai'
description = 'Uses anthropic and langchain'

[tool.poetry.scripts]
litellm = 'example:main'

[tool.poetry.extras]
examples = ['google-genai']

[tool.poetry.group.documentation]
description = 'Mentions llama-index'

[build-system]
requires = ['langchain-openai']

[dependency-groups]
dev = ['azure-ai-inference']
`;
  expect(sdkPackages('pyproject.toml', manifest)).toEqual([]);
});

it.each([
  "[tool.poetry]\ndependencies = ['openai']",
  "[tool.poetry]\ndev-dependencies = 'openai'",
  "[tool.poetry.group.test]\ndependencies = ['openai']",
])('treats malformed Poetry dependency tables as unavailable', manifest => {
  expect(sdkPackages('pyproject.toml', manifest)).toBeUndefined();
});
