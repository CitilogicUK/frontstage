import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { mockApis, TestApiProvider } from '@backstage/frontend-test-utils';
import { MemoryRouter } from 'react-router-dom';
import { AppTemplates } from './AppTemplates';

it('reports a starter download only after its archive is ready', async () => {
  const analytics = mockApis.analytics();
  const config = mockApis.config({
    data: { app: { baseUrl: 'http://localhost:3000' } },
  });
  const originalFetch = globalThis.fetch;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const click = jest
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => {});
  const fetchStarter = jest.fn(async (input: URL) => {
    const content = input.pathname.endsWith('catalog-info.yaml')
      ? 'spec:\n  deliveryStage: trial\n'
      : 'Sample content';
    return {
      ok: true,
      headers: { get: () => null },
      arrayBuffer: async () => new TextEncoder().encode(content).buffer,
    };
  });
  globalThis.fetch = fetchStarter as unknown as typeof fetch;
  URL.createObjectURL = jest.fn(() => 'blob:starter');
  const revoke = jest.fn();
  URL.revokeObjectURL = revoke;
  try {
    render(
      <TestApiProvider
        apis={[analytics, config, mockApis.discovery(), mockApis.fetch()]}
      >
        <MemoryRouter
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <AppTemplates />
        </MemoryRouter>
      </TestApiProvider>,
    );
    fireEvent.change(
      screen.getByRole('combobox', { name: /delivery stage/i }),
      {
        target: { value: 'poc' },
      },
    );
    const download = screen.getByRole('button', {
      name: 'Download AI-assisted software starter',
    });
    fetchStarter.mockRejectedValueOnce(new Error('Starter unavailable'));
    fireEvent.click(download);
    await screen.findByRole('alert');
    expect(analytics.getEvents()).toEqual([]);
    expect(click).not.toHaveBeenCalled();

    fireEvent.click(download);
    await waitFor(() =>
      expect(analytics.getEvents()).toEqual([
        expect.objectContaining({
          action: 'download-starter',
          subject: 'ai-assisted-software',
          attributes: { deliveryStage: 'poc', usesAiAtRuntime: false },
        }),
      ]),
    );
    expect(click).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:starter'), {
      timeout: 2_000,
    });
  } finally {
    click.mockRestore();
    globalThis.fetch = originalFetch;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});
