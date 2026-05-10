# Mission: Migrate codebase from pydantic v1 to v2 with green test suite

## Sprint 1: Migrate codebase from pydantic v1 to v2 {#sprint-1}
**Goal:** All pydantic-using modules compile and pass tests under pydantic v2; no v1-era APIs remain in `src/`.
**Work front:** models

### Epic 1.1: Update model definitions {#sprint-1.epic-1}
**Goal:** Replace v1 BaseModel surface (`.dict()`, `.json()`, `Config` inner class, `Field` signature changes) with v2 equivalents across all model modules.

#### Task 1.1.1: Replace `.dict()` and `.json()` calls with `.model_dump()` and `.model_dump_json()` {#sprint-1.epic-1.task-1}
**Goal:** Every call to the v1 serialization API is rewritten to the v2 method names so models serialize correctly under pydantic 2.x.
**Acceptance criteria:**
- `grep -rn "\.dict(" src/` returns zero matches outside of pure-Python `dict()` constructor calls
- `grep -rn "\.json(" src/` returns zero matches against pydantic models
- All call sites previously using `.dict()` now use `.model_dump()` and round-trip with `model_validate(model.model_dump())`
**Review:** [python-reviewer, migration-reviewer]
**Validate:** `pytest tests/`
**Work front:** models

#### Task 1.1.2: Update `Field` signatures for v2 (drop deprecated `const`, swap `regex` for `pattern`) {#sprint-1.epic-1.task-2}
**Goal:** All `Field(...)` declarations use the v2 keyword surface; pydantic emits no DeprecationWarnings for Field arguments during the test run.
**Acceptance criteria:**
- `grep -rn "regex=" src/` returns zero matches inside `Field(...)` calls (replaced with `pattern=`)
- `grep -rn "const=" src/` returns zero matches inside `Field(...)` calls
- `pytest -W error::DeprecationWarning tests/` exits 0
**Review:** [python-reviewer]
**Validate:** `pytest tests/`
**Work front:** models

#### Task 1.1.3: Convert `class Config:` inner classes to `model_config = ConfigDict(...)` {#sprint-1.epic-1.task-3}
**Goal:** Every model previously declaring an inner `Config` class now uses the v2 `model_config = ConfigDict(...)` form with equivalent settings preserved.
**Acceptance criteria:**
- `grep -rn "class Config:" src/` returns zero matches in modules that import from pydantic
- Every model that previously had a `Config` block has a `model_config = ConfigDict(...)` assignment with the same options carried over (`orm_mode` → `from_attributes`, `allow_population_by_field_name` → `populate_by_name`, etc.)
- `pytest tests/` exits 0 with no schema-shape regressions
**Review:** [python-reviewer, migration-reviewer]
**Validate:** `pytest tests/`
**Work front:** models

### Epic 1.2: Update validators {#sprint-1.epic-2}
**Goal:** All v1 validator decorators are converted to v2 equivalents and continue to enforce the same invariants on the same fields.

#### Task 1.2.1: Convert `@validator(...)` decorators to `@field_validator(...)` {#sprint-1.epic-2.task-1}
**Goal:** Each `@validator`-decorated method is rewritten as a `@field_validator` classmethod with the same field targets and validation logic.
**Acceptance criteria:**
- `grep -rn "@validator(" src/` returns zero matches
- Every previously-validated field still has an equivalent `@field_validator` covering it (verified by the existing validator test cases passing untouched)
- `pytest tests/` exits 0 with the same number of validator-related test cases passing as before the migration
**Review:** [python-reviewer]
**Validate:** `pytest tests/`
**Work front:** validators

#### Task 1.2.2: Convert `@root_validator(...)` decorators to `@model_validator(mode="after")` {#sprint-1.epic-2.task-2}
**Goal:** Cross-field invariants previously enforced by `@root_validator` now run under `@model_validator` with the correct mode and return the model instance.
**Acceptance criteria:**
- `grep -rn "@root_validator" src/` returns zero matches
- Each converted validator returns `self` (for `mode="after"`) or the values dict (for `mode="before"`) per the v2 contract
- `pytest tests/` exits 0 and the cross-field invariant tests still fail when invariants are violated (negative-path coverage preserved)
**Review:** [python-reviewer, migration-reviewer]
**Validate:** `pytest tests/`
**Work front:** validators
