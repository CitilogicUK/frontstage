import { readBoundedResponseText } from './boundedResponse';

it.each([true, false])(
  'returns promptly for an oversized response with a pending cancellation (length header: %s)',
  async withLengthHeader => {
    const cancel = jest.fn(() => new Promise<void>(() => {}));
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(5));
        },
        cancel,
      }),
      withLengthHeader ? { headers: { 'Content-Length': '5' } } : undefined,
    );
    await expect(readBoundedResponseText(response, 4)).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
  },
);

it('preserves invalid UTF-8 errors if cancellation rejects', async () => {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xff]));
      },
      cancel() {
        return Promise.reject(new Error('Synthetic cancellation failure'));
      },
    }),
  );
  await expect(readBoundedResponseText(response, 4)).rejects.toBeInstanceOf(
    TypeError,
  );
  expect(response.body?.locked).toBe(false);
});
