import { fetchApiRef } from '@backstage/core-plugin-api';
import { mockApis, TestApiProvider } from '@backstage/frontend-test-utils';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { GovernancePage } from './GovernancePage';

it('reports elapsed registration time and saved tier only after a successful save', async () => {
  const analytics = mockApis.analytics();
  const clock = jest.spyOn(performance, 'now').mockReturnValue(1_000);
  const save = jest
    .fn()
    .mockResolvedValueOnce(
      Response.json(
        { error: { message: 'Registration failed' } },
        { status: 400 },
      ),
    )
    .mockResolvedValueOnce(
      Response.json({
        id: 'private-id',
        name: 'Private app name',
        owner: 'user:default/private-owner',
        team: 'private-team',
        classification: 'public',
        reviewStatus: 'pending',
        updatedAt: '2026-11-19T00:00:00Z',
        nextReview: null,
        lastReview: null,
        tier: 2,
        models: [],
        connections: [],
        lifecycle: 'experimental',
      }),
    );
  const fetch: typeof globalThis.fetch = async (input, options) => {
    if (String(input).endsWith('/apps') && options?.method === 'POST')
      return save();
    return Response.json({ apps: [], tier: 1 });
  };

  const dialogClose = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    'close',
  );
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: jest.fn(),
  });
  // Backstage's Jest environment installs Node's FormData, which cannot read a form.
  const frame = document.body.appendChild(document.createElement('iframe'));
  const originalFormData = globalThis.FormData;
  globalThis.FormData = (
    frame.contentWindow as Window & typeof globalThis
  ).FormData;
  try {
    render(
      <TestApiProvider
        apis={[
          analytics,
          mockApis.config(),
          mockApis.discovery(),
          [fetchApiRef, { fetch }],
        ]}
      >
        <MemoryRouter
          initialEntries={['/?view=register']}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <GovernancePage />
        </MemoryRouter>
      </TestApiProvider>,
    );
    const form = within(
      screen.getByRole('region', { name: 'App registration' }),
    )
      .getByRole('button', { name: /register app/i })
      .closest('form')!;
    fireEvent.change(screen.getByLabelText('Delivery stage'), {
      target: { value: 'trial' },
    });
    clock.mockReturnValue(3_000);
    fireEvent.submit(form);
    await screen.findByText('Registration failed');
    expect(
      analytics.getEvents().filter(event => event.action === 'register-app'),
    ).toEqual([]);

    clock.mockReturnValue(7_500);
    fireEvent.submit(form);
    await waitFor(() => {
      expect(
        analytics.getEvents().filter(event => event.action === 'register-app'),
      ).toEqual([
        expect.objectContaining({
          subject: 'governance-app',
          value: 6.5,
          attributes: {
            source: 'intake',
            tier: 2,
            deliveryStage: 'trial',
            usesAiAtRuntime: true,
          },
        }),
      ]);
    });
  } finally {
    globalThis.FormData = originalFormData;
    frame.remove();
    clock.mockRestore();
    if (dialogClose)
      Object.defineProperty(HTMLDialogElement.prototype, 'close', dialogClose);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  }
});
