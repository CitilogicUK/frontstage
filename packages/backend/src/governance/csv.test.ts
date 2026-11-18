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
