# Changelog

All notable changes to `fetchWrapper` are documented in this file.

The project follows [Semantic Versioning](https://semver.org/).

## 2026/09/21

### Added

- Public `fetchWrapper.GET` and `fetchWrapper.POST` method constants
- JSDoc contracts for wrapper options, injectable dependencies, and request functions

### Changed

- Kept retry attempt tracking private to the internal `fetchRequest()` implementation instead of embedding `_retryCount` in caller options
- Treated `retry` as immutable configuration defining the maximum number of attempts
- Added regression coverage confirming retries do not mutate caller options or pass wrapper bookkeeping to Fetch

## 2026/09/17

### Added

- Shared GET and POST request wrapper for Accfactory projects
- Per-attempt timeouts combined with caller-provided cancellation signals
- Exponential retries for selected transient HTTP and transport failures
- Failed-response body cleanup before retries
- Automatic JSON serialization with case-insensitive content-type handling
- Structured final errors containing available code, status, body, and cause details
- Injectable Fetch and delay boundaries for deterministic unit testing
