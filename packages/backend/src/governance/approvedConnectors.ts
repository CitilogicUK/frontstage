import { z } from 'zod';
import { classification } from './policy';

const text = z.string().trim().min(1);
const docsUrl = z.string().refine(value => {
  if (
    !/^https:\/\/[^/?#@]+(?:[/?#].*)?$/i.test(value) ||
    /[\s\\]/.test(value) ||
    !URL.canParse(value)
  )
    return false;
  const { hostname, username, password } = new URL(value);
  return !!hostname && !username && !password;
}, 'Use an HTTPS documentation URL without credentials.');

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
