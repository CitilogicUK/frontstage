import { SignInPage } from '@backstage/core-components';
import {
  configApiRef,
  githubAuthApiRef,
  type SignInPageProps,
  useApi,
} from '@backstage/core-plugin-api';

export function WorkspaceSignIn(props: SignInPageProps) {
  const config = useApi(configApiRef);
  const provider = config.getOptionalString('app.signInProvider');
  if (provider === 'guest')
    return <SignInPage {...props} providers={['guest']} />;

  return (
    <SignInPage
      {...props}
      providers={[
        {
          id: 'github-auth-provider',
          title: 'GitHub',
          message: 'Sign in with your GitHub account',
          apiRef: githubAuthApiRef,
        },
      ]}
    />
  );
}
