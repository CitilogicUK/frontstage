import { useAnalytics } from '@backstage/frontend-plugin-api';
import { useState } from 'react';
import { configApiRef, useApi } from '@backstage/core-plugin-api';
import { Link } from 'react-router-dom';
import GetAppIcon from '@material-ui/icons/GetApp';
import { appClassifications } from './appDimensions';
import { useGatewayModelPolicy } from './GatewayModelGuide';
import {
  deliveryStages,
  parseDeliveryStage,
  projectBrief,
  stageChecks,
  type DeliveryStage,
} from './deliveryStages';

const starters = [
  {
    id: 'ai-assisted-software',
    type: 'app',
    runtime: false,
    name: 'AI-assisted software',
    sourceFiles: [],
    action: 'Download AI-assisted software starter',
    description:
      'Build any kind of software with Claude Code or another coding agent. No runtime model or gateway key required.',
  },
  {
    id: 'internal-api',
    type: 'app',
    runtime: false,
    name: 'Internal API',
    sourceFiles: ['package.json', 'server.mjs', 'server.test.mjs'],
    action: 'Download internal API starter',
    description:
      'Start with a local Node.js API, a synthetic response, and tests for its HTTP behavior.',
  },
  {
    id: 'internal-web-app',
    type: 'app',
    runtime: false,
    name: 'Internal web app',
    sourceFiles: [
      'package.json',
      'server.mjs',
      'server.test.mjs',
      'styles.css',
    ],
    action: 'Download internal web app starter',
    description:
      'Start with a browser interface, a read-only workflow using synthetic data, and HTTP tests.',
  },
  {
    id: 'data-validation',
    type: 'app',
    runtime: false,
    name: 'Data validation',
    sourceFiles: [
      'package.json',
      'validate.mjs',
      'validate.test.mjs',
      'sample.json',
    ],
    action: 'Download data validation starter',
    description:
      'Check local JSON files and return an exit code that automation can use.',
  },
  {
    id: 'gateway-assistant',
    type: 'assistant',
    runtime: true,
    name: 'Gateway assistant',
    sourceFiles: ['assistant.mjs'],
    action: 'Download assistant starter',
    description: 'Accept a question and print the model’s answer.',
  },
  {
    id: 'gateway-agent',
    type: 'agent',
    runtime: true,
    name: 'Gateway agent',
    sourceFiles: ['agent.mjs'],
    action: 'Download agent starter',
    description: 'Draft a plan and answer in two bounded gateway calls.',
  },
  {
    id: 'gateway-automation',
    type: 'automation',
    runtime: true,
    name: 'Gateway automation',
    sourceFiles: ['automation.mjs'],
    action: 'Download automation starter',
    description: 'Summarize a text file and list explicit action items.',
  },
] as const;

type Starter = (typeof starters)[number];

export const starterDefaults = {
  classification: 'internal',
  model: 'gpt-4.1-mini',
  platform: 'GitHub',
};

export function findStarter(id: string | null) {
  return starters.find(starter => starter.id === id);
}

export function AppTemplates() {
  const analytics = useAnalytics();
  const config = useApi(configApiRef);
  const [stage, setStage] = useState<DeliveryStage>('trial');
  const [downloading, setDownloading] = useState<string>();
  const [error, setError] = useState<string>();
  const { policy, failed, retry } = useGatewayModelPolicy();
  const [classification, setClassification] = useState(
    starterDefaults.classification,
  );
  const eligibleModels = policy?.enabled
    ? policy.models.filter(model =>
        model.allowedClassifications.includes(classification),
      )
    : [];
  const [preferredModel, setPreferredModel] = useState(starterDefaults.model);
  const model =
    eligibleModels.find(item => item.id === preferredModel)?.id ??
    eligibleModels[0]?.id;

  async function download(starter: Starter) {
    setDownloading(starter.id);
    setError(undefined);
    try {
      const base = new URL(config.getString('app.baseUrl'));
      base.pathname = base.pathname.replace(/\/?$/, '/');
      const sharedFiles = [
        'AGENTS.md',
        'CLAUDE.md',
        ...(starter.runtime ? ['gateway.mjs', 'gateway.test.mjs'] : []),
      ];
      const files = await Promise.all(
        [
          'README.md',
          'catalog-info.yaml',
          ...starter.sourceFiles,
          ...sharedFiles,
        ].map(async name => {
          const folder = sharedFiles.includes(name) ? 'shared' : starter.id;
          const response = await fetch(
            new URL(`starters/${folder}/${name}`, base),
          );
          if (
            !response.ok ||
            response.headers.get('Content-Type')?.startsWith('text/html')
          ) {
            throw new Error('Starter file is unavailable.');
          }
          return [
            `${starter.id}/${name}`,
            new Uint8Array(await response.arrayBuffer()),
          ] as const;
        }),
      );
      const descriptor = files.find(file =>
        file[0].endsWith('/catalog-info.yaml'),
      );
      if (!descriptor) throw new Error('Missing registration descriptor.');
      const encoder = new TextEncoder();
      const yaml = new TextDecoder().decode(descriptor[1]);
      const stageField = /^ {2}deliveryStage: trial$/m;
      if (!stageField.test(yaml)) throw new Error('Missing descriptor stage.');
      let updated = yaml
        .replace(stageField, `  deliveryStage: ${stage}`)
        .replace(
          /^ {2}classification: internal$/m,
          `  classification: ${classification}`,
        );
      if (
        classification === 'confidential' ||
        classification === 'restricted'
      ) {
        updated = updated.replace(
          /^ {2}owner: user:default\/guest$/m,
          '  owner: user:default/guest\n  backupOwner: user:default/backup',
        );
      }
      if (starter.runtime && model) {
        const backendUrl = config.getString('backend.baseUrl');
        updated = updated.replace(
          /^ {2}models: \[gpt-4\.1-mini\]$/m,
          () => `  models: [${JSON.stringify(model)}]`,
        );
        for (const [index, [path, content]] of files.entries()) {
          const source = new TextDecoder().decode(content);
          if (path.endsWith('/gateway.mjs')) {
            files[index] = [
              path,
              encoder.encode(
                source
                  .replace("'gpt-4.1-mini'", () => JSON.stringify(model))
                  .replace("'http://localhost:7007'", () =>
                    JSON.stringify(backendUrl),
                  ),
              ),
            ];
          }
          if (path.endsWith('/README.md')) {
            files[index] = [
              path,
              encoder.encode(
                source.replace(
                  'The default backend is `http://localhost:7007` and the default model is `gpt-4.1-mini`.',
                  'The default backend is the workspace that generated this starter. The default model matches the included catalog descriptor.',
                ),
              ),
            ];
          }
        }
      }
      files[files.indexOf(descriptor)] = [
        descriptor[0],
        encoder.encode(updated),
      ];
      files.push([
        `${starter.id}/PROJECT_BRIEF.md`,
        encoder.encode(
          projectBrief(
            stage,
            classification,
            starter.runtime ? model : undefined,
          ),
        ),
      ]);
      files.push([
        `${starter.id}/.gitignore`,
        encoder.encode(
          '# Local environment files\n.env\n.env.*\n!.env.example\n',
        ),
      ]);
      const { zipSync } = await import('fflate');
      const archive = zipSync(Object.fromEntries(files));
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(archive)], { type: 'application/zip' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `frontstage-${starter.id}.zip`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      analytics.captureEvent('download-starter', starter.id, {
        attributes: { deliveryStage: stage, usesAiAtRuntime: starter.runtime },
      });
    } catch {
      setError(starter.id);
    } finally {
      setDownloading(undefined);
    }
  }

  return (
    <div className="gov-template-groups">
      <label className="gov-template-stage">
        Delivery stage
        <select
          value={stage}
          disabled={!!downloading}
          onChange={event =>
            setStage(parseDeliveryStage(event.target.value) ?? 'trial')
          }
        >
          {Object.entries(deliveryStages).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <span>{stageChecks[stage]}</span>
      </label>

      <label className="gov-template-stage">
        Starter data classification
        <select
          value={classification}
          disabled={!!downloading}
          onChange={event => setClassification(event.target.value)}
        >
          {appClassifications.map(value => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      {[
        { label: 'Apps without runtime AI', runtime: false },
        { label: 'Apps with runtime AI', runtime: true },
      ].map(group => (
        <section key={group.label} aria-label={group.label}>
          <h2>{group.label}</h2>
          {group.runtime && model && (
            <label className="gov-template-stage">
              Approved model
              <select
                value={model}
                disabled={!!downloading}
                onChange={event => setPreferredModel(event.target.value)}
              >
                {eligibleModels.map(option => (
                  <option key={option.id}>{option.id}</option>
                ))}
              </select>
            </label>
          )}
          {group.runtime && failed && (
            <div>
              <p role="alert">Approved models could not load.</p>
              <button type="button" onClick={retry}>
                Retry loading approved models
              </button>
            </div>
          )}
          {group.runtime && !failed && !policy && (
            <p role="status">Loading approved models…</p>
          )}
          {group.runtime && policy && !policy.enabled && (
            <p>The gateway is disabled in this workspace.</p>
          )}
          {group.runtime && policy?.enabled && !model && (
            <p>No approved model is available for {classification} data.</p>
          )}
          <div className="gov-template-grid">
            {starters
              .filter(starter => starter.runtime === group.runtime)
              .map(starter => (
                <section
                  key={starter.id}
                  className="gov-panel gov-single"
                  aria-labelledby={`${starter.id}-title`}
                >
                  <h3 id={`${starter.id}-title`}>{starter.name}</h3>
                  <p>{starter.description}</p>
                  {error === starter.id && (
                    <p className="gov-notice" role="alert">
                      The starter could not download. Try again.
                    </p>
                  )}
                  <div className="gov-template-action">
                    <button
                      type="button"
                      className="gov-primary"
                      disabled={!!downloading || (starter.runtime && !model)}
                      onClick={() => download(starter)}
                    >
                      <GetAppIcon aria-hidden="true" />{' '}
                      {downloading === starter.id
                        ? 'Preparing download…'
                        : starter.action}
                    </button>
                    {(!starter.runtime || model) && (
                      <Link
                        className="gov-button"
                        to={`/?view=register&template=${
                          starter.id
                        }&stage=${stage}&classification=${classification}${
                          starter.runtime && model
                            ? `&model=${encodeURIComponent(model)}`
                            : ''
                        }`}
                        aria-label={`Register from ${starter.name.toLowerCase()}`}
                      >
                        Register from template
                      </Link>
                    )}
                  </div>
                </section>
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}
