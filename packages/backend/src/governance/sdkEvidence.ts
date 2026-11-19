import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

export const sdkManifestPaths = [
  'package.json',
  'requirements.txt',
  'pyproject.toml',
] as const;
export type SdkManifestPath = (typeof sdkManifestPaths)[number];

const npmSdkNames = new Set([
  '@ai-sdk/anthropic',
  '@ai-sdk/google',
  '@ai-sdk/openai',
  '@anthropic-ai/sdk',
  '@azure/openai',
  '@google/genai',
  '@google/generative-ai',
  '@langchain/core',
  '@langchain/openai',
  'ai',
  'langchain',
  'openai',
]);

const pythonSdkNames = new Set([
  'anthropic',
  'azure-ai-inference',
  'google-genai',
  'google-generativeai',
  'langchain',
  'langchain-anthropic',
  'langchain-openai',
  'litellm',
  'llama-index',
  'openai',
]);

const dependencyMap = z.record(z.string(), z.string()).optional();
const packageManifest = z.object({
  dependencies: dependencyMap,
  devDependencies: dependencyMap,
  optionalDependencies: dependencyMap,
  peerDependencies: dependencyMap,
});

const poetryDependencyTable = z.record(z.string(), z.unknown());
const poetryDependencies = z
  .record(
    z.string(),
    z.union([
      z.string(),
      poetryDependencyTable,
      z.array(poetryDependencyTable),
    ]),
  )
  .optional();

const pyprojectManifest = z.object({
  project: z
    .object({
      dependencies: z.array(z.string()).optional(),
      'optional-dependencies': z
        .record(z.string(), z.array(z.string()))
        .optional(),
    })
    .optional(),
  'dependency-groups': z
    .record(
      z.string(),
      z.array(
        z.union([z.string(), z.strictObject({ 'include-group': z.string() })]),
      ),
    )
    .optional(),
  tool: z
    .object({
      poetry: z
        .object({
          dependencies: poetryDependencies,
          'dev-dependencies': poetryDependencies,
          group: z
            .record(z.string(), z.object({ dependencies: poetryDependencies }))
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

function pythonRequirementNames(requirements: string[]) {
  return requirements.flatMap(requirement => {
    const match =
      /^([a-z0-9][a-z0-9._-]*)(?:\[[a-z0-9.,_ -]+\])?\s*(?:[<>=!~;@#]|$)/i.exec(
        requirement.trim(),
      );
    return match ? [match[1]] : [];
  });
}

function pythonSdkPackages(names: string[]) {
  return [
    ...new Set(
      names
        .map(name => name.toLowerCase().replace(/[-_.]+/g, '-'))
        .filter(name => pythonSdkNames.has(name)),
    ),
  ].sort();
}

export function sdkPackages(
  path: SdkManifestPath,
  content: string,
): string[] | undefined {
  if (path === 'package.json') {
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      return undefined;
    }
    const manifest = packageManifest.safeParse(value);
    if (!manifest.success) return undefined;
    return [
      ...new Set(
        Object.values(manifest.data).flatMap(map =>
          Object.keys(map ?? {}).filter(name => npmSdkNames.has(name)),
        ),
      ),
    ].sort();
  }

  if (path === 'requirements.txt')
    return pythonSdkPackages(
      pythonRequirementNames(content.split(/\r\n|\r|\n/)),
    );

  let value: unknown;
  try {
    value = parseToml(content);
  } catch {
    return undefined;
  }
  const manifest = pyprojectManifest.safeParse(value);
  if (!manifest.success) return undefined;
  const { project, tool } = manifest.data;
  const poetry = tool?.poetry;
  return pythonSdkPackages([
    ...pythonRequirementNames([
      ...(project?.dependencies ?? []),
      ...Object.values(project?.['optional-dependencies'] ?? {}).flat(),
      // Every local group is scanned, so include-group entries need no traversal.
      ...Object.values(manifest.data['dependency-groups'] ?? {})
        .flat()
        .filter(entry => typeof entry === 'string'),
    ]),
    ...Object.keys(poetry?.dependencies ?? {}),
    ...Object.keys(poetry?.['dev-dependencies'] ?? {}),
    ...Object.values(poetry?.group ?? {}).flatMap(group =>
      Object.keys(group.dependencies ?? {}),
    ),
  ]);
}
