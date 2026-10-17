# fetchWrapper

`fetchWrapper` is a dependency-free Node.js module for GET and POST requests. It wraps the native Fetch API with per-attempt timeouts, caller cancellation, retries, automatic JSON request bodies, and structured errors. Successful requests return the native `Response` so callers control how the response body is read.

The repository is intended to be consumed as a Git submodule. It is not published as an npm package.

## Requirements

- Node.js 22, 24, or 26
- An environment providing the standard Fetch API

## Usage

Import the named export from `fetchWrapper.js`, adjusting the path to its location in your project:

```js
import { fetchWrapper } from './fetchWrapper.js';

const response = await fetchWrapper(fetchWrapper.GET, 'https://example.com/api/items', {
  timeout: 5000,
  retry: 3,
});

const items = await response.json();
```

Pass a plain object as the fourth argument to send JSON in a POST request:

```js
const response = await fetchWrapper(
  fetchWrapper.POST,
  'https://example.com/api/items',
  { timeout: 5000 },
  { name: 'Example', enabled: true },
);
```

## API

```js
await fetchWrapper(fetchWrapper.GET, url, options);
await fetchWrapper(fetchWrapper.POST, url, options, data);
```

### `method`

Use `fetchWrapper.GET` for GET requests and `fetchWrapper.POST` for POST requests. These constants expose the supported lowercase
`get` and `post` values. Unsupported methods return `undefined` without issuing a request.

### `url`

A non-empty URL string passed to the native Fetch API.

### `options`

Standard fetch options plus these wrapper options:

| Option    | Description                                                               |
| --------- | ------------------------------------------------------------------------- |
| `retry`   | Total number of attempts, including the initial request. Defaults to `1`. |
| `timeout` | Per-attempt timeout in milliseconds.                                      |

A supplied `signal` is preserved. When both `signal` and `timeout` are present, either can abort the request. A null signal is treated as absent when applying a timeout. Explicit caller cancellation also interrupts retry backoff and prevents another attempt.

Retries use exponential delays beginning at 500 milliseconds. HTTP retries are limited to status codes `408`, `429`, `500`, `502`, `503`, and `504`. Selected Fetch and Undici transport failures are also retried.

### `data`

For POST requests, a plain object is serialised as JSON and receives an `application/json` content type unless one is already present. Other supported Fetch body values pass through unchanged.

Streaming bodies, including web streams and Node.js streams, are sent once even when `retry` allows more attempts. They cannot be replayed safely. This also applies to streams supplied through `options.body`; final failures retain their HTTP or transport error details.

For streaming request bodies, pass `duplex: 'half'` in `options` as required by Node.js Fetch. The wrapper does not add this option automatically.

### Return value

Successful requests return the native `Response`. Unsupported methods, empty or non-string URLs, and options that fail the wrapper's plain-object validation return `undefined`. Omitted options default to `{}`. Malformed non-empty URL strings throw an error.

### Errors

Final HTTP and transport failures throw an `Error` containing:

| Property | Description                                         |
| -------- | --------------------------------------------------- |
| `code`   | HTTP status or transport error code when available. |
| `status` | HTTP response status when available.                |
| `body`   | Response text when it could be read.                |
| `cause`  | Original error.                                     |

## Testing dependencies

The optional fifth argument is reserved for deterministic tests and should not be mixed into request options:

```js
await fetchWrapper(fetchWrapper.GET, url, { retry: 2 }, undefined, {
  fetch: mockFetch,
  delay: async () => {},
});
```

Production callers should omit this argument.

## Development

Run the test suite from this repository's root:

```sh
node --test fetchWrapper.test.js
```

The implementation and tests use ES modules, Node.js built-ins, and the standard Fetch API. No dependency installation or build step is required to run the tests on the supported Node.js versions.

This repository has no `package.json` or npm scripts. Formatting and linting tools must be supplied separately; the repository includes Prettier and ESLint configuration files.
