/**
 * Wire contract between kiosk-service and core-api. These types mirror the
 * DTOs core-api exposes over REST. There is no shared package yet, so the
 * contract is duplicated here intentionally — the ISP boundary means the kiosk
 * only knows the slice of the API it consumes (categories + ticket creation;
 * never admin/reporting/caller-snapshot DTOs).
 */

/** A category the visitor can pick, returned by `GET /api/categories` (FR-KSK-01). */
export interface CategoryDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/**
 * The newly issued ticket, returned by `POST /api/tickets` (FR-ENG-01 / QUE-9).
 * The kiosk displays `ticketNumber` (e.g. `A-001`); `status` is `WAITING`.
 */
export interface CreatedTicketDto {
  readonly ticketId: string;
  readonly ticketNumber: string;
  readonly categoryId: string;
  readonly status: string;
}