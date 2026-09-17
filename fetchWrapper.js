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
// Code version 2026.09.17
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { setTimeout as wait } from 'node:timers/promises';

const RETRYABLE_HTTP_STATUS = [408, 429, 500, 502, 503, 504];

async function fetchWrapper(method, url, options = {}, data, dependencies = {}) {
  // Retain the existing Accfactory contract for unsupported request inputs.
  if (
    (method !== 'get' && method !== 'post') ||
    typeof url !== 'string' ||
    url === '' ||
    options === null ||
    typeof options !== 'object' ||
    options.constructor !== Object
  ) {
    return;
  }

  // retry represents total attempts rather than additional retries.
  let configuredRetry = Number(options.retry);
  let retry = Number.isFinite(configuredRetry) === true && configuredRetry > 0 ? Math.max(1, Math.floor(configuredRetry)) : 1;
  let retryCount = Number.isFinite(Number(options._retryCount)) === true ? Number(options._retryCount) : 0;

  // Keep injectable test boundaries separate from options passed to fetch.
  let fetchImplementation = dependencies?.fetch ?? globalThis.fetch;
  let delayImplementation = dependencies?.delay ?? wait;
  if (typeof fetchImplementation !== 'function') {
    throw new TypeError('A fetch implementation is required');
  }
  if (typeof delayImplementation !== 'function') {
    throw new TypeError('A delay implementation must be a function');
  }

  // Remove wrapper-only values from a clone, leaving caller options unchanged.
  let fetchOptions = {
    ...options,
    method,
  };
  delete fetchOptions.retry;
  delete fetchOptions.timeout;
  delete fetchOptions._retryCount;

  // Apply timeout per attempt while preserving caller-controlled cancellation.
  if (Number.isFinite(Number(options.timeout)) === true && Number(options.timeout) > 0) {
    let timeoutSignal = globalThis.AbortSignal.timeout(Math.floor(Number(options.timeout)));
    fetchOptions.signal = options.signal === undefined ? timeoutSignal : globalThis.AbortSignal.any([options.signal, timeoutSignal]);
  }

  if (method === 'post' && data !== undefined) {
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

  try {
    let response = await fetchImplementation(url, fetchOptions);

    if (response?.ok === false) {
      let retryableStatus = RETRYABLE_HTTP_STATUS.includes(response.status) === true ? true : false;

      if (retry > 1 && retryableStatus === true && options.signal?.aborted !== true) {
        // Release the body before retrying so fetch can reuse the connection.
        try {
          await response.body?.cancel();
        } catch {
          // A cleanup failure does not supersede the original HTTP failure.
        }

        let delay = 500 * Math.pow(2, retryCount);
        await delayImplementation(delay);

        return fetchWrapper(
          method,
          url,
          {
            ...options,
            retry: retry - 1,
            _retryCount: retryCount + 1,
          },
          data,
          dependencies,
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
      original?.code === 'UND_ERR_CONNECT_TIMEOUT'
        ? true
        : false;

    // Native fetch reports malformed URLs as a TypeError with this root code.
    if (original?.code === 'ERR_INVALID_URL') {
      throw Object.assign(new Error('Invalid URL: ' + url), {
        code: 'ERR_INVALID_URL',
        cause: original,
      });
    }

    // Explicit caller cancellation is terminal; transport timeouts remain retryable.
    if (retry > 1 && retryable === true && options.signal?.aborted !== true) {
      let delay = 500 * Math.pow(2, retryCount);
      await delayImplementation(delay);

      return fetchWrapper(
        method,
        url,
        {
          ...options,
          retry: retry - 1,
          _retryCount: retryCount + 1,
        },
        data,
        dependencies,
      );
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

export { fetchWrapper };
