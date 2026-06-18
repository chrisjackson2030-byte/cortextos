/**
 * src/utils/exit-code-classifier.ts
 *
 * Pure classifier for a registry component's exit-code contract.
 *
 * Root cause it guards (INC-2026-06-18-reconciler-exit2-misread): a nonzero exit
 * code was treated as a failure by default. The reconciler
 * (ai.jarvis.desired-state-reconciler) exits 2 by DESIGN to mean "drift detected
 * and fixed" — a success-with-action, not a failure. Classifying it as "failing"
 * was a misread of the exit-code contract.
 *
 * THE RULE: a nonzero exit code is a FAILURE only if the component's declared
 * `failure_exit_codes` contains it. success_exit_codes and warning_exit_codes are
 * NOT failures regardless of being nonzero. A code in none of the three declared
 * sets is "unknown" (and must be investigated, not assumed-failed).
 */

export type ExitCodeContract = {
  success_exit_codes?: number[] | null;
  warning_exit_codes?: number[] | null;
  failure_exit_codes?: number[] | null;
};

export type ExitClassification = 'success' | 'warning' | 'failure' | 'unknown';

/**
 * Classify an observed exit code against a component record's declared contract.
 *
 * Precedence: failure_exit_codes wins (a code explicitly declared a failure is a
 * failure even if mistakenly also listed elsewhere), then success, then warning.
 * A code absent from all three declared sets is "unknown" — never silently a
 * failure just because it is nonzero.
 */
export function classifyExitCode(
  record: ExitCodeContract | null | undefined,
  code: number,
): ExitClassification {
  const failure = record?.failure_exit_codes ?? [];
  const success = record?.success_exit_codes ?? [];
  const warning = record?.warning_exit_codes ?? [];

  if (failure.includes(code)) return 'failure';
  if (success.includes(code)) return 'success';
  if (warning.includes(code)) return 'warning';
  return 'unknown';
}

/**
 * Convenience predicate: is this observed code a genuine failure for this
 * component? A nonzero code is a failure ONLY when failure_exit_codes contains it.
 */
export function isFailureExit(
  record: ExitCodeContract | null | undefined,
  code: number,
): boolean {
  return classifyExitCode(record, code) === 'failure';
}
