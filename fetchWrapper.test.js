// Fetch Wrapper Tests
//
// Verifies request normalization, cancellation, retry behavior, response
// cleanup, and the public structured-error contract without network access.
'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchWrapper } from './fetchWrapper.js';

test('rejects unsupported requests without calling fetch', async () => {
  let calls = 0;
  let dependencies = {
    fetch: async () => {
      calls += 1;
    },
  };

  assert.equal(await fetchWrapper('put', 'https://example.test', {}, undefined, dependencies), undefined);
  assert.equal(await fetchWrapper('get', '', {}, undefined, dependencies), undefined);
  assert.equal(await fetchWrapper('get', 'https://example.test', null, undefined, dependencies), undefined);
  assert.equal(calls, 0);
});

test('passes GET request options without wrapper bookkeeping', async () => {
  let receivedOptions;

  await fetchWrapper('get', 'https://example.test', { headers: { Accept: 'application/json' }, retry: 1, timeout: 0 }, undefined, {
    fetch: async (url, options) => {
      assert.equal(url, 'https://example.test');
      receivedOptions = options;
      return { ok: true };
    },
  });

  assert.equal(receivedOptions.method, 'get');
  assert.equal(receivedOptions.retry, undefined);
  assert.equal(receivedOptions.timeout, undefined);
  assert.equal(receivedOptions._retryCount, undefined);
  assert.deepEqual(receivedOptions.headers, { Accept: 'application/json' });
});

test('serialises plain POST bodies and applies a default content type', async () => {
  let receivedOptions;

  await fetchWrapper(
    'post',
    'https://example.test',
    {},
    { enabled: true },
    {
      fetch: async (url, options) => {
        assert.equal(url, 'https://example.test');
        receivedOptions = options;
        return { ok: true };
      },
    },
  );

  assert.equal(receivedOptions.body, '{"enabled":true}');
  assert.equal(receivedOptions.headers.get('Content-Type'), 'application/json');
});

test('preserves an existing content type regardless of header casing', async () => {
  let receivedOptions;

  await fetchWrapper(
    'post',
    'https://example.test',
    { headers: { 'content-type': 'application/merge-patch+json' } },
    { enabled: true },
    {
      fetch: async (url, options) => {
        assert.equal(url, 'https://example.test');
        receivedOptions = options;
        return { ok: true };
      },
    },
  );

  assert.equal(receivedOptions.headers.get('Content-Type'), 'application/merge-patch+json');
});

test('combines caller cancellation with a configured timeout', async () => {
  let controller = new globalThis.AbortController();
  let receivedSignal;

  await fetchWrapper('get', 'https://example.test', { signal: controller.signal, timeout: 1000 }, undefined, {
    fetch: async (url, options) => {
      assert.equal(url, 'https://example.test');
      receivedSignal = options.signal;
      return { ok: true };
    },
  });

  assert.notEqual(receivedSignal, controller.signal);
  assert.equal(receivedSignal.aborted, false);
  controller.abort();
  assert.equal(receivedSignal.aborted, true);
});

test('releases transient HTTP responses and applies exponential retry delays', async () => {
  let attempts = 0;
  let cancellations = 0;
  let delays = [];

  let response = await fetchWrapper('get', 'https://example.test', { retry: 3 }, undefined, {
    fetch: async () => {
      attempts += 1;
      if (attempts < 3) {
        return {
          ok: false,
          status: 503,
          body: {
            cancel: async () => {
              cancellations += 1;
            },
          },
        };
      }

      return { ok: true };
    },
    delay: async (delay) => {
      delays.push(delay);
    },
  });

  assert.equal(response.ok, true);
  assert.equal(attempts, 3);
  assert.equal(cancellations, 2);
  assert.deepEqual(delays, [500, 1000]);
});

test('retries transient transport errors and reports the final attempt count', async () => {
  let attempts = 0;

  await assert.rejects(
    fetchWrapper('get', 'https://example.test', { retry: 2 }, undefined, {
      fetch: async () => {
        attempts += 1;
        throw new TypeError('network unavailable');
      },
      delay: async () => {},
    }),
    (error) => {
      assert.equal(error.cause.name, 'TypeError');
      assert.match(error.message, /failed after 2 attempts/);
      return true;
    },
  );

  assert.equal(attempts, 2);
});

test('does not retry explicit caller cancellation', async () => {
  let controller = new globalThis.AbortController();
  let attempts = 0;
  controller.abort();

  await assert.rejects(
    fetchWrapper('get', 'https://example.test', { retry: 3, signal: controller.signal }, undefined, {
      fetch: async () => {
        attempts += 1;
        throw controller.signal.reason;
      },
      delay: async () => {},
    }),
    (error) => {
      assert.match(error.message, /failed after 1 attempt/);
      return true;
    },
  );

  assert.equal(attempts, 1);
});

test('preserves non-retryable HTTP error metadata', async () => {
  await assert.rejects(
    fetchWrapper('get', 'https://example.test/missing', { retry: 3 }, undefined, {
      fetch: async () => ({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => 'missing response',
      }),
      delay: async () => {
        assert.fail('404 response must not be retried');
      },
    }),
    (error) => {
      assert.equal(error.status, 404);
      assert.equal(error.code, 404);
      assert.equal(error.body, 'missing response');
      assert.match(error.message, /HTTP 404/);
      return true;
    },
  );
});
