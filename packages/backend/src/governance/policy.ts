import { z } from 'zod';

const person = z.string().regex(/^user:[a-z0-9_.-]+\/[a-z0-9_.-]+$/);
export const classification = z.enum([
  'public',
  'internal',
  'confidential',
  'restricted',
]);
const requiredText = z.string().trim().min(1);
const sourceUrl = z
  .string()
  .url()
  .refine(value => /^https?:\/\//i.test(value));

const appFields = z.object({
  name: requiredText.max(100),
  purpose: requiredText.max(1000),
  reviewTicketUrl: sourceUrl
    .nullable()
    .transform(value => value ?? undefined)
    .optional(),
  evidence: z
    .object({
      tests: sourceUrl.optional(),
      dataFlow: sourceUrl.optional(),
      incidentPlan: sourceUrl.optional(),
    })
    .strict()
    .optional()
    .transform(evidence =>
      evidence && Object.values(evidence).some(Boolean) ? evidence : undefined,
    ),
  type: z.enum([
    'assistant',
    'agent',
    'automation',
    'app',
    'provider-hosted app',
    'integration',
  ]),
  platform: requiredText,
  sourceUrl,
  owner: person,
  backupOwner: person.optional(),
  team: z.string().regex(/^group:[a-z0-9_.-]+\/[a-z0-9_.-]+$/),
  lifecycle: z.enum(['experimental', 'active', 'deprecated', 'retired']),
  audience: z.enum(['personal', 'team', 'company', 'external']),
  classification,
  usesAiAtRuntime: z.boolean().default(true),
  deliveryStage: z.enum(['trial', 'poc', 'pilot', 'production']).optional(),
  models: z.array(requiredText).default([]),
  connections: z
    .array(z.object({ name: requiredText, access: z.enum(['read', 'write']) }))
    .default([]),
  takesActions: z.boolean().default(false),
  actionDescription: requiredText.optional(),
  affectsPeople: z.boolean().default(false),
  critical: z.boolean().default(false),
  personalData: z.boolean().default(false),
  hosted: z
    .object({
      provider: requiredText,
      workspace: requiredText,
      sharing: z.enum(['private', 'named people', 'company', 'public link']),
      dataAccess: z.enum([
        'none',
        'stores input',
        'reads connected data',
        'both',
      ]),
      dataClassification: classification.optional(),
    })
    .optional(),
});

export const appInput = appFields.superRefine((app, ctx) => {
  const issue = (field: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [field], message });
  if (app.usesAiAtRuntime && !app.models.length)
    issue('models', 'Declare the models the app uses at runtime.');
  if (!app.usesAiAtRuntime && app.models.length)
    issue(
      'models',
      'Remove runtime models for an app that does not use AI at runtime.',
    );
  if (!app.usesAiAtRuntime && app.type === 'provider-hosted app')
    issue('usesAiAtRuntime', 'Provider-hosted apps use AI at runtime.');
  if ((app.type === 'provider-hosted app') !== Boolean(app.hosted)) {
    issue('hosted', 'Provide workspace details for provider-hosted apps only.');
  }
  if (
    app.hosted &&
    app.hosted.dataAccess !== 'none' &&
    !app.hosted.dataClassification
  ) {
    issue(
      'hosted',
      'Provide the highest classification of the data stored or read.',
    );
  }
  if (app.takesActions && !app.actionDescription)
    issue('actionDescription', 'Describe the actions.');
  if (
    calculateTier(app) >= 2 &&
    (!app.backupOwner || app.backupOwner === app.owner)
  ) {
    issue(
      'backupOwner',
      'Choose a different backup owner for tier 2 and 3 apps.',
    );
  }
});

export type AppInput = z.infer<typeof appInput>;
export type Tier = 1 | 2 | 3;
export type ReviewStatus =
  | 'not required'
  | 'pending'
  | 'approved'
  | 'changes needed';

export const riskInput = appFields
  .pick({
    audience: true,
    classification: true,
    takesActions: true,
    affectsPeople: true,
    critical: true,
    personalData: true,
  })
  .extend({
    connections: z
      .array(z.object({ access: z.enum(['read', 'write']) }))
      .default([]),
    hosted: appFields.shape.hosted
      .unwrap()
      .pick({
        sharing: true,
        dataClassification: true,
      })
      .optional(),
  });

const minimumTier = z
  .union([z.literal(1), z.literal(2), z.literal(3)])
  .optional();
export const tierPolicyInput = z
  .object({
    audience: z
      .object({
        personal: minimumTier,
        team: minimumTier,
        company: minimumTier,
        external: minimumTier,
      })
      .strict()
      .optional(),
    classification: z
      .object({
        public: minimumTier,
        internal: minimumTier,
        confidential: minimumTier,
        restricted: minimumTier,
      })
      .strict()
      .optional(),
    hostedSharing: z
      .object({
        private: minimumTier,
        'named people': minimumTier,
        company: minimumTier,
        'public link': minimumTier,
      })
      .strict()
      .optional(),
    connection: z
      .object({ read: minimumTier, write: minimumTier })
      .strict()
      .optional(),
  })
  .strict();
type TierPolicy = z.infer<typeof tierPolicyInput>;
type RiskInput = z.infer<typeof riskInput>;

export function effectiveClassification(
  app: Pick<RiskInput, 'classification' | 'hosted'>,
) {
  const hostedClass = app.hosted?.dataClassification;
  if (
    hostedClass &&
    classification.options.indexOf(hostedClass) >
      classification.options.indexOf(app.classification)
  ) {
    return hostedClass;
  }
  return app.classification;
}

export function calculateTier(app: RiskInput, policy: TierPolicy = {}): Tier {
  const classes = [app.classification, app.hosted?.dataClassification];
  if (
    app.audience === 'external' ||
    app.hosted?.sharing === 'public link' ||
    classes.includes('restricted') ||
    app.personalData ||
    app.critical ||
    app.affectsPeople ||
    app.takesActions ||
    app.connections.some(connection => connection.access === 'write')
  )
    return 3;
  const base =
    app.audience !== 'personal' ||
    (app.hosted && app.hosted.sharing !== 'private') ||
    classes.includes('confidential') ||
    app.connections.length
      ? 2
      : 1;
  const candidates = [
    base,
    policy.audience?.[app.audience],
    policy.classification?.[app.classification],
    app.hosted?.dataClassification &&
      policy.classification?.[app.hosted.dataClassification],
    app.hosted && policy.hostedSharing?.[app.hosted.sharing],
    ...app.connections.map(
      connection => policy.connection?.[connection.access],
    ),
  ];
  if (candidates.includes(3)) return 3;
  return candidates.includes(2) ? 2 : 1;
}

export function nextReview(tier: Tier, at: string) {
  if (tier === 1) return null;
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return null;
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + (tier === 2 ? 12 : 6));
  const lastDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString();
}
