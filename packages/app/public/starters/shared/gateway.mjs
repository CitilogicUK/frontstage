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

  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.FRONTSTAGE_MODEL ?? 'gpt-4.1-mini',
      prompt,
      expectedEnvironment,
    }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      result?.error?.message ?? `Gateway returned HTTP ${response.status}.`,
    );
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
