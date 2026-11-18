import { InputError } from '@backstage/errors';
import { parse } from 'csv-parse/sync';

const textFields = [
  'name',
  'purpose',
  'type',
  'platform',
  'sourceUrl',
  'owner',
  'backupOwner',
  'team',
  'lifecycle',
  'deliveryStage',
  'audience',
  'classification',
  'actionDescription',
];
const booleanFields = [
  'takesActions',
  'usesAiAtRuntime',
  'affectsPeople',
  'critical',
  'personalData',
];
const hostedFields = [
  'provider',
  'workspace',
  'sharing',
  'dataAccess',
  'dataClassification',
];
const allowedFields = new Set([
  ...textFields,
  ...booleanFields,
  ...hostedFields.map(field => `hosted.${field}`),
  'models',
  'connections',
]);

export function parseAppCsv(content: string) {
  // Excel may add a separator declaration before the actual column headers.
  const declaration = /^\uFEFF?sep=([,;])(?:\r\n|\n|\r)/i.exec(content);
  const csv = declaration ? content.slice(declaration[0].length) : content;
  const header = csv.split(/\r\n|\n|\r/).find(line => line.trim());
  // Column names never contain separators. Only inspect the header so commas
  // and semicolons in spreadsheet cells remain ordinary data.
  const delimiter = declaration?.[1] ?? header?.match(/[,;]/)?.[0] ?? ',';

  let rows: Array<Record<string, string>>;
  try {
    rows = parse(csv, {
      bom: true,
      delimiter,
      trim: true,
      skip_empty_lines: true,
      max_record_size: 16_384,
      columns(headers: string[]) {
        const seen = new Set<string>();
        for (const header of headers) {
          if (!allowedFields.has(header) || seen.has(header)) {
            throw new InputError(
              `Unknown or duplicate CSV column "${header}".`,
            );
          }
          seen.add(header);
        }
        return headers;
      },
    });
  } catch (error) {
    if (error instanceof InputError) throw error;
    const dataLine = (error as { lines?: number }).lines;
    const line =
      dataLine === undefined
        ? undefined
        : dataLine + Number(Boolean(declaration));
    throw new InputError(
      line ? `Invalid CSV ending at line ${line}.` : 'Invalid CSV.',
    );
  }
  if (rows.length < 1 || rows.length > 100) {
    throw new InputError('Supply between 1 and 100 apps.');
  }

  return rows.map((record, index) => {
    const read = (field: string) => record[field]?.trim() || undefined;
    const source = `CSV app ${index + 1}`;
    const app: Record<string, unknown> = {};
    const hosted: Record<string, string> = {};
    for (const field of textFields) {
      const value = read(field);
      if (value !== undefined) app[field] = value;
    }
    for (const field of booleanFields) {
      const value = read(field)?.toLowerCase();
      if (value === undefined) continue;
      if (value === 'true' || value === 'yes') app[field] = true;
      else if (value === 'false' || value === 'no') app[field] = false;
      else throw new InputError(`${source}: use Yes or No for ${field}.`);
    }
    for (const field of hostedFields) {
      const value = read(`hosted.${field}`);
      if (value !== undefined) hosted[field] = value;
    }
    if (Object.keys(hosted).length) app.hosted = hosted;
    const models = read('models');
    app.models = models ? models.split('|').map(model => model.trim()) : [];
    const connections = read('connections');
    if (connections !== undefined) {
      try {
        app.connections = JSON.parse(connections);
      } catch {
        throw new InputError(`${source}: connections must be a JSON array.`);
      }
    }
    return { app, source };
  });
}
