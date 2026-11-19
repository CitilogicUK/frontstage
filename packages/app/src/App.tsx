import { createApp } from '@backstage/frontend-defaults';
import {
  coreExtensionData,
  createFrontendPlugin,
  createRouteRef,
  PageBlueprint,
} from '@backstage/frontend-plugin-api';
import appPlugin from '@backstage/plugin-app';
import { WorkspaceNavigation } from './WorkspaceLayout';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
import notificationsPlugin from '@backstage/plugin-notifications/alpha';
import signalsPlugin from '@backstage/plugin-signals/alpha';
import CategoryIcon from '@material-ui/icons/Category';
import VerifiedUserIcon from '@material-ui/icons/VerifiedUser';

const governanceRoute = createRouteRef();

const governance = createFrontendPlugin({
  pluginId: 'governance',
  extensions: [
    PageBlueprint.make({
      params: {
        path: '/',
        title: 'AI Apps',
        icon: <VerifiedUserIcon />,
        routeRef: governanceRoute,
        noHeader: true,
        loader: () =>
          import('./GovernancePage').then(module => <module.GovernancePage />),
      },
    }),
  ],
});

const catalog = catalogPlugin.withOverrides({
  extensions: [
    PageBlueprint.make({
      params: {
        path: '/catalog',
        title: 'Catalog',
        icon: <CategoryIcon />,
        routeRef: catalogPlugin.routes.catalogIndex,
        noHeader: true,
        loader: () =>
          import('./CatalogPage').then(module => <module.CatalogPage />),
      },
    }),
  ],
});

const app = appPlugin.withOverrides({
  extensions: [
    appPlugin.getExtension('app/layout').override({
      factory: (_original, { inputs }) => [
        coreExtensionData.reactElement(
          <div className="gov-global-layout">
            <WorkspaceNavigation />
            <div
              id="workspace-content"
              className="gov-global-content"
              tabIndex={-1}
            >
              {inputs.content.get(coreExtensionData.reactElement)}
            </div>
          </div>,
        ),
      ],
    }),
  ],
});

export default createApp({
  features: [app, catalog, governance, notificationsPlugin, signalsPlugin],
});
