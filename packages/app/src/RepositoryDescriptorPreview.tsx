import { useState } from 'react';

export type RepositoryDescriptor = {
  starterId?: string;
  name: string;
  purpose: string;
  type: string;
  team: string;
  backupOwner?: string;
  audience: string;
  classification: string;
  usesAiAtRuntime: boolean;
  deliveryStage?: string;
  models: string[];
  connections: Array<{ name: string; access: 'read' | 'write' }>;
  takesActions: boolean;
  actionDescription?: string;
  affectsPeople: boolean;
  critical: boolean;
  personalData: boolean;
  hosted?: {
    provider: string;
    workspace: string;
    sharing: string;
    dataAccess: string;
    dataClassification?: string;
  };
};

type DescriptorResult =
  | { status: 'ready'; app: RepositoryDescriptor }
  | { status: 'unavailable' };
type Preview = DescriptorResult | { status: 'loading' | 'error' };

export function RepositoryDescriptorPreview({
  load,
  apply,
  applied,
}: {
  load: () => Promise<DescriptorResult>;
  apply: (app: RepositoryDescriptor) => void;
  applied: boolean;
}) {
  const [preview, setPreview] = useState<Preview>();

  async function loadPreview() {
    setPreview({ status: 'loading' });
    try {
      setPreview(await load());
    } catch {
      setPreview({ status: 'error' });
    }
  }

  return (
    <section
      className="gov-fieldset"
      aria-labelledby="repository-descriptor-title"
    >
      <h2 id="repository-descriptor-title">Repository descriptor</h2>
      {(!preview || preview.status === 'error') && (
        <div>
          <button type="button" onClick={loadPreview}>
            Preview descriptor
          </button>
        </div>
      )}
      {preview?.status === 'loading' && (
        <p role="status">Loading repository descriptor…</p>
      )}
      {preview?.status === 'error' && (
        <p role="status">
          The descriptor could not be loaded. Try again or continue with the
          form.
        </p>
      )}
      {preview?.status === 'unavailable' && (
        <p role="status">
          No usable descriptor is available. Continue with the form below.
        </p>
      )}
      {preview?.status === 'ready' &&
        (applied ? (
          <p role="status">
            Descriptor applied. Check the fields before registering.
          </p>
        ) : (
          <>
            <p>
              <strong>{preview.app.name}</strong>
            </p>
            <p>{preview.app.purpose}</p>
            <p>
              Applying the descriptor replaces app details, team, and risk
              answers in the form. Check the values before registering.
            </p>
            <div>
              <button type="button" onClick={() => apply(preview.app)}>
                Apply descriptor
              </button>
            </div>
          </>
        ))}
    </section>
  );
}
