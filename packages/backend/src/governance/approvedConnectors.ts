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

export const approvedConnectorsInput = z
  .array(
    z
      .object({
        id: text,
        name: text,
        kind: z.enum(['mcp', 'data']),
        description: text,
        access: z.enum(['read', 'write']),
        maxClassification: classification,
        docsUrl: docsUrl.optional(),
      })
      .strict(),
  )
  .superRefine((items, ctx) => {
    const ids = new Set<string>();
    items.forEach(({ id }, index) => {
      if (ids.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: 'Connector IDs must be unique.',
        });
      }
      ids.add(id);
    });
  })
  .optional();
