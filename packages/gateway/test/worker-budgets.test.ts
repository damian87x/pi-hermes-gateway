import assert from "node:assert/strict";
import { test } from "node:test";
import { DailyInvocationBudget } from "../dist/worker/budgets.js";

test("worker-budgets: admits while under the daily invocation limit", () => {
  const budget = new DailyInvocationBudget(2);
  assert.equal(budget.admit().ok, true);
  assert.equal(budget.admit().ok, true);
});

test("worker-budgets: rejects admission once the daily invocation limit is exhausted", () => {
  const budget = new DailyInvocationBudget(1);
  assert.equal(budget.admit().ok, true);
  const result = budget.admit();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "budget_exhausted");
});

test("worker-budgets: stays rejected on further admits, no auto-reset", () => {
  const budget = new DailyInvocationBudget(1);
  budget.admit();
  budget.admit();
  const result = budget.admit();
  assert.equal(result.ok, false);
});
