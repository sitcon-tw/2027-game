import { loopback, publicConfig } from './config.ts';

try {
  const { port } = publicConfig(process.env);
  const response = await fetch(`http://${loopback}:${port}/api/health`, {
    redirect: 'error',
    signal: AbortSignal.timeout(3000),
  });
  if (response.status !== 200 || response.headers.get('content-type')?.split(';')[0] !== 'application/json') {
    throw new Error('Expected HTTP 200 application/json');
  }
  const result: { data?: { status?: string; mode?: string } } = await response.json();
  if (result?.data?.status !== 'ok' || result.data.mode !== 'test') throw new Error('Unexpected API health response');
} catch {
  console.error('API healthcheck failed');
  process.exitCode = 1;
}
