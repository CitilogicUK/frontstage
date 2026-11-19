import {
  approvedCodingToolsInput,
  approvedConnectorsInput,
  connectorPolicyCheck,
} from './approvedConnectors';

const connector = {
  id: 'approved-provider',
  name: 'Approved provider',
  kind: 'data',
  description: 'Writes reviewed data to the managed workspace.',
  access: 'write',
  maxClassification: 'confidential',
  docsUrl: 'https://docs.example.com/connector?tab=setup#access',
};

describe('approved connector configuration', () => {
  it('accepts display metadata and makes documentation optional', () => {
    expect(approvedConnectorsInput.parse([connector])).toEqual([connector]);
    expect(
      approvedConnectorsInput.safeParse([{ ...connector, docsUrl: undefined }])
        .success,
    ).toBe(true);
  });

  it('rejects duplicate IDs even when other fields differ', () => {
    expect(() =>
      approvedConnectorsInput.parse([
        connector,
        { ...connector, id: ` ${connector.id} `, name: 'Different name' },
      ]),
    ).toThrow('Connector IDs must be unique.');
  });

  it.each([
    { docsUrl: 'http://docs.example.com' },
    { docsUrl: 'https://user:pass@docs.example.com' },
    { docsUrl: 'https://user@docs.example.com' },
    { docsUrl: 'https:docs.example.com' },
    { kind: 'tool' },
    { access: 'admin' },
    { maxClassification: 'top-secret' },
    { description: ' ' },
    { token: 'private' },
  ])('rejects values outside the metadata contract (%#)', fields => {
    expect(
      approvedConnectorsInput.safeParse([{ ...connector, ...fields }]).success,
    ).toBe(false);
  });
});

describe('approved coding tool configuration', () => {
  const tool = {
    id: 'sandbox-assistant',
    name: 'Sandbox assistant',
    description: 'Help write code in a managed workspace.',
    maxClassification: 'internal',
  };

  it('accepts display metadata and rejects duplicate normalized IDs', () => {
    expect(approvedCodingToolsInput.parse([tool])).toEqual([tool]);
    expect(() =>
      approvedCodingToolsInput.parse([
        tool,
        { ...tool, id: ` ${tool.id} `, name: 'Different name' },
      ]),
    ).toThrow('Coding tool IDs must be unique.');
  });

  it.each([
    { docsUrl: 'http://docs.example.com' },
    { docsUrl: 'https://user:pass@docs.example.com' },
    { access: 'read' },
    { maxClassification: 'top-secret' },
    { description: ' ' },
    { token: 'private' },
  ])('rejects values outside the coding tool contract (%#)', fields => {
    expect(
      approvedCodingToolsInput.safeParse([{ ...tool, ...fields }]).success,
    ).toBe(false);
  });
});

describe('declared connections scorecard', () => {
  const app = {
    classification: 'internal',
    connections: [{ name: ' APPROVED provider ', access: 'write' }],
    lifecycle: 'active',
  } as const;
  const declaredApp = { ...app, connections: [...app.connections] };
  const allLimits = approvedConnectorsInput.parse([
    { ...connector, maxClassification: 'internal' },
    { ...connector, id: 'different-access', access: 'read' },
  ]);

  it('requires one same-name entry with both access and effective classification', () => {
    expect(connectorPolicyCheck(declaredApp, allLimits)?.status).toBe(true);
    expect(
      connectorPolicyCheck(
        {
          ...declaredApp,
          hosted: {
            provider: 'Synthetic provider',
            workspace: 'Enterprise',
            sharing: 'private',
            dataAccess: 'reads connected data',
            dataClassification: 'confidential',
          },
        },
        allLimits,
      ),
    ).toMatchObject({
      status: false,
      detail: expect.stringContaining(
        'Connections outside registry limits: 1.',
      ),
    });
  });

  it('distinguishes an empty registry from an unconfigured one', () => {
    expect(connectorPolicyCheck(declaredApp, undefined)).toBeUndefined();
    expect(
      connectorPolicyCheck({ ...declaredApp, connections: [] }, []),
    ).toBeUndefined();
    expect(
      connectorPolicyCheck({ ...declaredApp, lifecycle: 'retired' }, []),
    ).toBeUndefined();
    expect(connectorPolicyCheck(declaredApp, [])).toMatchObject({
      status: false,
      detail: expect.stringContaining('Unlisted connections: 1.'),
    });
  });
});
