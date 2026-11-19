import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import ArrowForwardIcon from '@material-ui/icons/ArrowForward';
import AssessmentOutlinedIcon from '@material-ui/icons/AssessmentOutlined';
import CodeIcon from '@material-ui/icons/Code';
import AppsIcon from '@material-ui/icons/Apps';
import AddIcon from '@material-ui/icons/Add';
import AssignmentTurnedInOutlinedIcon from '@material-ui/icons/AssignmentTurnedInOutlined';
import CategoryIcon from '@material-ui/icons/Category';
import CloudUploadOutlinedIcon from '@material-ui/icons/CloudUploadOutlined';
import MenuBookOutlinedIcon from '@material-ui/icons/MenuBookOutlined';
import SearchIcon from '@material-ui/icons/Search';
import ViewListOutlinedIcon from '@material-ui/icons/ViewListOutlined';
import './governance.css';

export const workspaceViews = {
  Inventory: {
    path: '/',
    title: 'AI app inventory',
    summary: 'Find AI tools already in use and see who owns them.',
    icon: AppsIcon,
  },
  Directory: {
    path: '/?view=directory',
    title: 'App directory',
    summary: 'Find and open published apps.',
    icon: ViewListOutlinedIcon,
  },
  Catalog: {
    path: '/catalog',
    title: 'Software catalog',
    summary: 'Browse AI apps, software components, people, and teams.',
    icon: CategoryIcon,
  },
  Discovery: {
    path: '/?view=discovery',
    title: 'App discovery',
    summary: 'Review repositories and give unowned AI apps a catalog record.',
    icon: SearchIcon,
  },
  Reviews: {
    path: '/?view=reviews',
    title: 'Critical app reviews',
    summary: 'Track tier 3 apps and the decisions that govern their launch.',
    icon: AssignmentTurnedInOutlinedIcon,
  },
  Reports: {
    path: '/?view=reports',
    title: 'Portfolio reports',
    summary: 'See review exposure and gateway usage across registered apps.',
    icon: AssessmentOutlinedIcon,
  },
  Import: {
    path: '/?view=import',
    title: 'Import existing apps',
    summary:
      'Add apps from a repository descriptor or a reviewer’s inventory file.',
    icon: CloudUploadOutlinedIcon,
  },
  Templates: {
    path: '/?view=templates',
    title: 'App templates',
    summary: 'Start with a working example that uses the Frontstage gateway.',
    icon: CodeIcon,
  },
  'Builder guide': {
    path: '/?view=guide',
    title: 'Builder guide',
    summary: 'What to check before sharing an AI app.',
    icon: MenuBookOutlinedIcon,
  },
  Register: {
    path: '/?view=register',
    title: 'Register an AI app',
    summary: 'Describe your app, who owns it, and what it can access.',
    icon: AddIcon,
  },
} as const;

type WorkspaceView = keyof typeof workspaceViews;

export function WorkspaceNavigation() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const active = (Object.keys(workspaceViews) as WorkspaceView[]).find(
    label => {
      const [pathname, search] = workspaceViews[label].path.split('?');
      if (pathname === '/') {
        return (
          location.pathname === pathname &&
          params.get('view') === new URLSearchParams(search).get('view')
        );
      }
      return (
        location.pathname === pathname ||
        location.pathname.startsWith(`${pathname}/`)
      );
    },
  );

  return (
    <div className="governance gov-global-nav">
      <a className="gov-skip" href="#workspace-content">
        Skip to workspace content
      </a>
      <nav className="gov-nav" aria-label="AI governance">
        {(Object.keys(workspaceViews) as WorkspaceView[])
          .filter(label => label !== 'Register')
          .map(label => {
            const { icon: Icon, path } = workspaceViews[label];
            return (
              <Link
                key={label}
                to={path}
                aria-current={active === label ? 'page' : undefined}
              >
                <Icon aria-hidden="true" />
                {label}
              </Link>
            );
          })}
      </nav>
    </div>
  );
}

export function WorkspaceLayout({
  view,
  children,
  onNavigate,
  action,
}: {
  view: WorkspaceView;
  children: ReactNode;
  onNavigate?: () => void;
  action?: ReactNode;
}) {
  const current = workspaceViews[view];

  return (
    <main className="governance">
      <header className="gov-page-header" key={view} data-enter>
        <div>
          <h1>{current.title}</h1>
          <p>{current.summary}</p>
        </div>
        {action ??
          ((view === 'Inventory' || view === 'Catalog') && (
            <Link
              to={workspaceViews.Register.path}
              className="gov-button gov-primary"
              onClick={onNavigate}
            >
              <AddIcon aria-hidden="true" /> Register app
            </Link>
          ))}
      </header>
      <div className="gov-content">{children}</div>
    </main>
  );
}

export function WorkspaceSearch({
  label,
  placeholder,
  value,
  onChange,
  count,
  children,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  count?: number;
  children?: ReactNode;
}) {
  return (
    <div className="governance-filters">
      <label>
        <span className="gov-visually-hidden">{label}</span>
        <span className="gov-search">
          <SearchIcon aria-hidden="true" />
          <input
            type="search"
            value={value}
            placeholder={placeholder}
            onChange={event => onChange(event.target.value)}
          />
        </span>
      </label>
      {children}
      <span className="gov-result-count" aria-live="polite">
        {count !== undefined &&
          `${count} ${count === 1 ? 'result' : 'results'}`}
      </span>
    </div>
  );
}

export function WorkspaceRecordTitle({
  title,
  description,
  icon,
}: {
  title: string;
  description?: string;
  icon: ReactNode;
}) {
  return (
    <>
      <span className="gov-app-mark" aria-hidden="true">
        {icon}
      </span>
      <span>
        {title}
        {description && <small>{description}</small>}
      </span>
      <ArrowForwardIcon className="gov-row-arrow" aria-hidden="true" />
    </>
  );
}

export function WorkspaceFilterTabs({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ value: string; label: string; count?: number }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="gov-filter-tabs" role="group" aria-label={label}>
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {option.count !== undefined && <span>{option.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function WorkspaceEmptyState({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="gov-empty">
      {icon}
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {children}
    </div>
  );
}
