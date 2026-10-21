import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigLoadError, describeUrl, loadTeamConfig, parseConfigUrl } from '../src/loadConfig';

type FetchArgs = Parameters<typeof fetch>;

function fakeFetch(respond: (...args: FetchArgs) => Response | Promise<Response>) {
  const calls: FetchArgs[] = [];
  const impl = (async (...args: FetchArgs) => {
    calls.push(args);
    return respond(...args);
  }) as typeof fetch;
  return { impl, calls };
}

const URL_OK = 'https://config.example.com/team-config.json';
const VALID_BODY = JSON.stringify({ version: 1, extensions: { install: ['a.b'] }, settings: {} });

describe('parseConfigUrl', () => {
  it('accepts https and local http', () => {
    assert.equal(parseConfigUrl(` ${URL_OK} `).hostname, 'config.example.com');
    assert.equal(parseConfigUrl('http://localhost:8080/c.json').port, '8080');
    assert.equal(parseConfigUrl('http://127.0.0.1/c.json').hostname, '127.0.0.1');
  });

  for (const url of ['not a url', 'http://config.example.com/c.json', 'ftp://example.com/c.json', 'file:///c.json']) {
    it(`rejects ${url}`, () => {
      assert.throws(() => parseConfigUrl(url), ConfigLoadError);
    });
  }
});

describe('describeUrl', () => {
  it('drops query strings and credentials', () => {
    assert.equal(describeUrl('https://user:pw@example.com/a.json?key=secret'), 'https://example.com/a.json');
  });
});

describe('loadTeamConfig', () => {
  it('loads and validates the config', async () => {
    const { impl } = fakeFetch(() => new Response(VALID_BODY, { status: 200 }));
    const { config } = await loadTeamConfig(URL_OK, { fetchImpl: impl });
    assert.deepEqual(config.extensions.install, ['a.b']);
  });

  it('sends the bearer token only when set', async () => {
    const { impl, calls } = fakeFetch(() => new Response(VALID_BODY));
    await loadTeamConfig(URL_OK, { fetchImpl: impl, token: 'abc' });
    await loadTeamConfig(URL_OK, { fetchImpl: impl });
    const headers = calls.map(([, init]) => init?.headers as Record<string, string>);
    assert.equal(headers[0].Authorization, 'Bearer abc');
    assert.equal(headers[1].Authorization, undefined);
  });

  it('accepts a UTF-8 BOM', async () => {
    const { impl } = fakeFetch(() => new Response(`﻿${VALID_BODY}`));
    await assert.doesNotReject(loadTeamConfig(URL_OK, { fetchImpl: impl }));
  });

  it('reports HTTP errors with a token hint for 401', async () => {
    const { impl } = fakeFetch(() => new Response('', { status: 401, statusText: 'Unauthorized' }));
    await assert.rejects(loadTeamConfig(URL_OK, { fetchImpl: impl }), /HTTP 401.*Token/);
  });

  it('reports network errors', async () => {
    const { impl } = fakeFetch(() => {
      throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
    });
    await assert.rejects(loadTeamConfig(URL_OK, { fetchImpl: impl }), /Netzwerkfehler: ENOTFOUND/);
  });

  it('reports timeouts', async () => {
    const { impl } = fakeFetch((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        // AbortSignal.timeout() does not keep the event loop alive, a pending request would.
        const keepAlive = setTimeout(() => undefined, 10_000);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(keepAlive);
          reject(init.signal?.reason);
        });
      });
    });
    await assert.rejects(loadTeamConfig(URL_OK, { fetchImpl: impl, timeoutMs: 20 }), /Zeitüberschreitung/);
  });

  it('reports invalid JSON', async () => {
    const { impl } = fakeFetch(() => new Response('{ version: 1 '));
    await assert.rejects(loadTeamConfig(URL_OK, { fetchImpl: impl }), /Ungültiges JSON/);
  });

  it('reports schema violations', async () => {
    const { impl } = fakeFetch(() => new Response(JSON.stringify({ version: 'eins' })));
    await assert.rejects(loadTeamConfig(URL_OK, { fetchImpl: impl }), /Ungültige Team-Konfiguration[\s\S]*version/);
  });

  it('rejects redirects to plain HTTP', async () => {
    const { impl } = fakeFetch(() => {
      const response = new Response(VALID_BODY);
      Object.defineProperty(response, 'redirected', { value: true });
      Object.defineProperty(response, 'url', { value: 'http://evil.example.com/team-config.json' });
      return response;
    });
    await assert.rejects(loadTeamConfig(URL_OK, { fetchImpl: impl }), /HTTPS/);
  });

  it('rejects responses that announce more than 1 MB', async () => {
    const { impl } = fakeFetch(() => new Response(VALID_BODY, { headers: { 'content-length': '5000000' } }));
    await assert.rejects(loadTeamConfig(URL_OK, { fetchImpl: impl }), /größer/);
  });

  it('rejects insecure URLs before fetching', async () => {
    const { impl, calls } = fakeFetch(() => new Response(VALID_BODY));
    await assert.rejects(loadTeamConfig('http://example.com/c.json', { fetchImpl: impl, token: 'abc' }), /HTTPS/);
    assert.equal(calls.length, 0);
  });
});
