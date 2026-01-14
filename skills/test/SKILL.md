---
name: test
description: Write meaningful tests that validate user-facing behavior. Use when writing tests, improving test coverage, or when asked to "write tests", "add tests", or "test this". Focuses on real workflows over implementation details.
allowed-tools: [Read, Grep, Glob, Edit, Write, Bash, Task]
---

# Test Writing Guide

## What Makes a Great Test

A great test covers behavior users depend on. It tests a feature that, if broken, would frustrate or block users. It validates real workflows - not implementation details. It catches regressions before users do.

**Do NOT write tests just to increase coverage.** Use coverage as a guide to find UNTESTED USER-FACING BEHAVIOR.

## What NOT to Test

If uncovered code is not worth testing (boilerplate, unreachable error branches, internal plumbing), skip it rather than writing low-value tests.

## Process

1. **Detect test framework**: Check `package.json` for vitest, jest, mocha, playwright, etc. Look at existing test files to match patterns.

2. **Find existing test patterns**: Search for test utilities, fixtures, and helpers in the codebase. Match the existing style.

3. **Identify user-facing behavior**: What would break the user experience if it failed? Focus there.

4. **Write ONE meaningful test** that validates the feature works correctly for users.

5. **Run tests**: Execute the test suite to verify the new test passes and doesn't break existing tests.

6. **Commit**: Use message format `test(<scope>): <describe user behavior tested>`

## Test Quality Checklist

- [ ] Tests user-visible behavior, not implementation details
- [ ] Would catch a real regression
- [ ] Uses existing test utilities/patterns from the codebase
- [ ] Has a descriptive name explaining the behavior
- [ ] Runs reliably (no flaky assertions)
