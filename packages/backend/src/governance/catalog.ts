import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import {
  ANNOTATION_LOCATION,
  ANNOTATION_ORIGIN_LOCATION,
  Entity,
  getCompoundEntityRef,
  parseEntityRef,
  RELATION_OWNED_BY,
  RELATION_OWNER_OF,
} from '@backstage/catalog-model';
import {
  catalogProcessingExtensionPoint,
  processingResult,
} from '@backstage/plugin-catalog-node';
import type { GovernanceRecord } from './plugin';
import { appInput } from './policy';

export const governanceCatalog = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'governance',
  register(env) {
    env.registerInit({
      deps: {
        processing: catalogProcessingExtensionPoint,
        scheduler: coreServices.scheduler,
        auth: coreServices.auth,
        discovery: coreServices.discovery,
      },
      async init({ processing, scheduler, auth, discovery }) {
        const provider = 'governance';
        processing.addProcessor({
          getProcessorName: () => 'GovernanceAIApp',
          async validateEntityKind(entity) {
            if (
              entity.kind !== 'AIApp' ||
              entity.apiVersion !== 'governance.backstage.io/v1alpha1'
            )
              return false;
            if (
              entity.metadata.annotations?.[ANNOTATION_LOCATION] !==
              'governance:inventory'
            )
              return false;
            appInput.parse(entity.spec);
            return true;
          },
          async postProcessEntity(entity, location, emit) {
            if (entity.kind !== 'AIApp' || location.type !== 'governance')
              return entity;
            const app = appInput.parse(entity.spec);
            const source = getCompoundEntityRef(entity);
            const target = parseEntityRef(app.owner);
            emit(
              processingResult.relation({
                source,
                target,
                type: RELATION_OWNED_BY,
              }),
            );
            emit(
              processingResult.relation({
                source: target,
                target: source,
                type: RELATION_OWNER_OF,
              }),
            );
            return entity;
          },
        });
        processing.addEntityProvider({
          getProviderName: () => provider,
          async connect(connection) {
            await scheduler.scheduleTask({
              id: 'governance-inventory',
              frequency: { seconds: 30 },
              timeout: { seconds: 20 },
              initialDelay: { seconds: 5 },
              async fn() {
                const { token } = await auth.getPluginRequestToken({
                  onBehalfOf: await auth.getOwnServiceCredentials(),
                  targetPluginId: 'governance',
                });
                const base = await discovery.getBaseUrl('governance');
                const response = await fetch(`${base}/apps`, {
                  headers: { Authorization: `Bearer ${token}` },
                  signal: AbortSignal.timeout(10_000),
                });
                if (!response.ok)
                  throw new Error(
                    `Governance inventory returned HTTP ${response.status}`,
                  );
                const { apps } = (await response.json()) as {
                  apps: GovernanceRecord[];
                };
                await connection.applyMutation({
                  type: 'full',
                  entities: apps.map(app => {
                    const data = appInput.parse(app);
                    const entity: Entity = {
                      apiVersion: 'governance.backstage.io/v1alpha1',
                      kind: 'AIApp',
                      metadata: {
                        name: app.id,
                        title: data.name,
                        description: data.purpose,
                        annotations: {
                          [ANNOTATION_LOCATION]: 'governance:inventory',
                          [ANNOTATION_ORIGIN_LOCATION]: 'governance:inventory',
                        },
                        links: [{ url: data.sourceUrl, title: 'Source' }],
                      },
                      spec: {
                        ...app,
                        reviewNotes: undefined,
                        renewalException: undefined,
                        retirementReview: undefined,
                        reviewTicketUrl: undefined,
                        evidence: undefined,
                        signoffs: undefined,
                      },
                    };
                    return { entity, locationKey: provider };
                  }),
                });
              },
            });
          },
        });
      },
    });
  },
});
