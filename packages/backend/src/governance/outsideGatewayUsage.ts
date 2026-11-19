import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseService } from '@backstage/backend-plugin-api';
import { InputError, NotFoundError } from '@backstage/errors';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { spreadsheetCsvDialect } from './csv';
import { isHttpsUrlWithoutCredentials } from './httpsUrl';
import { appSourceKey } from './sourceKey';

type Database = Awaited<ReturnType<DatabaseService['getClient']>>;
const reconciliationTable = 'governance_outside_gateway_reconciliations';

const usageInput = z
  .object({
    from: z.string().datetime(),
    to: z.string().datetime(),
    rows: z
      .array(
        z
          .object({
            sourceUrl: z
              .string()
              .max(2048)
              .refine(isHttpsUrlWithoutCredentials),
            model: z.string().trim().min(1).max(128),
            calls: z.number().int().min(1).max(1_000_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

type UsageInput = z.infer<typeof usageInput>;
type UsagePreview = Omit<UsageInput, 'rows'> & {
  rows: Array<
    UsageInput['rows'][number] & { appId?: string; appName?: string }
  >;
};
type ReconciliationRow = {
  id: string;
  digest: string;
  confirmed_at: string;
  confirmed_by: string;
  period_from: string;
  period_to: string;
  row_count: number;
  payload: string;
};

export function outsideGatewayUsageMigration() {
  return {
    async up(db: Database) {
      await db.schema.createTable(reconciliationTable, table => {
        table.string('id', 36).primary();
        table.string('digest', 64).unique().notNullable();
        table.string('confirmed_at', 24).notNullable();
        table.string('confirmed_by').notNullable();
        table.string('period_from', 24).notNullable();
        table.string('period_to', 24).notNullable();
        table.integer('row_count').notNullable();
        table.text('payload').notNullable();
        table.index(['confirmed_at', 'id']);
      });
    },
    async down(db: Database) {
      await db.schema.dropTable(reconciliationTable);
    },
  };
}

const usageCsvColumns = [
  'window_start_utc',
  'window_end_utc',
  'source_url',
  'model',
  'calls',
] as const;

export function parseOutsideGatewayUsageCsv(content: unknown) {
  const invalidCsv =
    'Supply a valid CSV with the five required usage columns, a single UTC period, and 1 to 100 usage rows.';
  if (typeof content !== 'string') throw new InputError(invalidCsv);
  const { csv, delimiter } = spreadsheetCsvDialect(content);
  let records: Array<Record<(typeof usageCsvColumns)[number], string>>;
  try {
    records = parse(csv, {
      bom: true,
      delimiter,
      trim: true,
      skip_empty_lines: true,
      max_record_size: 16_384,
      to: 101,
      columns(headers: string[]) {
        if (
          headers.length !== usageCsvColumns.length ||
          !usageCsvColumns.every(column => headers.includes(column))
        )
          throw new InputError(invalidCsv);
        return headers;
      },
    });
  } catch {
    throw new InputError(invalidCsv);
  }
  if (!records.length || records.length > 100) throw new InputError(invalidCsv);
  const from = records[0].window_start_utc.trim();
  const to = records[0].window_end_utc.trim();
  const rows = records.map(record => {
    const calls = record.calls.trim();
    if (
      record.window_start_utc.trim() !== from ||
      record.window_end_utc.trim() !== to ||
      !/^\d+$/.test(calls)
    )
      throw new InputError(invalidCsv);
    return {
      sourceUrl: record.source_url.trim(),
      model: record.model,
      calls: Number(calls),
    };
  });
  return parseOutsideGatewayUsage({ from, to, rows });
}

export function parseOutsideGatewayUsage(input: unknown) {
  const result = usageInput.safeParse(input);
  const invalidPeriodOrRows =
    'Supply a valid UTC period and 1 to 100 distinct outside gateway usage rows.';
  if (!result.success) throw new InputError(invalidPeriodOrRows);
  const { from, to, rows } = result.data;
  if (!(Date.parse(from) < Date.parse(to)))
    throw new InputError(invalidPeriodOrRows);

  const sourceKeys = rows.map(row => appSourceKey(row.sourceUrl));
  const usageKeys = rows.map((row, index) =>
    JSON.stringify([sourceKeys[index], row.model]),
  );
  if (new Set(usageKeys).size !== rows.length)
    throw new InputError(invalidPeriodOrRows);
  return { input: result.data, sourceKeys };
}

type ParsedUsage = ReturnType<typeof parseOutsideGatewayUsage>;

export async function reconcileOutsideGatewayUsage(
  db: Database,
  appsTable: string,
  { input, sourceKeys }: ParsedUsage,
): Promise<UsagePreview> {
  const matches = await db(appsTable)
    .whereIn('source_key', [...new Set(sourceKeys)])
    .select<Array<{ id: string; source_key: string; payload: string }>>(
      'id',
      'source_key',
      'payload',
    );
  const appsBySource = new Map(
    matches.map(app => {
      const { name } = JSON.parse(app.payload) as { name: string };
      return [app.source_key, { appId: app.id, appName: name }];
    }),
  );
  return {
    ...input,
    rows: input.rows.map((row, index) => ({
      ...row,
      ...appsBySource.get(sourceKeys[index]),
    })),
  };
}

function receipt(row: ReconciliationRow) {
  return {
    id: row.id,
    confirmedAt: row.confirmed_at,
    confirmedBy: row.confirmed_by,
    preview: JSON.parse(row.payload) as UsagePreview,
  };
}

export async function saveOutsideGatewayUsage(
  db: Database,
  appsTable: string,
  parsed: ParsedUsage,
  actor: string,
) {
  if (parsed.input.rows.some(row => /[?#]/.test(row.sourceUrl)))
    throw new InputError(
      'Remove query strings and fragments from source URLs before saving.',
    );

  const { rows } = parsed.input;
  const from = new Date(parsed.input.from).toISOString();
  const to = new Date(parsed.input.to).toISOString();
  const canonicalRows = rows
    .map((row, index) =>
      JSON.stringify([parsed.sourceKeys[index], row.model, row.calls]),
    )
    .sort();
  const digest = createHash('sha256')
    .update(JSON.stringify([from, to, canonicalRows]))
    .digest('hex');
  const existing = await db<ReconciliationRow>(reconciliationTable)
    .where({ digest })
    .first();
  if (existing) return { created: false, receipt: receipt(existing) };

  const preview = await reconcileOutsideGatewayUsage(db, appsTable, parsed);
  const record: ReconciliationRow = {
    id: randomUUID(),
    digest,
    confirmed_at: new Date().toISOString(),
    confirmed_by: actor,
    period_from: from,
    period_to: to,
    row_count: rows.length,
    payload: JSON.stringify({ ...preview, from, to }),
  };
  const inserted = await db<ReconciliationRow>(reconciliationTable)
    .insert(record)
    .onConflict('digest')
    .ignore()
    .returning('id');
  if (inserted.length) return { created: true, receipt: receipt(record) };

  const saved = await db<ReconciliationRow>(reconciliationTable)
    .where({ digest })
    .first();
  if (!saved) throw new Error('The saved reconciliation could not be read.');
  return { created: false, receipt: receipt(saved) };
}

export async function listOutsideGatewayUsage(db: Database, before: unknown) {
  const pageSize = 20;
  const query = db<ReconciliationRow>(reconciliationTable);
  if (before !== undefined) {
    const id = z.uuid().safeParse(before);
    const cursor = id.success
      ? await db<ReconciliationRow>(reconciliationTable)
          .where({ id: id.data })
          .first('id', 'confirmed_at')
      : undefined;
    if (!cursor) throw new InputError('Invalid reconciliation cursor.');
    query.where(older =>
      older
        .where('confirmed_at', '<', cursor.confirmed_at)
        .orWhere(tie =>
          tie
            .where('confirmed_at', cursor.confirmed_at)
            .andWhere('id', '<', cursor.id),
        ),
    );
  }
  const rows = await query
    .select(
      'id',
      'confirmed_at',
      'confirmed_by',
      'period_from',
      'period_to',
      'row_count',
    )
    .orderBy('confirmed_at', 'desc')
    .orderBy('id', 'desc')
    .limit(pageSize + 1);
  const reconciliations = rows.slice(0, pageSize).map(row => ({
    id: row.id,
    confirmedAt: row.confirmed_at,
    confirmedBy: row.confirmed_by,
    from: row.period_from,
    to: row.period_to,
    rowCount: row.row_count,
  }));
  return {
    reconciliations,
    ...(rows.length > pageSize && {
      nextCursor: reconciliations[pageSize - 1].id,
    }),
  };
}

export async function readOutsideGatewayUsage(db: Database, id: string) {
  const row = await db<ReconciliationRow>(reconciliationTable)
    .where({ id })
    .first();
  if (!row) throw new NotFoundError('Reconciliation not found.');
  return receipt(row);
}
