import type { Entity } from '@backstage/catalog-model';

const activeAnnotation = 'governance.backstage.io/active';

export function isActiveCatalogEntity(entity: Entity) {
  return (
    entity.metadata.annotations?.[activeAnnotation]?.trim().toLowerCase() !==
    'false'
  );
}
