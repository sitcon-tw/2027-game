import { portNumber } from './server.mjs';

try {
  const port = portNumber(process.env.PORT ?? 4173, 'PORT');
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
    redirect: 'error',
    signal: AbortSignal.timeout(3000),
  });
  const body = await response.json();
  if (response.status !== 200 || body.data?.status !== 'ok' || body.data?.mode !== 'test') {
    throw new Error(`Unexpected gateway health response (${response.status})`);
  }
} catch (error) {
  console.error(`Frontend healthcheck failed: ${error.message}`);
  process.exitCode = 1;
}
