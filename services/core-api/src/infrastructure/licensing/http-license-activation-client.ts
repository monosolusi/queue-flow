import {
  ActivationTransportFailure,
  type ActivationRedemption,
  type ILicenseActivationClient,
  type RedemptionResult,
} from '../../domain/licensing/license-activation-client.port';

/**
 * Where activation keys are redeemed. Compiled in, like the trusted keys — but
 * for a completely different reason, and with a completely different level of
 * protection.
 *
 * This is NOT a security boundary. A customer who repoints it at their own
 * server gains nothing: whatever comes back still has to carry a signature from
 * a key in {@link TRUSTED_SIGNING_KEYS}, and they do not have the private half.
 * Because it defends nothing, it is an ordinary environment variable with no
 * `NODE_ENV` gate — unlike `QMS_LICENSE_TRUSTED_KEY`, which does defend
 * something and therefore does have one. That also makes it the seam the
 * acceptance suite points at a local fake.
 */
export const ACTIVATION_URL_ENV = 'QMS_LICENSE_ACTIVATION_URL';
export const DEFAULT_ACTIVATION_URL = 'https://license.monosolusi.id/v1/activations';

/**
 * Long enough for a phone tether on a bad day, short enough that a technician
 * standing at the counter does not conclude the machine has hung.
 */
export const ACTIVATION_TIMEOUT_MS = 15_000;

/**
 * Server error codes → the remediation the manager is shown. An exhaustive map
 * built from the enum's own members, so a code the server invents later cannot
 * silently land on the wrong Indonesian screen — it falls to SERVER_ERROR,
 * which tells the truth ("something on our side is wrong") instead of guessing.
 */
const FAILURE_BY_CODE: Readonly<Record<string, ActivationTransportFailure>> = {
  KEY_UNKNOWN: ActivationTransportFailure.KEY_UNKNOWN,
  KEY_ALREADY_USED: ActivationTransportFailure.KEY_ALREADY_USED,
  KEY_REVOKED: ActivationTransportFailure.KEY_REVOKED,
  KEY_EXPIRED: ActivationTransportFailure.KEY_EXPIRED,
  PRODUCT_MISMATCH: ActivationTransportFailure.PRODUCT_MISMATCH,
};

/**
 * Redeems an activation key over HTTPS.
 *
 * This is the ONE outbound call the whole system makes, and it happens once,
 * during installation. Once the signed token it returns is stored, every later
 * evaluation reads that token from the database — so the shop runs with the WAN
 * cable unplugged forever after, which is the product's promise (NFR-REL-01, as
 * amended: no internet at runtime; one call at activation time).
 *
 * **No retry, deliberately.** Redeeming can consume a seat on the server. A
 * client-side retry after an ambiguous timeout could burn a customer's only
 * activation without anyone asking for it, so a second attempt is left to the
 * person who can see the screen and press the button again.
 */
export class HttpLicenseActivationClient implements ILicenseActivationClient {
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(url: string = resolveUrl(), timeoutMs: number = ACTIVATION_TIMEOUT_MS) {
    this.url = url;
    this.timeoutMs = timeoutMs;
  }

  public async redeem(request: ActivationRedemption): Promise<RedemptionResult> {
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          key: request.key,
          installationId: request.installationId,
          claims: request.claims,
          product: { id: request.productId, majorVersion: request.majorVersion },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // A store with no internet is the single most likely failure here, and
      // "OFFLINE" is the only message that leads a technician to the right fix.
      // A timeout is reported separately because it means the opposite: there
      // IS a network, so pressing the button again is worth doing.
      //
      // Classified by reading `name` off the value rather than by `instanceof
      // Error`. `AbortSignal.timeout()` rejects with a DOMException built by
      // Node's internals, and an `instanceof` check against the *calling*
      // realm's Error returns false whenever the two realms differ — under
      // Jest, in a worker thread, inside a vm context. That mis-filed every
      // timeout as OFFLINE, which is the one confusion this enum exists to
      // prevent: it would send a technician hunting for a network that is
      // working fine.
      return {
        ok: false,
        failure: isTimeout(error)
          ? ActivationTransportFailure.TIMEOUT
          : ActivationTransportFailure.OFFLINE,
        detail: describe(error),
      };
    }

    const body = await readJson(response);

    if (!response.ok) {
      const code = typeof body?.code === 'string' ? body.code : '';
      return {
        ok: false,
        failure: FAILURE_BY_CODE[code] ?? ActivationTransportFailure.SERVER_ERROR,
        detail: `activation server responded ${response.status}${code ? ` (${code})` : ''}`,
      };
    }

    const token = body?.token;
    if (typeof token !== 'string' || token.trim().length === 0) {
      // A 200 with no token is the server malfunctioning, not the key being
      // bad. Saying SERVER_ERROR keeps the customer from re-typing a key that
      // was never the problem.
      return {
        ok: false,
        failure: ActivationTransportFailure.SERVER_ERROR,
        detail: 'activation server returned 200 without a licence token',
      };
    }

    return { ok: true, armoredToken: token };
  }
}

/** Duck-typed on purpose — see the classification note in `redeem`. */
function isTimeout(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

function describe(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : String(error);
}

function resolveUrl(): string {
  const configured = process.env[ACTIVATION_URL_ENV];
  return configured !== undefined && configured.trim().length > 0
    ? configured.trim()
    : DEFAULT_ACTIVATION_URL;
}

/**
 * Never throws: a proxy or captive portal answering with an HTML error page is
 * a real thing that happens on shop networks, and it must surface as
 * SERVER_ERROR rather than crash the activation request.
 */
async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await response.json();
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
