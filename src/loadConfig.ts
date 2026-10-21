import { TeamConfig, validateTeamConfig } from './config';
import { errorMessage } from './util/json';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export class ConfigLoadError extends Error {
  override name = 'ConfigLoadError';
}

export interface LoadedConfig {
  config: TeamConfig;
  warnings: string[];
}

export interface LoadOptions {
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Only HTTPS is accepted, plain HTTP only for local testing. */
export function parseConfigUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ConfigLoadError(`"${raw}" ist keine gültige URL.`);
  }
  const isLocal = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
    throw new ConfigLoadError(`Nur HTTPS-URLs sind erlaubt (HTTP nur für localhost): ${describeUrl(url)}`);
  }
  return url;
}

/** URL without query string and credentials, safe for logs. */
export function describeUrl(url: URL | string): string {
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '<ungültige URL>';
  }
}

export async function loadTeamConfig(rawUrl: string, options: LoadOptions = {}): Promise<LoadedConfig> {
  const url = parseConfigUrl(rawUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Node's fetch has no HTTP cache; the header keeps proxies and CDNs from serving stale configs.
  const headers: Record<string, string> = { Accept: 'application/json', 'Cache-Control': 'no-cache' };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new ConfigLoadError(describeFetchError(error, timeoutMs));
  }

  if (response.redirected && response.url) {
    // The target of a redirect must meet the same rules as the configured URL.
    parseConfigUrl(response.url);
  }

  if (!response.ok) {
    const hint =
      response.status === 401 || response.status === 403
        ? ' Token prüfen ("Team Sync: Token setzen").'
        : '';
    throw new ConfigLoadError(`Server antwortet mit HTTP ${response.status} ${response.statusText}.${hint}`.trim());
  }

  const declaredLength = Number(response.headers.get('content-length'));
  if (declaredLength > MAX_RESPONSE_BYTES) {
    throw new ConfigLoadError(`Antwort ist größer als ${MAX_RESPONSE_BYTES} Bytes.`);
  }

  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    throw new ConfigLoadError(describeFetchError(error, timeoutMs));
  }
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new ConfigLoadError(`Antwort ist größer als ${MAX_RESPONSE_BYTES} Bytes.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.charCodeAt(0) === 0xfeff ? body.slice(1) : body);
  } catch (error) {
    throw new ConfigLoadError(`Ungültiges JSON: ${errorMessage(error)}`);
  }

  const result = validateTeamConfig(parsed);
  if (!result.ok) {
    throw new ConfigLoadError(`Ungültige Team-Konfiguration:\n  - ${result.errors.join('\n  - ')}`);
  }
  return { config: result.config, warnings: result.warnings };
}

function describeFetchError(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `Zeitüberschreitung nach ${Math.round(timeoutMs / 1000)} s.`;
  }
  const cause = error instanceof Error ? (error.cause as { code?: string; message?: string } | undefined) : undefined;
  const detail = cause?.code ?? cause?.message ?? errorMessage(error);
  return `Netzwerkfehler: ${detail}`;
}
