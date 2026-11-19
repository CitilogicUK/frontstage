import { z } from 'zod';
import { classification } from './policy';
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
