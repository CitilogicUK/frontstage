import {
  coreServices,
  createBackendModule,
  type AuthService,
} from '@backstage/backend-plugin-api';
import { stringifyEntityRef } from '@backstage/catalog-model';
import { AuthenticationError, ConflictError } from '@backstage/errors';
import { githubAuthenticator } from '@backstage/plugin-auth-backend-module-github-provider';
import {
  authProvidersExtensionPoint,
  createOAuthProviderFactory,
  type AuthResolverContext,
} from '@backstage/plugin-auth-node';
import {
  catalogServiceRef,
  type CatalogService,
} from '@backstage/plugin-catalog-node';

const githubUserIdAnnotation = 'github.com/user-id';
const activeAnnotation = 'governance.backstage.io/active';

export function activeGithubSignInResolver(
  auth: Pick<AuthService, 'getOwnServiceCredentials'>,
  catalog: Pick<CatalogService, 'getEntities'>,
) {
  return async (
    { result }: { result: { fullProfile: { nodeId?: string } } },
    context: Pick<
      AuthResolverContext,
      'resolveOwnershipEntityRefs' | 'issueToken'
    >,
  ) => {
    const { nodeId } = result.fullProfile;
    if (!nodeId?.trim())
      throw new AuthenticationError('GitHub did not provide a stable user ID.');

    const { items } = await catalog.getEntities(
      {
        filter: {
          kind: 'user',
          [`metadata.annotations.${githubUserIdAnnotation}`]: nodeId,
        },
      },
      { credentials: await auth.getOwnServiceCredentials() },
    );
    const matches = items.filter(
      entity =>
        entity.kind.toLowerCase() === 'user' &&
        entity.metadata.annotations?.[githubUserIdAnnotation] === nodeId,
    );
    if (matches.length > 1)
      throw new ConflictError(
        'User lookup resulted in multiple exact matches.',
      );
    const [entity] = matches;
    if (!entity || entity.metadata.annotations?.[activeAnnotation] === 'false')
      throw new AuthenticationError(
        'GitHub sign-in requires a matching active Catalog user.',
      );

    const { ownershipEntityRefs } = await context.resolveOwnershipEntityRefs(
      entity,
    );
    return context.issueToken({
      claims: { sub: stringifyEntityRef(entity), ent: ownershipEntityRefs },
    });
  };
}

export const activeGithubProvider = createBackendModule({
  pluginId: 'auth',
  moduleId: 'active-github-provider',
  register(registration) {
    registration.registerInit({
      deps: {
        providers: authProvidersExtensionPoint,
        auth: coreServices.auth,
        catalog: catalogServiceRef,
      },
      async init({ providers, auth, catalog }) {
        providers.registerProvider({
          providerId: 'github',
          factory: createOAuthProviderFactory({
            authenticator: githubAuthenticator,
            signInResolver: activeGithubSignInResolver(auth, catalog),
          }),
        });
      },
    });
  },
});
