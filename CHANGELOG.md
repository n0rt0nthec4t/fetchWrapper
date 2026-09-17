# Changelog

All notable changes to `fetchWrapper` are documented in this file.

The project follows [Semantic Versioning](https://semver.org/).

## 1.0.0 - 2026-09-17

### Added

- Shared GET and POST request wrapper for Accfactory projects
- Per-attempt timeouts combined with caller-provided cancellation signals
- Exponential retries for selected transient HTTP and transport failures
- Failed-response body cleanup before retries
- Automatic JSON serialization with case-insensitive content-type handling
- Structured final errors containing available code, status, body, and cause details
- Injectable Fetch and delay boundaries for deterministic unit testing
