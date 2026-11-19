const prompt = 'Frontstage sandbox latency probe using synthetic data.';
const timeoutMs = 10_000;
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

function readLimit(env, name) {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const limit = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(`${name} must be a positive integer in milliseconds.`);
  }
  return limit;
}

function readConfig(env) {
  let origin;
  try {
    origin = new URL(env.FRONTSTAGE_PROBE_URL ?? '');
  } catch {
    throw new Error('Set FRONTSTAGE_PROBE_URL to the Frontstage origin.');
  }
  if (
    (origin.protocol !== 'https:' &&
      !(origin.protocol === 'http:' && loopbackHosts.has(origin.hostname))) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  ) {
    throw new Error('Use an HTTPS origin or a loopback HTTP origin.');
  }
  const key = env.FRONTSTAGE_PROBE_SANDBOX_KEY?.trim();
  const model = env.FRONTSTAGE_PROBE_MODEL?.trim();
  if (!key || /\s/.test(key) || !model) {
    throw new Error(
      'Set FRONTSTAGE_PROBE_SANDBOX_KEY and FRONTSTAGE_PROBE_MODEL.',
    );
  }
  const rawSamples = env.FRONTSTAGE_PROBE_SAMPLES ?? '10';
  const samples = Number(rawSamples);
  if (!/^\d+$/.test(rawSamples) || samples < 1 || samples > 30) {
    throw new Error(
      'FRONTSTAGE_PROBE_SAMPLES must be an integer from 1 to 30.',
    );
  }
  return {
    origin,
    key,
    model,
    samples,
    clientP95MaxMs: readLimit(env, 'FRONTSTAGE_PROBE_MAX_CLIENT_P95_MS'),
    frontstageP95MaxMs: readLimit(
      env,
      'FRONTSTAGE_PROBE_MAX_FRONTSTAGE_P95_MS',
    ),
  };
}

function summarize(values) {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
  };
}

async function probe({ origin, key, model }, sample) {
  const started = performance.now();
  let response;
  try {
    response = await fetch(new URL('/api/governance/gateway/chat', origin), {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ model, prompt, expectedEnvironment: 'sandbox' }),
    });
  } catch {
    throw new Error(
      `Sample ${sample}: gateway connection failed or timed out.`,
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(
      `Sample ${sample}: gateway returned HTTP ${response.status}.`,
    );
  }
  const timing = response.headers.get('server-timing');
  const frontstage = Number(/^frontstage;dur=(\d+)$/.exec(timing ?? '')?.[1]);
  if (!Number.isSafeInteger(frontstage)) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Sample ${sample}: expected sandbox Frontstage timing.`);
  }
  const result = await response.json().catch(() => undefined);
  if (result?.simulated !== true || result.model !== model) {
    throw new Error(
      `Sample ${sample}: expected a simulated response for the requested model.`,
    );
  }
  return { client: Math.round(performance.now() - started), frontstage };
}

try {
  const config = readConfig(process.env);
  const client = [];
  const frontstage = [];
  for (let sample = 1; sample <= config.samples; sample += 1) {
    const timing = await probe(config, sample);
    client.push(timing.client);
    frontstage.push(timing.frontstage);
  }
  const clientMilliseconds = summarize(client);
  const frontstageMilliseconds = summarize(frontstage);
  const { clientP95MaxMs, frontstageP95MaxMs } = config;
  const clientExceeded =
    clientP95MaxMs !== undefined && clientMilliseconds.p95 > clientP95MaxMs;
  const frontstageExceeded =
    frontstageP95MaxMs !== undefined &&
    frontstageMilliseconds.p95 > frontstageP95MaxMs;
  const passed = !clientExceeded && !frontstageExceeded;
  console.log(
    JSON.stringify(
      {
        samples: config.samples,
        clientMilliseconds,
        frontstageMilliseconds,
        ...(clientP95MaxMs !== undefined || frontstageP95MaxMs !== undefined
          ? { targets: { clientP95MaxMs, frontstageP95MaxMs, passed } }
          : {}),
      },
      null,
      2,
    ),
  );
  if (!passed) {
    if (clientExceeded)
      console.error(`Client p95 exceeded ${clientP95MaxMs} ms.`);
    if (frontstageExceeded)
      console.error(`Frontstage p95 exceeded ${frontstageP95MaxMs} ms.`);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
