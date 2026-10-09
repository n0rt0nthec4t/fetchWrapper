// Fetch Wrapper - shared HTTP request helper
//
// Provides a small fetch abstraction shared by Accfactory projects. It handles
// request timeouts, caller cancellation, retry backoff, JSON request bodies,
// response cleanup, and structured HTTP errors without adding runtime packages.
//
// Responsibilities:
// - Validate the supported GET and POST request boundary
// - Preserve standard fetch options while removing wrapper-only options
// - Apply per-attempt timeouts without discarding caller cancellation
// - Retry selected transient HTTP and transport failures
// - Preserve HTTP status and response body details on final errors
// - Allow transport and delay injection for deterministic tests
//
// Code version 2026.10.09
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { setTimeout as wait } from 'node:timers/promises';

const RETRYABLE_HTTP_STATUS = [408, 429, 500, 502, 503, 504];

/**
 * Wrapper-specific fetch options.
 *
 * Standard fetch options are also accepted and passed through to the underlying fetch implementation.
 *
 * @typedef {RequestInit & object} FetchWrapperOptions
 * @property {number} [retry=1] Maximum number of request attempts, including the initial attempt.
 * @property {number} [timeout] Per-attempt timeout in milliseconds.
 */

/**
 * Injectable dependencies used to make request and retry behaviour deterministic during testing.
 *
 * @typedef {object} FetchWrapperDependencies
 * @property {typeof fetch} [fetch] Fetch implementation. Defaults to `globalThis.fetch`.
 * @property {function(number): Promise<*>} [delay] Delay function receiving the retry delay in milliseconds.
 */

/**
 * Perform a GET or POST request with timeout, cancellation, and retry handling.
 *
 * Plain object POST data is JSON encoded automatically. Other supported fetch body types are passed through unchanged.
 * Retryable HTTP and transport failures use exponential backoff, while caller cancellation and malformed URLs are terminal.
 * Streaming request bodies are sent once because they cannot be replayed safely.
 *
 * @param {'get'|'post'} method HTTP method to perform; use `fetchWrapper.GET` or `fetchWrapper.POST`.
 * @param {string} url Request URL.
 * @param {FetchWrapperOptions} [options={}] Fetch and wrapper-specific request options.
 * @param {*} [data] POST request body. Plain objects are JSON encoded; other values are passed directly to fetch.
 * @param {FetchWrapperDependencies} [dependencies={}] Optional fetch and delay implementations used primarily for testing.
 * @returns {Promise<Response|undefined>} Fetch response, or undefined when the request arguments fail initial validation.
 * @throws {TypeError} If the selected fetch or delay implementation is not a function.
 * @throws {Error} When the request ultimately fails after retry handling, including HTTP failures and invalid URLs.
 */
async function fetchWrapper(method, url, options = {}, data, dependencies = {}) {
  // Retain the existing Accfactory contract for unsupported request inputs.
  if (
    (method !== fetchWrapper.GET && method !== fetchWrapper.POST) ||
    typeof url !== 'string' ||
    url === '' ||
    options === null ||
    typeof options !== 'object' ||
    options.constructor !== Object
  ) {
    return;
  }

  // Keep injectable test boundaries separate from options passed to fetch.
  let fetchImplementation = dependencies?.fetch ?? globalThis.fetch;
  let delayImplementation = dependencies?.delay ?? wait;
  if (typeof fetchImplementation !== 'function') {
    throw new TypeError('A fetch implementation is required');
  }
  if (typeof delayImplementation !== 'function') {
    throw new TypeError('A delay implementation must be a function');
  }

  return fetchRequest(method, url, options, data, fetchImplementation, delayImplementation, 0);
}

/**
 * Execute one request attempt and recursively handle eligible retries.
 *
 * @param {'get'|'post'} method Validated HTTP method.
 * @param {string} url Validated request URL.
 * @param {FetchWrapperOptions} options Caller-provided request options.
 * @param {*} data POST request body.
 * @param {typeof fetch} fetchImplementation Fetch implementation selected at the public boundary.
 * @param {function(number): Promise<*>} delayImplementation Retry delay implementation selected at the public boundary.
 * @param {number} retryCount Number of request attempts already completed.
 * @returns {Promise<Response>} Fetch response.
 * @throws {Error} When the request ultimately fails after retry handling.
 * @private
 */
async function fetchRequest(method, url, options, data, fetchImplementation, delayImplementation, retryCount) {
  // retry represents total attempts rather than additional retries.
  let configuredRetry = Number(options.retry);
  let retry = Number.isFinite(configuredRetry) === true && configuredRetry > 0 ? Math.max(1, Math.floor(configuredRetry)) : 1;

  // Remove wrapper-only values from a clone, leaving caller options unchanged.
  let fetchOptions = {
    ...options,
    method,
  };
  delete fetchOptions.retry;
  delete fetchOptions.timeout;

  // Apply timeout per attempt while preserving caller-controlled cancellation.
  if (Number.isFinite(Number(options.timeout)) === true && Number(options.timeout) > 0) {
    let timeoutSignal = globalThis.AbortSignal.timeout(Math.floor(Number(options.timeout)));
    fetchOptions.signal =
      options.signal === undefined || options.signal === null ? timeoutSignal : globalThis.AbortSignal.any([options.signal, timeoutSignal]);
  }

  if (method === fetchWrapper.POST && data !== undefined) {
    // Encode only plain objects; native fetch body types pass through unchanged.
    if (typeof data === 'object' && data !== null && data.constructor === Object) {
      fetchOptions.body = JSON.stringify(data);
      fetchOptions.headers = new globalThis.Headers(fetchOptions.headers);

      // Headers normalizes every valid HeadersInit form and casing.
      if (fetchOptions.headers.has('Content-Type') === false) {
        fetchOptions.headers.set('Content-Type', 'application/json');
      }
    } else {
      fetchOptions.body = data;
    }
  }

  // Fetch consumes web streams and async iterables (including Node streams).
  // Inspect the effective body so options.body and the explicit data argument follow the same retry rule.
  let replayableBody =
    typeof fetchOptions.body?.getReader !== 'function' && typeof fetchOptions.body?.[Symbol.asyncIterator] !== 'function';

  try {
    let response = await fetchImplementation(url, fetchOptions);

    if (response?.ok === false) {
      let retryableStatus = RETRYABLE_HTTP_STATUS.includes(response.status) === true;

      if (retryCount + 1 < retry && retryableStatus === true && replayableBody === true && options.signal?.aborted !== true) {
        // Release the body before retrying so fetch can reuse the connection.
        try {
          await response.body?.cancel();
        } catch {
          // A cleanup failure does not supersede the original HTTP failure.
        }

        let delay = 500 * Math.pow(2, retryCount);
        await waitForRetry(delay, delayImplementation, options.signal);

        return fetchRequest(
          method,
          url,
          options,
          data,
          fetchImplementation,
          delayImplementation,
          retryCount + 1,
        );
      }

      // Preserve available response details on the final HTTP failure.
      let body = '';
      try {
        body = await response.text();
      } catch {
        // HTTP status remains useful when response text cannot be read.
      }

      throw Object.assign(
        new Error(
          'HTTP ' +
            response.status +
            ' on ' +
            method.toUpperCase() +
            ' ' +
            url +
            ': ' +
            (typeof response.statusText === 'string' && response.statusText !== '' ? response.statusText : 'Unknown error'),
        ),
        {
          code: response.status,
          status: response.status,
          body,
        },
      );
    }

    return response;
  } catch (error) {
    let original = error?.cause ?? error;

    // Native fetch and Undici use these names and codes for transient failures.
    let retryable =
      error?.name === 'AbortError' ||
      error?.name === 'TimeoutError' ||
      error?.name === 'TypeError' ||
      original?.name === 'AbortError' ||
      original?.name === 'TimeoutError' ||
      original?.name === 'TypeError' ||
      original?.code === 'UND_ERR_HEADERS_TIMEOUT' ||
      original?.code === 'UND_ERR_CONNECT_TIMEOUT';

    // Native fetch reports malformed URLs as a TypeError with this root code.
    if (original?.code === 'ERR_INVALID_URL') {
      throw Object.assign(new Error('Invalid URL: ' + url), {
        code: 'ERR_INVALID_URL',
        cause: original,
      });
    }

    // Explicit caller cancellation is terminal; transport timeouts remain retryable.
    if (retryCount + 1 < retry && retryable === true && replayableBody === true && options.signal?.aborted !== true) {
      let delay = 500 * Math.pow(2, retryCount);
      try {
        await waitForRetry(delay, delayImplementation, options.signal);

        return fetchRequest(
          method,
          url,
          options,
          data,
          fetchImplementation,
          delayImplementation,
          retryCount + 1,
        );
      } catch (delayError) {
        // Report cancellation during backoff through the same structured-error boundary.
        error = delayError;
        original = error?.cause ?? error;
      }
    }

    throw Object.assign(
      new Error(
        method.toUpperCase() +
          ' ' +
          url +
          ' failed after ' +
          (retryCount + 1) +
          ' attempt' +
          (retryCount + 1 > 1 ? 's' : '') +
          ': ' +
          (typeof original?.message === 'string' && original.message !== '' ? original.message : String(original)),
      ),
      {
        code: original?.code,
        status: error?.status,
        body: error?.body,
        cause: original,
      },
    );
  }
}

/**
 * Wait between attempts while honoring caller cancellation.
 *
 * @param {number} delay Retry delay in milliseconds.
 * @param {function(number): Promise<*>} delayImplementation Selected delay implementation.
 * @param {AbortSignal|null} [signal] Caller cancellation signal.
 * @returns {Promise<void>} Resolves when another attempt may begin.
 * @throws {*} If the delay fails or the caller cancels.
 * @private
 */
async function waitForRetry(delay, delayImplementation, signal) {
  if (signal === undefined || signal === null) {
    await delayImplementation(delay);
    return;
  }

  signal.throwIfAborted();
  if (delayImplementation === wait) {
    // Cancel the native timer too, so it does not keep the process alive after abort.
    await wait(delay, undefined, { signal });
  } else {
    // Injected delays retain their one-argument contract and may not support cancellation.
    let onAbort;
    let cancellation = new Promise((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });

    try {
      await Promise.race([delayImplementation(delay), cancellation]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  // An injected delay can abort synchronously or while its resolution is queued.
  signal.throwIfAborted();
}

// Supported HTTP request methods exposed on the wrapper for callers.
fetchWrapper.GET = 'get';
fetchWrapper.POST = 'post';

// Export the fetch wrapper for use in other modules.
export { fetchWrapper };
