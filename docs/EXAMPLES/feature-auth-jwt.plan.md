# Mission: Replace session-cookie auth with JWT (access + refresh) in the Node.js API

## Sprint 1: Replace session-cookie auth with JWT {#sprint-1}
**Goal:** All authenticated routes verify a signed JWT access token; refresh-token rotation and logout (revocation) are wired and covered by tests.
**Work front:** auth

### Epic 1.1: JWT issuance and verification {#sprint-1.epic-1}
**Goal:** The service can sign access tokens, verify them on every protected route, and reject expired or tampered tokens with the correct status code.

#### Task 1.1.1: Add `jose` dependency and create signing key configuration {#sprint-1.epic-1.task-1}
**Goal:** `jose` is installed and a single `getSigningKey()` helper reads the secret from `process.env.JWT_SECRET` with a clear failure when unset.
**Acceptance criteria:**
- `jose` appears in `package.json` dependencies and `npm ci` resolves it cleanly
- `getSigningKey()` throws with message `JWT_SECRET not set` when the env var is missing
- A unit test under `tests/auth/signing-key.test.js` exercises both the success and missing-env paths
**Review:** [security-reviewer, js-reviewer]
**Validate:** `npm test`
**Work front:** auth

#### Task 1.1.2: Implement `signAccessToken` and `verifyAccessToken` helpers {#sprint-1.epic-1.task-2}
**Goal:** A signed access token round-trips through verification, expired tokens are rejected, and tampered tokens fail signature verification.
**Acceptance criteria:**
- `signAccessToken({sub, role})` returns a string that `verifyAccessToken(token)` decodes back to the same `{sub, role}` payload
- `verifyAccessToken` throws a typed `TokenExpiredError` for tokens past their `exp` claim (verified by unit test using a 1-second TTL)
- `verifyAccessToken` throws a typed `TokenSignatureError` when the token body is mutated after signing (verified by a tampered-token unit test)
**Review:** [security-reviewer, js-reviewer]
**Validate:** `npm test`
**Work front:** auth

#### Task 1.1.3: Wire `requireAuth` middleware onto protected routes {#sprint-1.epic-1.task-3}
**Goal:** Every route currently requiring an authenticated session is instead guarded by `requireAuth`, which extracts the bearer token, verifies it, and attaches `req.user` for downstream handlers.
**Acceptance criteria:**
- `requireAuth` rejects requests with no `Authorization` header with HTTP 401 and body `{error: "missing_token"}`
- `requireAuth` rejects expired tokens with HTTP 401 and body `{error: "token_expired"}`
- An integration test hits a protected route with a valid token and receives 200 with the expected handler response
**Review:** [security-reviewer, js-reviewer]
**Validate:** `npm test`
**Work front:** middleware

### Epic 1.2: Refresh-token rotation and logout {#sprint-1.epic-2}
**Goal:** Refresh tokens rotate on every use and revoked tokens cannot be reused after logout.

#### Task 1.2.1: Implement refresh-token rotation flow {#sprint-1.epic-2.task-1}
**Goal:** `POST /auth/refresh` accepts a valid refresh token, issues a fresh access+refresh pair, and invalidates the old refresh token so it cannot be reused.
**Acceptance criteria:**
- On a valid refresh request, the response contains a new access token and a new refresh token whose `jti` claim differs from the inbound token's `jti`
- A second `POST /auth/refresh` using the previously-rotated refresh token returns HTTP 401 with body `{error: "refresh_token_reused"}`
- Integration test in `tests/auth/refresh.test.js` covers both the happy path and the reuse-rejection path
**Review:** [security-reviewer, js-reviewer]
**Validate:** `npm test`
**Work front:** auth

#### Task 1.2.2: Implement logout via refresh-token revocation list {#sprint-1.epic-2.task-2}
**Goal:** `POST /auth/logout` adds the caller's refresh-token `jti` to a revocation store; subsequent refresh attempts using that `jti` are rejected.
**Acceptance criteria:**
- `POST /auth/logout` returns HTTP 204 and the refresh token's `jti` is present in the revocation store after the call
- A `POST /auth/refresh` request using a revoked refresh token returns HTTP 401 with body `{error: "refresh_token_revoked"}`
- Integration test in `tests/auth/logout.test.js` covers logout followed by refresh-attempt rejection
**Review:** [security-reviewer, js-reviewer]
**Validate:** `npm test`
**Work front:** auth
