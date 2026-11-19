import { mockCredentials } from '@backstage/backend-test-utils';
import type { Entity } from '@backstage/catalog-model';
import { ConflictError, NotFoundError } from '@backstage/errors';
import { activeGithubSignInResolver } from './githubProvider';

const githubNodeId = 'U_exampleAccountNode';
const profile = { result: { fullProfile: { nodeId: githubNodeId } } };
const catalogUser: Entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'User',
  metadata: {
    namespace: 'pilot',
    name: 'engineer',
    annotations: { 'github.com/user-id': githubNodeId },
  },
};

function makeContext() {
  const credentials = mockCredentials.service();
  const auth = { getOwnServiceCredentials: jest.fn(async () => credentials) };
  const catalog = {
    getEntities: jest.fn(async () => ({ items: [catalogUser] })),
  };
  const resolver = activeGithubSignInResolver(auth, catalog);
  const context = {
    resolveOwnershipEntityRefs: jest.fn(async () => ({
      ownershipEntityRefs: ['user:pilot/engineer', 'group:pilot/platform'],
    })),
    issueToken: jest.fn(async () => ({ token: 'test-backstage-token' })),
  };
  return {
    ...context,
    getEntities: catalog.getEntities,
    credentials,
    signIn: (info = profile) => resolver(info, context),
  };
}

describe('GitHub Catalog sign-in', () => {
  it('matches the stable GitHub ID and issues standard Catalog ownership claims', async () => {
    const context = makeContext();
    await expect(context.signIn()).resolves.toEqual({
      token: 'test-backstage-token',
    });
    expect(context.getEntities).toHaveBeenCalledWith(
      {
        filter: {
          kind: 'user',
          'metadata.annotations.github.com/user-id': githubNodeId,
        },
      },
      { credentials: context.credentials },
    );
    expect(context.resolveOwnershipEntityRefs).toHaveBeenCalledWith(
      catalogUser,
    );
    expect(context.issueToken).toHaveBeenCalledWith({
      claims: {
        sub: 'user:pilot/engineer',
        ent: ['user:pilot/engineer', 'group:pilot/platform'],
      },
    });
  });

  const unsuitableEntities: Entity[] = [
    { ...catalogUser, kind: 'Group' },
    {
      ...catalogUser,
      metadata: {
        ...catalogUser.metadata,
        annotations: { 'github.com/user-id': githubNodeId.toLowerCase() },
      },
    },
    ...['false', ' FALSE '].map(active => ({
      ...catalogUser,
      metadata: {
        ...catalogUser.metadata,
        annotations: {
          ...catalogUser.metadata.annotations,
          'governance.backstage.io/active': active,
        },
      },
    })),
  ];
  it.each(unsuitableEntities)(
    'denies an unsuitable Catalog entity',
    async entity => {
      const context = makeContext();
      context.getEntities.mockResolvedValue({ items: [entity] });
      await expect(context.signIn()).rejects.toThrow(
        'GitHub sign-in requires a matching active Catalog user.',
      );
      expect(context.resolveOwnershipEntityRefs).not.toHaveBeenCalled();
      expect(context.issueToken).not.toHaveBeenCalled();
    },
  );

  it('allows one exact match alongside a case-only collision', async () => {
    const context = makeContext();
    context.getEntities.mockResolvedValue({
      items: [unsuitableEntities[1], catalogUser],
    });
    await expect(context.signIn()).resolves.toHaveProperty('token');
    expect(context.resolveOwnershipEntityRefs).toHaveBeenCalledWith(
      catalogUser,
    );
  });

  it('denies two exact matches even if one is inactive', async () => {
    const context = makeContext();
    context.getEntities.mockResolvedValue({
      items: [catalogUser, unsuitableEntities[2]],
    });
    await expect(context.signIn()).rejects.toThrow(
      'User lookup resulted in multiple exact matches.',
    );
    expect(context.issueToken).not.toHaveBeenCalled();
  });

  it('denies a profile without a stable ID without trying alternate fields', async () => {
    const context = makeContext();
    const fullProfile = { id: '42', username: 'engineer', nodeId: '' };
    await expect(context.signIn({ result: { fullProfile } })).rejects.toThrow(
      'GitHub did not provide a stable user ID.',
    );
    expect(context.getEntities).not.toHaveBeenCalled();
    expect(context.issueToken).not.toHaveBeenCalled();
  });

  it.each([
    new NotFoundError('No matching User'),
    new ConflictError('Multiple matching Users'),
    new Error('Catalog unavailable'),
  ])('fails closed when the Catalog lookup fails (%s)', async failure => {
    const context = makeContext();
    context.getEntities.mockRejectedValue(failure);
    await expect(context.signIn()).rejects.toBe(failure);
    expect(context.issueToken).not.toHaveBeenCalled();
  });
});
