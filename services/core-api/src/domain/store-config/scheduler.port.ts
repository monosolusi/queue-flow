/**
 * Application-side port for the automatic daily-reset scheduler (QUE-32 /
 * FR-ENG-05). The {@link SaveSystemConfigurationUseCase} calls `reArm()` after a
 * configuration save commits so a manager's edit to the `DailyResetPolicy`
 * (mode or cron expression) takes effect **immediately, without a process
 * restart** — mirroring the per-execution `ITransitionPolicyResolver` precedent
 * ("config edit takes effect on the very next transition without restarting").
 *
 * This is a non-repository domain port (like `ITransitionPolicyResolver`): the
 * implementation owns the cron I/O (`SchedulerRegistry`, `CronJob`) and lives in
 * infrastructure, while use cases depend on this abstraction (DIP) and never on
 * the concrete scheduler — `application-no-infrastructure` holds. The port
 * carries no arguments: `reArm()` re-reads the persisted singleton
 * `SystemConfiguration` and reconciles the armed cron (arm / disarm / no-op),
 * so both the boot-armed path (`onModuleInit`) and the post-save path share one
 * implementation. Pure interface + Symbol token — no framework/IO imports, so
 * domain purity (NFR-MNT-01) holds.
 *
 * Re-arm is invoked **post-commit**: the save use case calls `reArm()` only after
 * `ITransactionManager.runInTransaction` resolves, so a rolled-back save never
 * re-arms to a policy that was not persisted (NFR-REL-02). It is also gated on
 * the policy actually having changed (or the initial setup), so an edit that
 * touches only categories/routing does not churn the running cron.
 */

export const DAILY_RESET_SCHEDULER = Symbol('DAILY_RESET_SCHEDULER');

export interface IDailyResetSchedulerPort {
  /**
   * Reconcile the armed daily-reset cron against the currently persisted
   * `DailyResetPolicy`. Idempotent: a no-op when the desired cron already
   * matches the armed one. Disarms when the policy is `MANUAL` or the system is
   * unconfigured; arms (or re-arms) when it is `AUTOMATIC_CRON` with a valid
   * expression.
   */
  reArm(): Promise<void>;
}