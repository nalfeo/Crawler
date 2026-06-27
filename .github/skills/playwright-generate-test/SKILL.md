---
name: playwright-generate-test
description: 'Generate a Playwright test based on a scenario using Playwright MCP'
---

# Test Generation with Playwright MCP

Your goal is to generate a Playwright test based on the provided scenario after completing all prescribed steps.

## Specific Instructions

- You are given a scenario, and you need to generate a playwright test for it. If the user does not provide a scenario, you will ask them to provide one.
- DO NOT generate test code prematurely or based solely on the scenario without completing all prescribed steps.
- DO run steps one by one using the tools provided by the Playwright MCP.
- Only after all steps are completed, emit a TypeScript end-to-end test based on message history. This repo runs E2E tests with **Vitest**, not `@playwright/test`: import the test hooks from `vitest` (`describe`, `it`, `expect`, `beforeAll`, `afterAll`) and drive the browser with the `playwright` library directly (e.g. `import { chromium, type Browser, type Page } from 'playwright'`). There is no `playwright.config.*` and `@playwright/test` is not a dependency.
- Save the generated test as `tests/e2e/<scenario>.test.ts`
- Execute it with `npm run test:e2e` (`vitest run --project e2e`) and iterate until it passes
