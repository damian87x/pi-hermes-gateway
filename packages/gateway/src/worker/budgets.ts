export type BudgetAdmitResult =
  | { ok: true }
  | { ok: false; error: { code: "budget_exhausted"; message: string } };

export class DailyInvocationBudget {
  private used = 0;
  constructor(private readonly limit: number) {}

  admit(): BudgetAdmitResult {
    if (this.used >= this.limit) {
      return { ok: false, error: { code: "budget_exhausted", message: "daily invocation budget exhausted" } };
    }
    this.used += 1;
    return { ok: true };
  }
}
