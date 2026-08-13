import { DEFAULT_PRINTER_CONFIGURATION, type PrinterCutMode, type PrinterMode, type PrinterPaperWidth, type PrinterConfigurationDto } from '../api/types';

/** The selectable printer modes, in stable display order (matches the
 *  `/printer-config` mode radio group). */
export const PRINTER_MODES: readonly PrinterMode[] = ['chrome', 'network-escpos'];
/** The selectable paper widths, in stable display order. */
export const PRINTER_PAPER_WIDTHS: readonly PrinterPaperWidth[] = [58, 80];
/** The selectable cut modes, in stable display order (matches the radio group). */
export const PRINTER_CUT_MODES: readonly PrinterCutMode[] = ['full', 'partial', 'none'];

/** Default TCP port the ESC/POS thermal printers listen on (the de-facto
 *  standard, mirrored by core-api's `PrinterConfiguration.DEFAULT`). */
export const DEFAULT_PRINTER_PORT = 9100;

/**
 * Client-side printer-configuration validation. The `/printer-config` page
 * renders constrained radios + a port `min`/`max` input, so an invalid value is
 * not constructable through the UI — but a direct API prefill (or a corrupt
 * GET) could carry an unknown enum or an out-of-range port. This guard mirrors
 * the UI-reachable subset of the backend `PrinterConfiguration` value object
 * (`core-api`'s `domain/store-config/value-objects/printer-configuration.ts`):
 * mode / paperWidth / cutMode are the known enums, port is an integer in
 * 1..65535, and `host` is non-empty (and whitespace-free) when mode is
 * `network-escpos`. Chrome mode is always valid (host/port are irrelevant).
 * The two grammars stay in lock-step for the UI-reachable subset; a divergence
 * is a bug (the QUE-34 mirroring rule).
 *
 * @returns a list of Indonesian error strings for `config`; empty when valid
 *  (mirrors `validateBrandColor` / `validateServiceThemes` `string[]` contract).
 */
export function validatePrinterConfiguration(config: PrinterConfigurationDto): string[] {
  const errors: string[] = [];
  if (config.mode !== 'chrome' && config.mode !== 'network-escpos') {
    errors.push('Mode printer tidak valid.');
  }
  if (config.paperWidth !== 58 && config.paperWidth !== 80) {
    errors.push('Lebar kertas harus 58mm atau 80mm.');
  }
  if (config.cutMode !== 'full' && config.cutMode !== 'partial' && config.cutMode !== 'none') {
    errors.push('Mode gunting tidak valid.');
  }
  // Number.isInteger narrows at runtime but not in TS (see memory
  // `number-isfinite-not-a-type-predicate`); the explicit comparisons below are
  // the runtime check — no further narrowing is needed on `port` after them.
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    errors.push('Port harus bilangan bulat 1–65535.');
  }
  if (config.mode === 'network-escpos') {
    if (config.host.trim() === '') {
      errors.push('Host printer wajib diisi untuk mode jaringan.');
    } else if (/\s/.test(config.host)) {
      errors.push('Host tidak boleh mengandung spasi.');
    }
  }
  return errors;
}

/** True when `config` passes every {@link validatePrinterConfiguration} check. */
export function isValidPrinterConfiguration(config: PrinterConfigurationDto): boolean {
  return validatePrinterConfiguration(config).length === 0;
}

/**
 * Coerces an untrusted/partial `printerConfiguration` from a GET projection
 * into a complete {@link PrinterConfigurationDto}, defaulting an unknown/missing
 * field to its default (mirrors the backend VO's permissive reconstitution).
 * Used at `toForm` so the form always carries a complete config even if the
 * server returned a degraded shape (same belt-and-suspenders pattern as
 * `coerceServiceThemes` / `coerceTvGridLayout`).
 */
export function coercePrinterConfiguration(
  raw: Partial<PrinterConfigurationDto> | undefined | null,
): PrinterConfigurationDto {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PRINTER_CONFIGURATION };
  const mode: PrinterMode = raw.mode === 'network-escpos' ? 'network-escpos' : 'chrome';
  const paperWidth: PrinterPaperWidth = raw.paperWidth === 58 ? 58 : 80;
  const cutMode: PrinterCutMode =
    raw.cutMode === 'full' || raw.cutMode === 'none' ? raw.cutMode : 'partial';
  let port = typeof raw.port === 'number' ? raw.port : DEFAULT_PRINTER_CONFIGURATION.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    port = DEFAULT_PRINTER_CONFIGURATION.port;
  }
  const host = typeof raw.host === 'string' ? raw.host : '';
  return { mode, paperWidth, host, port, cutMode };
}