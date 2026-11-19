import { createBackend } from '@backstage/backend-defaults';
import { activeGithubProvider } from './auth/githubProvider';
import { governancePlugin } from './governance/plugin';
import { governanceCatalog } from './governance/catalog';

const backend = createBackend();
backend.add(import('@backstage/plugin-app-backend'));
backend.add(import('@backstage/plugin-auth-backend'));
backend.add(import('@backstage/plugin-auth-backend-module-guest-provider'));
backend.add(activeGithubProvider);
backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(import('@backstage/plugin-signals-backend'));
backend.add(import('@backstage/plugin-notifications-backend'));
backend.add(governancePlugin);
backend.add(governanceCatalog);
backend.start();
