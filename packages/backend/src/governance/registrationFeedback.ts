import { createHash, randomBytes } from 'node:crypto';
import { ConflictError, NotFoundError } from '@backstage/errors';
import type { Knex } from 'knex';
import { z } from 'zod';

const feedbackTable = 'governance_registration_feedback';
const days = 30;
const dayMs = 86_400_000;
const expiredRowsPerRegistration = 100;

export const registrationFeedbackInput = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    rating: z.literal([1, 2, 3]),
  })
  .strict();

export function registrationFeedbackMigration() {
  return {
    async up(db: Knex) {
      await db.schema.createTable(feedbackTable, table => {
        table.string('token_digest', 64).primary();
        table.string('utc_day', 10).notNullable().index();
        table.integer('rating').nullable();
      });
    },
    async down(db: Knex) {
      await db.schema.dropTable(feedbackTable);
    },
  };
}

function digest(token: string, actor: string) {
  return createHash('sha256')
    .update(JSON.stringify([token, actor]))
    .digest('hex');
}

function utcDay(at: number) {
  return new Date(at).toISOString().slice(0, 10);
}

function utcWindow(): [string, string] {
  const now = Date.now();
  return [utcDay(now - (days - 1) * dayMs), utcDay(now)];
}

export async function issueRegistrationFeedbackToken(db: Knex, actor: string) {
  const token = randomBytes(32).toString('base64url');
  const [oldestDay, today] = utcWindow();
  await db.transaction(async transaction => {
    // Expired rows cannot be submitted or counted. Prune a bounded number on a new registration.
    const expired = transaction(feedbackTable)
      .where('utc_day', '<', oldestDay)
      .orderBy('utc_day')
      .limit(expiredRowsPerRegistration)
      .select('token_digest');
    await transaction(feedbackTable).whereIn('token_digest', expired).del();
    await transaction(feedbackTable).insert({
      token_digest: digest(token, actor),
      utc_day: today,
    });
  });
  return token;
}

export async function recordRegistrationFeedback(
  db: Knex,
  actor: string,
  { token, rating }: z.infer<typeof registrationFeedbackInput>,
) {
  const request = db(feedbackTable)
    .where({ token_digest: digest(token, actor) })
    .whereBetween('utc_day', utcWindow());
  const updated = await request.clone().whereNull('rating').update({ rating });
  if (updated) return;
  const previous = await request.first<{ rating: number | null }>('rating');
  if (!previous)
    throw new NotFoundError('Registration feedback is unavailable.');
  if (previous.rating !== rating)
    throw new ConflictError('Registration feedback has already been recorded.');
}

export async function registrationFeedbackReport(db: Knex, enabled: boolean) {
  if (!enabled)
    return {
      enabled,
      days,
      eligibleCount: 0,
      responseCount: 0,
      satisfiedCount: 0,
    };
  const stats = await db(feedbackTable)
    .whereBetween('utc_day', utcWindow())
    .count({ eligibleCount: '*', responseCount: 'rating' })
    .select(
      db.raw('sum(case when rating = ? then 1 else 0 end) as ??', [
        3,
        'satisfiedCount',
      ]),
    )
    .first<{
      eligibleCount: number | string;
      responseCount: number | string;
      satisfiedCount: number | string | null;
    }>();
  return {
    enabled,
    days,
    eligibleCount: Number(stats?.eligibleCount ?? 0),
    responseCount: Number(stats?.responseCount ?? 0),
    satisfiedCount: Number(stats?.satisfiedCount ?? 0),
  };
}
