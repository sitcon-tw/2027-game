import { describeApiError } from './api_error.js';

export const statePath = '/api/admin/state';
export const actionsPath = '/api/admin/actions';
export const backendUnavailable = '無法連線至後端';
export const unconfirmedAction = '無法確認操作結果，請重新整理。';

async function fetchResponse(path, options, failureMessage) {
  try {
    return await fetch(path, { cache: 'no-store', credentials: 'same-origin', redirect: 'error', ...options });
  } catch {
    throw new Error(failureMessage);
  }
}

export async function dashboardRequest({ payload, signal }) {
  const failureMessage = payload ? unconfirmedAction : backendUnavailable;
  const options = { signal };
  if (payload) {
    // Acquire the current host token only on explicit submission. Never replay a mutation.
    const csrfResponse = await fetchResponse('/api/csrf', { signal }, backendUnavailable);
    const csrf = await csrfResponse.json().catch(() => null);
    if (!csrfResponse.ok || !/^[A-Za-z0-9_-]{43}$/.test(csrf?.data?.token ?? '')) {
      throw new Error('無法送出操作，請重新整理。');
    }
    options.method = 'POST';
    options.headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.data.token };
    options.body = JSON.stringify(payload);
  }
  const response = await fetchResponse(payload ? actionsPath : statePath, options, failureMessage);
  const result = await response.json().catch(() => null);
  if (response.status >= 500 || !result || typeof result !== 'object') throw new Error(failureMessage);
  if (!response.ok || result.error) throw new Error(describeApiError(result.error?.message));
  if (result.data?.mode !== 'test' || !Array.isArray(result.data.players) || !Array.isArray(result.data.stations)) {
    throw new Error(failureMessage);
  }
  return result.data;
}
