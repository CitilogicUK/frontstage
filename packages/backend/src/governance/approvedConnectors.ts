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

type ConnectorPolicyApp = Pick<
  AppInput,
  'classification' | 'connections' | 'hosted' | 'lifecycle'
>;
type ConnectorRegistry = z.infer<typeof approvedConnectorsInput>;

function declaredConnectorDiscrepancies(
  app: ConnectorPolicyApp,
  registry: ConnectorRegistry,
) {
  const connections = app.connections ?? [];
  if (!registry || !connections.length || app.lifecycle === 'retired')
    return undefined;

  const dataClass = effectiveClassification(app);
  const dataRank = classification.options.indexOf(dataClass);
  const discrepancies: Array<{
    name: string;
    access: 'read' | 'write';
    reason: 'unlisted' | 'outside-limits';
  }> = [];
  for (const connection of connections) {
    const name = connection.name.trim().toLowerCase();
    const entries = registry.filter(
      entry => entry.name.trim().toLowerCase() === name,
    );
    if (!entries.length)
      discrepancies.push({
        name,
        access: connection.access,
        reason: 'unlisted',
      });
    else if (
      !entries.some(
        entry =>
          entry.access === connection.access &&
          classification.options.indexOf(entry.maxClassification) >= dataRank,
      )
    )
      discrepancies.push({
        name,
        access: connection.access,
        reason: 'outside-limits',
      });
  }
  return { dataClass, discrepancies };
}

export function connectorDiscrepancyFingerprint(
  app: ConnectorPolicyApp,
  registry: ConnectorRegistry,
) {
  const result = declaredConnectorDiscrepancies(app, registry);
  if (!result?.discrepancies.length) return undefined;
  return JSON.stringify([
    result.dataClass,
    [
      ...new Set(
        result.discrepancies.map(({ name, access, reason }) =>
          JSON.stringify([name, access, reason]),
        ),
      ),
    ].sort(),
  ]);
}

export function connectorPolicyCheck(
  app: ConnectorPolicyApp,
  registry: ConnectorRegistry,
) {
  const result = declaredConnectorDiscrepancies(app, registry);
  if (!result) return undefined;
  const unlisted = result.discrepancies.filter(
    ({ reason }) => reason === 'unlisted',
  ).length;
  const outsideLimits = result.discrepancies.length - unlisted;
  const status = unlisted === 0 && outsideLimits === 0;
  return {
    name: 'Declared connections',
    status,
    detail: status
      ? 'All declared connections match the approved connector registry limits.'
      : `Unlisted connections: ${unlisted}. Connections outside registry limits: ${outsideLimits}. Review Declared connections in app details.`,
  };
}
