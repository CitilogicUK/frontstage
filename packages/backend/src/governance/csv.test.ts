import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAppCsv } from './csv';

describe('parseAppCsv', () => {
  it('reads UTF-8 spreadsheet exports with quoted fields and risk flags', () => {
    const content = [
      '\uFEFFname,purpose,models,personalData,hosted.sharing,connections',
      'Internal helper,"First line, with comma\r\nsecond line",one | two,Yes,company,"[{""name"":""CRM"",""access"":""read""}]"',
      '',
    ].join('\r\n');
    expect(parseAppCsv(content)).toEqual([
      {
        source: 'CSV app 1',
        app: {
          name: 'Internal helper',
          purpose: 'First line, with comma\r\nsecond line',
          models: ['one', 'two'],
          personalData: true,
          hosted: { sharing: 'company' },
          connections: [{ name: 'CRM', access: 'read' }],
        },
      },
    ]);
  });

  it.each(['', '\uFEFFsep=;\r\n'])(
    'reads semicolon-separated exports with separator declaration %j',
    declaration => {
      const content = `${declaration}"name";"purpose";"models";"critical"\r\nInventory;"Summarizes A, B; and C.";one | two;Yes`;

      expect(parseAppCsv(content)).toEqual([
        {
          source: 'CSV app 1',
          app: {
            name: 'Inventory',
            purpose: 'Summarizes A, B; and C.',
            models: ['one', 'two'],
            critical: true,
          },
        },
      ]);
    },
  );

  it('applies strict column validation to semicolon-separated exports', () => {
    expect(() => parseAppCsv('name;critcal\nApp;Yes')).toThrow('critcal');
  });

  it('reads both runtime modes and delivery stages from the downloadable sample', () => {
    const sample = readFileSync(
      resolve(__dirname, '../../../app/public/examples/ai-apps.csv'),
      'utf8',
    );
    expect(parseAppCsv(sample)).toMatchObject([
      {
        app: {
          usesAiAtRuntime: true,
          deliveryStage: 'trial',
          models: ['example-model'],
        },
      },
      { app: { usesAiAtRuntime: false, deliveryStage: 'poc', models: [] } },
    ]);
  });

  it('rejects misspelled and duplicate columns so risk flags cannot be skipped accidentally', () => {
    expect(() => parseAppCsv('name,critcal\nApp,Yes')).toThrow('critcal');
    expect(() => parseAppCsv('name,name\nApp,Other')).toThrow('duplicate');
  });

  it('rejects invalid booleans with the app number', () => {
    expect(() => parseAppCsv('name,critical\nApp,Maybe')).toThrow(
      'CSV app 1: use Yes or No for critical.',
    );
  });
});
