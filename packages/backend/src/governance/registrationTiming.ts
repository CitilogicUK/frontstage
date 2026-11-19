import type { Knex } from 'knex';
import { z } from 'zod';

const timingTable = 'governance_tier_one_registration_timing';
const elapsedSeconds = z.number().int().min(0).max(86_400);
const days = 30;
const dayMs = 86_400_000;

export function registrationTimingMigration() {
  return {
    async up(db: Knex) {
      await db.schema.createTable(timingTable, table => {
        table.string('utc_day', 10).notNullable().index();
        table.integer('elapsed_seconds').notNullable();
      });
    },
    async down(db: Knex) {
      await db.schema.dropTable(timingTable);
    },
  };
}

function utcDay(at: number) {
  return new Date(at).toISOString().slice(0, 10);
}

export async function recordRegistrationTiming(db: Knex, input: unknown) {
  const sample = elapsedSeconds.safeParse(input);
  if (sample.success)
    await db.transaction(async transaction => {
      await transaction(timingTable).insert({
        utc_day: utcDay(Date.now()),
        elapsed_seconds: sample.data,
      });
    });
}

export async function registrationTimingReport(db: Knex, enabled: boolean) {
  if (!enabled) return { enabled, days, sampleCount: 0, medianSeconds: null };
  const now = Date.now();
  const ranked = db(timingTable)
    .whereBetween('utc_day', [utcDay(now - (days - 1) * dayMs), utcDay(now)])
    .select(
      'elapsed_seconds',
      db.raw('row_number() over (order by elapsed_seconds) as sample_rank'),
      db.raw('count(*) over () as sample_count'),
    )
    .as('ranked');
  const stats = await db
    .from(ranked)
    // Select the central sample for odd counts, or the two central samples for even counts.
    .whereRaw('sample_rank * 2 between sample_count and sample_count + 2')
    .max('sample_count as sampleCount')
    .avg('elapsed_seconds as medianSeconds')
    .first<{
      sampleCount: number | string | null;
      medianSeconds: number | string | null;
    }>();
  const medianSeconds = stats?.medianSeconds ?? null;
  return {
    enabled,
    days,
    sampleCount: Number(stats?.sampleCount ?? 0),
    medianSeconds: medianSeconds === null ? null : Number(medianSeconds),
  };
}
