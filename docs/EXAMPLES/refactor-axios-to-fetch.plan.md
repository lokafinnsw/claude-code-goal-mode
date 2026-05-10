# Mission: Refactor HTTP client from axios to native fetch with green test suite

## Sprint 1: Refactor HTTP client from axios to fetch {#sprint-1}
**Goal:** Production code no longer depends on axios; all outbound HTTP traffic uses the native fetch API with equivalent behavior and test coverage.
**Work front:** infra

### Epic 1.1: Replace axios with native fetch end-to-end {#sprint-1.epic-1}
**Goal:** Drop the axios dependency, rewrite the request helper, normalize response-shape access, and update test mocks so the suite passes against the new client.

#### Task 1.1.1: Remove axios from package.json and lockfile {#sprint-1.epic-1.task-1}
**Goal:** axios is no longer listed as a runtime or dev dependency; install runs cleanly without it.
**Acceptance criteria:**
- `axios` is absent from `package.json` `dependencies` and `devDependencies`
- `npm ci` exits 0 and `package-lock.json` contains no `axios` entry (verified by `grep -c '"axios"' package-lock.json` returning 0)
- `grep -rn "from 'axios'" src/` and `grep -rn "require('axios')" src/` both return zero matches
**Review:** [js-reviewer]
**Validate:** `npm test`
**Work front:** infra

#### Task 1.1.2: Rewrite the central request helper to use fetch {#sprint-1.epic-1.task-2}
**Goal:** The shared `httpRequest()` helper in `src/lib/http.js` issues requests via the native `fetch` API with equivalent timeout, header, and JSON-body behavior to the previous axios implementation.
**Acceptance criteria:**
- `httpRequest({method, url, body, headers, timeoutMs})` uses `fetch` and an `AbortController` for the timeout path
- A timeout test hitting a slow endpoint with `timeoutMs=10` rejects with a `RequestTimeoutError` within 50ms
- The helper sets `Content-Type: application/json` automatically when `body` is a non-string object, mirroring the prior axios behavior
**Review:** [js-reviewer]
**Validate:** `npm test`
**Work front:** infra

#### Task 1.1.3: Update response-shape handling (`response.data` becomes `await response.json()`) {#sprint-1.epic-1.task-3}
**Goal:** All call sites that previously read `response.data` from axios now correctly parse the fetch `Response` body, with non-2xx responses raising the same error shape as before.
**Acceptance criteria:**
- `grep -rn "response.data" src/` returns zero matches against the new helper's call sites
- The helper rejects on non-2xx responses with an `HttpError` carrying `{status, body}` matching the prior contract (verified by a 500-response test case)
- All previously-passing unit tests for callers of `httpRequest` pass without modification to their assertions on the parsed response body
**Review:** [js-reviewer]
**Validate:** `npm test`
**Work front:** infra

#### Task 1.1.4: Update test mocks (axios-mock-adapter -> MSW or fetch-mock) {#sprint-1.epic-1.task-4}
**Goal:** Test setup no longer references axios-mock-adapter; HTTP traffic in tests is intercepted via MSW (or fetch-mock) and the suite passes.
**Acceptance criteria:**
- `axios-mock-adapter` is removed from `package.json` devDependencies
- `grep -rn "axios-mock-adapter" tests/` returns zero matches
- `npm test` exits 0 with the full suite green and at least the previously-passing test count
**Review:** [js-reviewer]
**Validate:** `npm test`
**Work front:** infra
