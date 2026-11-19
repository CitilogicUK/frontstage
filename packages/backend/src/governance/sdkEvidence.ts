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

const dependencyMap = z.record(z.string()).optional();
const packageManifest = z.object({
  dependencies: dependencyMap,
  devDependencies: dependencyMap,
  optionalDependencies: dependencyMap,
  peerDependencies: dependencyMap,
});

const pyprojectManifest = z.object({
  project: z
    .object({
      dependencies: z.array(z.string()).optional(),
      'optional-dependencies': z.record(z.array(z.string())).optional(),
    })
    .optional(),
});

function pythonSdkPackages(requirements: string[]) {
  const packages = new Set<string>();
  for (const requirement of requirements) {
    const match =
      /^([a-z0-9][a-z0-9._-]*)(?:\[[a-z0-9.,_ -]+\])?\s*(?:[<>=!~;@#]|$)/i.exec(
        requirement.trim(),
      );
    const name = match?.[1].toLowerCase().replace(/[-_.]+/g, '-');
    if (name && pythonSdkNames.has(name)) packages.add(name);
  }
  return [...packages].sort();
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
    return pythonSdkPackages(content.split(/\r\n|\r|\n/));

  let value: unknown;
  try {
    value = parseToml(content);
  } catch {
    return undefined;
  }
  const manifest = pyprojectManifest.safeParse(value);
  if (!manifest.success) return undefined;
  const { project } = manifest.data;
  return pythonSdkPackages([
    ...(project?.dependencies ?? []),
    ...Object.values(project?.['optional-dependencies'] ?? {}).flat(),
  ]);
}
