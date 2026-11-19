export async function readBoundedResponseText(
  response: Response,
  byteLimit: number,
) {
  if (Number(response.headers.get('content-length')) > byteLimit) {
    await response.body?.cancel();
    return undefined;
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let content = '';
  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      bytes += chunk.value.byteLength;
      if (bytes > byteLimit) return undefined;
      content += decoder.decode(chunk.value, { stream: true });
      chunk = await reader.read();
    }
    return content + decoder.decode();
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
