# fetchWrapper

`fetchWrapper` is a dependency-free HTTP request helper shared by the Accfactory projects. It wraps the Node.js Fetch API with consistent timeout, cancellation, retry, JSON-body, response-cleanup, and structured-error behaviour.

The repository is intended to be consumed as a Git submodule. It is not published as an npm package.

## Requirements

- Node.js 22, 24, or 26
- An environment providing the standard Fetch API

## Adding the submodule

Add the repository beneath `src` in an Accfactory project:

```sh
git submodule add https://github.com/n0rt0nthec4t/fetchWrapper.git src/fetchWrapper
git commit -m "Add fetchWrapper submodule"
```

Initialize it after cloning an existing project:

```sh
git submodule update --init --recursive
```

To update a project to the latest fetchWrapper commit:

```sh
git submodule update --remote src/fetchWrapper
git add src/fetchWrapper
git commit -m "Update fetchWrapper"
```

## Building an Accfactory project

The existing Accfactory build layout can flatten the shared file into `dist`:

```text
copyfiles -u 2 src/fetchWrapper/fetchWrapper.js dist
```

Application source can then use the same imports as the generated `dist` layout:

```js
import { fetchWrapper } from './fetchWrapper.js';
```

Code in a `plugins` directory uses:

```js
import { fetchWrapper } from '../fetchWrapper.js';
```

## API

```js
await fetchWrapper(method, url, options, data);
```

### `method`

Supported values are lowercase `get` and `post`. Unsupported methods return `undefined` without issuing a request.

### `url`

A non-empty URL string passed to the native Fetch API.

### `options`

Standard fetch options plus these wrapper options:

| Option    | Description                                                               |
| --------- | ------------------------------------------------------------------------- |
| `retry`   | Total number of attempts, including the initial request. Defaults to `1`. |
| `timeout` | Per-attempt timeout in milliseconds.                                      |

A supplied `signal` is preserved. When both `signal` and `timeout` are present, either can abort the request. Explicit caller cancellation is not retried.

Retries use exponential delays beginning at 500 milliseconds. HTTP retries are limited to status codes `408`, `429`, `500`, `502`, `503`, and `504`. Selected Fetch and Undici transport failures are also retried.

### `data`

For POST requests, a plain object is serialized as JSON and receives an `application/json` content type unless one is already present. Other supported Fetch body values pass through unchanged.

### Return value

Successful requests return the native `Response`. Invalid helper inputs return `undefined` for compatibility with existing Accfactory callers.

### Errors

Final HTTP failures throw an `Error` containing:

| Property | Description                                         |
| -------- | --------------------------------------------------- |
| `code`   | HTTP status or transport error code when available. |
| `status` | HTTP response status when available.                |
| `body`   | Response text when it could be read.                |
| `cause`  | Original error.                                     |

## Testing dependencies

The optional fifth argument is reserved for deterministic tests and should not be mixed into request options:

```js
await fetchWrapper('get', url, { retry: 2 }, undefined, {
  fetch: mockFetch,
  delay: async () => {},
});
```

Production callers should omit this argument.

## Development

This repository deliberately has no `package.json`. The consuming project owns the Node.js module type, formatting, linting, and test tooling. After adding the submodule, run verification from the consuming project's root:

```sh
npm run lint
node --test src/fetchWrapper/fetchWrapper.test.js
```

The implementation and tests use only Node.js built-ins and the standard Fetch API.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
