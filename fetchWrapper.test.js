// Fetch Wrapper Tests
//
// Verifies request normalization, cancellation, retry behavior, response
// cleanup, and the public structured-error contract without network access.
'use strict';

import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { setImmediate } from 'node:timers';

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

for (let data of [{ constructor: 'device', enabled: true }, Object.assign(Object.create(null), { enabled: true })]) {
  test(
    'serialises a POST object with ' + (Object.getPrototypeOf(data) === null ? 'a null prototype' : 'a constructor property'),
    async () => {
      await fetchWrapper('post', 'https://example.test', {}, data, {
        fetch: async (url, options) => {
          let request = new globalThis.Request(url, options);
          assert.equal(await request.text(), JSON.stringify(data));
          assert.equal(request.headers.get('Content-Type'), 'application/json');
          return new globalThis.Response('ok');
        },
      });
    },
  );
}

test('preserves native POST body types when detecting plain objects', async () => {
  let data = new globalThis.URLSearchParams({ enabled: 'true' });
  await fetchWrapper('post', 'https://example.test', {}, data, {
    fetch: async (url, options) => {
      assert.equal(options.body, data);
      let request = new globalThis.Request(url, options);
      assert.equal(await request.text(), 'enabled=true');
      assert.equal(request.headers.get('Content-Type'), 'application/x-www-form-urlencoded;charset=UTF-8');
      return new globalThis.Response('ok');
    },
  });
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
  let requestOptions = Object.freeze({ retry: 3 });

  let response = await fetchWrapper('get', 'https://example.test', requestOptions, undefined, {
    fetch: async (url, options) => {
      assert.equal(url, 'https://example.test');
      assert.deepEqual(options, { method: 'get' });
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
  assert.deepEqual(requestOptions, { retry: 3 });
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

test('accepts a null caller signal with a configured timeout', async () => {
  let receivedSignal;
  let response = await fetchWrapper('get', 'data:text/plain,ok', { signal: null, timeout: 1000 }, undefined, {
    fetch: async (url, options) => {
      receivedSignal = options.signal;
      return globalThis.fetch(url, options);
    },
  });

  assert.equal(await response.text(), 'ok');
  assert.equal(receivedSignal instanceof globalThis.AbortSignal, true);
});

for (let failure of ['http', 'transport']) {
  for (let pendingDelay of [false, true]) {
    test('cancels ' + failure + ' retry with an injected ' + (pendingDelay === true ? 'pending' : 'resolved') + ' delay', async () => {
      let controller = new globalThis.AbortController();
      let reason = new Error('Caller cancelled during backoff');
      let attempts = 0;
      let delays = 0;

      await assert.rejects(
        fetchWrapper('get', 'https://example.test', { retry: 3, signal: controller.signal }, undefined, {
          fetch: async () => {
            attempts += 1;
            if (failure === 'transport') {
              throw new TypeError('network unavailable');
            }
            return new globalThis.Response('busy', { status: 503 });
          },
          delay: async () => {
            delays += 1;
            controller.abort(reason);
            if (pendingDelay === true) {
              await new Promise(() => {});
            }
          },
        }),
        (error) => {
          assert.equal(error.cause, reason);
          assert.match(error.message, /failed after 1 attempt/);
          return true;
        },
      );

      assert.equal(attempts, 1);
      assert.equal(delays, 1);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    });
  }

  test('cancels ' + failure + ' retry with the native delay', async () => {
    let controller = new globalThis.AbortController();
    let reason = new Error('Caller cancelled during native backoff');
    let attempts = 0;

    await assert.rejects(
      fetchWrapper('get', 'https://example.test', { retry: 3, signal: controller.signal }, undefined, {
        fetch: async () => {
          attempts += 1;
          // The immediate runs after the failure has entered the retry timer.
          setImmediate(() => controller.abort(reason));
          if (failure === 'transport') {
            throw new TypeError('network unavailable');
          }
          return new globalThis.Response('busy', { status: 503 });
        },
      }),
      (error) => {
        assert.equal(error.cause, reason);
        assert.match(error.message, /failed after 1 attempt/);
        return true;
      },
    );

    assert.equal(attempts, 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });

  for (let streamType of ['web', 'node', 'async iterable']) {
    for (let bodySource of ['data', 'options']) {
      test('preserves ' + failure + ' failure for a ' + streamType + ' stream passed through ' + bodySource, async () => {
        let body;
        if (streamType === 'node') {
          body = Readable.from(['payload']);
        } else if (streamType === 'async iterable') {
          body = {
            async *[Symbol.asyncIterator]() {
              yield 'payload';
            },
          };
        } else {
          body = new globalThis.ReadableStream({
            start(controller) {
              controller.enqueue(new globalThis.TextEncoder().encode('payload'));
              controller.close();
            },
          });
        }
        let options = { retry: 3, duplex: 'half' };
        if (bodySource === 'options') {
          options.body = body;
        }
        let attempts = 0;
        let transportError = new TypeError('connection lost after sending body');

        await assert.rejects(
          fetchWrapper('post', 'https://example.test', options, bodySource === 'data' ? body : undefined, {
            fetch: async (url, fetchOptions) => {
              attempts += 1;
              assert.equal(fetchOptions.body, body);
              assert.equal(new globalThis.Headers(fetchOptions.headers).has('Content-Type'), false);
              // Use native Request consumption to exercise a real one-shot body.
              assert.equal(await new globalThis.Request(url, fetchOptions).text(), 'payload');
              if (failure === 'transport') {
                throw transportError;
              }
              return new globalThis.Response('busy', { status: 503 });
            },
            delay: async () => assert.fail('A streaming body must not be retried'),
          }),
          (error) => {
            assert.match(error.message, /failed after 1 attempt/);
            if (failure === 'http') {
              assert.equal(error.status, 503);
              assert.equal(error.code, 503);
              assert.equal(error.body, 'busy');
            } else {
              assert.equal(error.cause, transportError);
            }
            return true;
          },
        );

        assert.equal(attempts, 1);
      });
    }
  }
}

test('retries a replayable JSON body overriding a streaming options body', async () => {
  let attempts = 0;
  let controller = new globalThis.AbortController();
  let response = await fetchWrapper(
    'post',
    'https://example.test',
    { retry: 2, signal: controller.signal, body: Readable.from(['unused']) },
    { enabled: true },
    {
      fetch: async (url, options) => {
        attempts += 1;
        // Keep native Request signal listeners separate from the retry-listener cleanup check.
        let request = new globalThis.Request(url, { method: options.method, body: options.body, headers: options.headers });
        assert.equal(await request.text(), '{"enabled":true}');
        return new globalThis.Response(attempts === 1 ? 'busy' : 'ok', { status: attempts === 1 ? 503 : 200 });
      },
      delay: async () => {},
    },
  );

  assert.equal(await response.text(), 'ok');
  assert.equal(attempts, 2);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
