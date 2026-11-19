import { z } from 'zod';
import {
  classification,
  effectiveClassification,
  type AppInput,
} from './policy';
import { isHttpsUrlWithoutCredentials } from './httpsUrl';

const text = z.string().trim().min(1);
const docsUrl = z
  .string()
  .refine(
    isHttpsUrlWithoutCredentials,
    'Use an HTTPS documentation URL without credentials.',
  );

const registryEntry = z
  .object({
    id: text,
    name: text,
    description: text,
    maxClassification: classification,
    docsUrl: docsUrl.optional(),
  })
  .strict();

function registryInput<T extends z.ZodType<{ id: string }>>(
  entry: T,
  duplicateMessage: string,
) {
  return z
    .array(entry)
    .superRefine((items, ctx) => {
      const ids = new Set<string>();
      items.forEach(({ id }, index) => {
        if (ids.has(id)) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'id'],
            message: duplicateMessage,
          });
        }
        ids.add(id);
      });
    })
    .optional();
}

export const approvedConnectorsInput = registryInput(
  registryEntry.extend({
    kind: z.enum(['mcp', 'data']),
    access: z.enum(['read', 'write']),
  }),
  'Connector IDs must be unique.',
);

export const approvedCodingToolsInput = registryInput(
  registryEntry,
  'Coding tool IDs must be unique.',
);

export function connectorPolicyCheck(
  app: Pick<
    AppInput,
    'classification' | 'connections' | 'hosted' | 'lifecycle'
  >,
  registry: z.infer<typeof approvedConnectorsInput>,
) {
  const connections = app.connections ?? [];
  if (!registry || !connections.length || app.lifecycle === 'retired')
    return undefined;

  const dataRank = classification.options.indexOf(effectiveClassification(app));
  let unlisted = 0;
  let outsideLimits = 0;
  for (const connection of connections) {
    const name = connection.name.trim().toLowerCase();
    const entries = registry.filter(
      entry => entry.name.trim().toLowerCase() === name,
    );
    if (!entries.length) unlisted += 1;
    else if (
      !entries.some(
        entry =>
          entry.access === connection.access &&
          classification.options.indexOf(entry.maxClassification) >= dataRank,
      )
    )
      outsideLimits += 1;
  }
  const status = unlisted === 0 && outsideLimits === 0;
  return {
    name: 'Declared connections',
    status,
    detail: status
      ? 'All declared connections match the approved connector registry limits.'
      : `Unlisted connections: ${unlisted}. Connections outside registry limits: ${outsideLimits}. Review Declared connections in app details.`,
  };
}
