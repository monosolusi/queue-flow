/**
 * Sentinel `aggregateId` for system-wide domain events that are not owned by
 * any single aggregate (the daily reset rolls the whole sequence; a system
 * configuration save mutates the singleton config). `DomainEvent` requires an
 * `aggregateId`, so system events reference this stable shared constant rather
 * than a magic string — the wire mapper, the realtime broadcaster, and any
 * audit consumer key off it.
 *
 * Lives in the shared kernel so every bounded context's system events
 * (Queue's {@link DailyQueueResetEvent}, Store Config's
 * `SystemConfigurationChangedEvent`) reference the same sentinel without one
 * context importing another's internals (DIP / bounded-context anti-corruption).
 */
export const SYSTEM_AGGREGATE_ID = 'system';