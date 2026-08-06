import { SetMetadata } from '@nestjs/common';

/** Metadata key marking a route as public (skips {@link AuthGuard}/{@link RolesGuard}). */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route (or controller) as **public** — exempt from {@link AuthGuard}
 * and {@link RolesGuard}. Use on endpoints that must be reachable without a
 * session: kiosk/tv reads, login, setup-status, health, the TV board read.
 * Applied at the method level to override a class-level guard (e.g. the TV
 * `GET /api/queue/board` on the otherwise-authenticated `QueueController`).
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);