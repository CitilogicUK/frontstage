function retryGuidance(response) {
  if (response.status !== 429 && response.status !== 503) return '';
  const value = response.headers.get('Retry-After');
  if (!value) return '';
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) && seconds > 0
      ? ` Wait ${seconds} ${
          seconds === 1 ? 'second' : 'seconds'
        } before trying again.`
      : '';
  }
  const date = new Date(value);
  return date.getTime() > Date.now() && date.toUTCString() === value
    ? ` Retry after ${value}.`
    : '';
}

export async function runModel(prompt) {
  const expectedEnvironment =
    process.env.FRONTSTAGE_GATEWAY_ENVIRONMENT ?? 'sandbox';
  if (expectedEnvironment !== 'sandbox' && expectedEnvironment !== 'production')
    throw new Error(
      'Set FRONTSTAGE_GATEWAY_ENVIRONMENT to sandbox or production.',
    );

  const key = process.env.FRONTSTAGE_GATEWAY_KEY?.trim();
  if (!key)
    throw new Error('Set FRONTSTAGE_GATEWAY_KEY to your app’s issued key.');

  const base = new URL(
    process.env.FRONTSTAGE_BACKEND_URL ?? 'http://localhost:7007',
  );
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (
    (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error(
      'Use an HTTPS Frontstage backend URL or a local loopback HTTP URL.',
    );
  }
  base.pathname = base.pathname.replace(/\/?$/, '/');
  const endpoint = new URL('api/governance/gateway/chat', base);

  if (!prompt.trim() || prompt.length > 16_000)
    throw new Error('Supply a prompt of 1 to 16,000 characters.');

  const configuredTimeout =
    process.env.FRONTSTAGE_GATEWAY_TIMEOUT_MS ?? '30000';
  const timeoutMs = Number(configuredTimeout);
  if (
    !/^\d+$/.test(configuredTimeout) ||
    timeoutMs < 1000 ||
    timeoutMs > 120000
  )
    throw new Error(
      'Set FRONTSTAGE_GATEWAY_TIMEOUT_MS to an integer from 1000 to 120000.',
    );

  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.FRONTSTAGE_MODEL ?? 'gpt-4.1-mini',
      prompt,
      expectedEnvironment,
    }),
  }).catch(error => {
    if (signal.aborted) throw new Error('The gateway request timed out.');
    throw error;
  });
  const result = await response.json().catch(() => null);
  if (signal.aborted) throw new Error('The gateway request timed out.');
  if (!response.ok) {
    const message =
      result?.error?.message ?? `Gateway returned HTTP ${response.status}.`;
    throw new Error(message + retryGuidance(response));
  }
  if (typeof result?.output !== 'string')
    throw new Error('The gateway did not return a model response.');
  if (result.simulated) process.stderr.write('Simulated gateway response.\n');
  return result.output;
}

export async function readText(stream, maxLength = 16_000) {
  stream.setEncoding('utf8');
  let input = '';
  for await (const chunk of stream) {
    input += chunk;
    if (input.length > maxLength)
      throw new Error(`Use at most ${maxLength} input characters.`);
  }
  if (!input.trim()) throw new Error('Enter some text.');
  return input.trim();
}

export function showError(error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
