export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function api<T>(url: string, options: { body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(`/api${url}`, {
    method: options.body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin', signal: options.signal,
    headers: options.body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Exporter-Request': '1' },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new ApiError(data.error ?? 'The local server could not complete the request.', response.status);
  return data;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The request failed. Try again.';
}
