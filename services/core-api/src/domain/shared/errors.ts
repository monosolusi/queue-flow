/**
 * Base class for all domain errors. Domain errors carry no dependency on any
 * framework or transport — they are plain, message-bearing exceptions that
 * interface-adapter layers map to the appropriate HTTP/WS response.
 */
export abstract class DomainError extends Error {
  public readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    // Restore the prototype chain so `instanceof` works across TS compilation.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a {@link QueueTicket} (or any stateful aggregate) is asked to move
 * to a status that the active {@link StateTransitionRule} set does not permit.
 * Maps to FR-ENG-02.
 */
export class InvalidStateTransitionException extends DomainError {
  constructor(from: string, to: string) {
    super(
      `Illegal state transition: '${from}' -> '${to}' is not allowed by the active state machine.`,
      'INVALID_STATE_TRANSITION',
    );
  }
}

/**
 * Thrown when a value object is constructed with data that violates its
 * invariant (e.g. a malformed ticket number).
 */
export class InvalidValueObjectException extends DomainError {
  constructor(detail: string) {
    super(`Invalid value object: ${detail}`, 'INVALID_VALUE_OBJECT');
  }
}

/**
 * Thrown when a required aggregate or entity cannot be located.
 */
export class EntityNotFoundException extends DomainError {
  constructor(entity: string, id: string) {
    super(`${entity} not found for id '${id}'`, 'ENTITY_NOT_FOUND');
  }
}

/**
 * Thrown when an operation requires the active state machine but the store's
 * {@link SystemConfiguration} has not been initialized yet — i.e. the first-run
 * setup wizard has not completed. Supports the first-run guard FR-WZD-01: queue
 * control actions are unavailable until the system is configured.
 */
export class SystemNotConfiguredException extends DomainError {
  constructor() {
    super(
      'System configuration is not initialized — complete the first-run setup wizard first.',
      'SYSTEM_NOT_CONFIGURED',
    );
  }
}

/**
 * Thrown when a command carries an argument that is structurally valid but
 * violates a business guardrail — e.g. a transaction-log cleanup retention
 * window below the enforced floor (QUE-25 / FR-ADM-02). Distinct from
 * {@link InvalidValueObjectException} (a malformed value object) and
 * {@link InvalidStateTransitionException} (a forbidden state move): the value
 * is well-formed, just not permitted by a use-case-level business rule. Maps to
 * 400 Bad Request — the caller can fix the argument and retry.
 */
export class InvalidArgumentException extends DomainError {
  constructor(detail: string) {
    super(`Invalid argument: ${detail}`, 'INVALID_ARGUMENT');
  }
}

/**
 * Thrown by `LoginUseCase` when the supplied credentials do not match a known
 * user (unknown username OR wrong password). A single, deliberately vague
 * message avoids leaking which of the two failed (username enumeration
 * mitigation). Maps to 401 Unauthorized via `DomainExceptionFilter`.
 */
export class InvalidCredentialsException extends DomainError {
  constructor() {
    super('Invalid username or password.', 'INVALID_CREDENTIALS');
  }
}

/**
 * Thrown by `CreateUserUseCase` / `SetupInitialAdminUseCase` when a username
 * is already taken — a well-formed value that violates a uniqueness
 * constraint. Maps to 409 Conflict via `DomainExceptionFilter`.
 */
export class DuplicateUserException extends DomainError {
  constructor(username: string) {
    super(`Username '${username}' is already taken.`, 'DUPLICATE_USER');
  }
}