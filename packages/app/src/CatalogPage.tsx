import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApi } from '@backstage/core-plugin-api';
import {
  catalogApiRef,
  useEntityOwnership,
  useStarredEntities,
} from '@backstage/plugin-catalog-react';
import CategoryIcon from '@material-ui/icons/Category';
import {
  WorkspaceEmptyState,
  WorkspaceFilterTabs,
  WorkspaceLayout,
  WorkspaceRecordTitle,
  WorkspaceSearch,
} from './WorkspaceLayout';

type CatalogEntity = Parameters<
  ReturnType<typeof useEntityOwnership>['isOwnedEntity']
>[0];

function specString(entity: CatalogEntity, field: string) {
  const value = entity.spec?.[field];
  return typeof value === 'string' ? value : undefined;
}

const kindNames = new Map([
  ['aiapp', 'AI apps'],
  ['component', 'Components'],
  ['group', 'Groups'],
  ['user', 'Users'],
  ['location', 'Locations'],
]);
const kindKey = 'filters[kind]';
const scopeKey = 'filters[user]';

export function CatalogPage() {
  const catalogApi = useApi(catalogApiRef);
  const ownership = useEntityOwnership();
  const { isStarredEntity } = useStarredEntities();
  const [params, setParams] = useSearchParams();
  const kind = (params.get(kindKey) ?? 'aiapp').toLowerCase();
  const scope = params.get(scopeKey) ?? 'all';
  const [entities, setEntities] = useState<CatalogEntity[]>([]);
  const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>(
    'loading',
  );
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const limit = Math.min(
    100,
    Math.max(1, Number.parseInt(params.get('limit') ?? '', 10) || 20),
  );
  const kinds = new Set([
    ...kindNames.keys(),
    kind,
    ...entities.map(entity => entity.kind.toLowerCase()),
  ]);
  const matches = entities.filter(
    entity =>
      entity.kind.toLowerCase() === kind &&
      (scope !== 'owned' || ownership.isOwnedEntity(entity)) &&
      (scope !== 'starred' || isStarredEntity(entity)) &&
      [
        entity.metadata.name,
        entity.metadata.title,
        entity.metadata.description,
        specString(entity, 'owner'),
      ].some(value =>
        value?.toLowerCase().includes(query.trim().toLowerCase()),
      ),
  );
  const pageCount = Math.max(1, Math.ceil(matches.length / limit));
  const currentPage = Math.min(page, pageCount - 1);

  useEffect(() => {
    let active = true;
    catalogApi.getEntities().then(
      ({ items }) => {
        if (!active) return;
        setEntities(items);
        setStatus('loaded');
      },
      () => {
        if (active) setStatus('failed');
      },
    );
    return () => {
      active = false;
    };
  }, [catalogApi]);

  function chooseFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next);
    setQuery('');
    setPage(0);
  }

  return (
    <WorkspaceLayout view="Catalog">
      <section className="gov-panel" aria-label={kindNames.get(kind) ?? kind}>
        <WorkspaceSearch
          label="Search catalog"
          placeholder="Search names, descriptions, or owners…"
          value={query}
          onChange={value => {
            setQuery(value);
            setPage(0);
          }}
          count={status === 'loaded' ? matches.length : undefined}
        >
          <label>
            <span className="gov-visually-hidden">Ownership filter</span>
            <select
              value={scope}
              onChange={event => chooseFilter(scopeKey, event.target.value)}
            >
              <option value="all">All records</option>
              <option value="owned">Owned by me</option>
              <option value="starred">Starred</option>
            </select>
          </label>
        </WorkspaceSearch>
        <WorkspaceFilterTabs
          label="Catalog kinds"
          value={kind}
          onChange={value => chooseFilter(kindKey, value)}
          options={[...kinds].map(value => ({
            value,
            label: kindNames.get(value) ?? value,
          }))}
        />
        {status === 'loading' && (
          <div className="gov-empty" role="status">
            Loading catalog…
          </div>
        )}
        {status === 'failed' && (
          <div className="gov-empty" role="alert">
            The catalog could not load. Refresh the page to try again.
          </div>
        )}
        {status === 'loaded' && matches.length === 0 && (
          <WorkspaceEmptyState
            icon={<CategoryIcon aria-hidden="true" />}
            title={
              query
                ? 'No matching records'
                : `No ${(
                    kindNames.get(kind) ?? kind
                  ).toLowerCase()} in the catalog`
            }
          >
            {query && (
              <button type="button" onClick={() => setQuery('')}>
                Clear search
              </button>
            )}
            {!query && kind !== 'aiapp' && (
              <button
                type="button"
                onClick={() => chooseFilter(kindKey, 'aiapp')}
              >
                Browse AI apps
              </button>
            )}
          </WorkspaceEmptyState>
        )}
        {matches.length > 0 && (
          <div className="governance-table">
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Namespace</th>
                  <th scope="col">Owner</th>
                  <th scope="col">Lifecycle</th>
                </tr>
              </thead>
              <tbody>
                {matches
                  .slice(currentPage * limit, (currentPage + 1) * limit)
                  .map(entity => {
                    const {
                      name,
                      namespace = 'default',
                      title,
                      description,
                    } = entity.metadata;
                    const path = [namespace, kind, name]
                      .map(encodeURIComponent)
                      .join('/');
                    return (
                      <tr key={path}>
                        <td className="gov-app-cell">
                          <Link
                            className="gov-app-link"
                            to={`/catalog/${path}`}
                          >
                            <WorkspaceRecordTitle
                              title={title ?? name}
                              description={description}
                              icon={<CategoryIcon />}
                            />
                          </Link>
                        </td>
                        <td data-label="Namespace">{namespace}</td>
                        <td data-label="Owner">
                          {specString(entity, 'owner') ?? '—'}
                        </td>
                        <td data-label="Lifecycle">
                          {specString(entity, 'lifecycle') ?? '—'}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
        {pageCount > 1 && (
          <nav
            className="gov-catalog-pagination"
            aria-label="Catalog pagination"
          >
            <button
              type="button"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              Previous
            </button>
            <span>
              Page {currentPage + 1} of {pageCount}
            </span>
            <button
              type="button"
              disabled={currentPage + 1 === pageCount}
              onClick={() => setPage(currentPage + 1)}
            >
              Next
            </button>
          </nav>
        )}
      </section>
    </WorkspaceLayout>
  );
}
