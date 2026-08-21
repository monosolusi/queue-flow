import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { ActivationTransportFailure } from '../../src/domain/licensing/license-activation-client.port';
import {
  ACTIVATION_URL_ENV,
  DEFAULT_ACTIVATION_URL,
  HttpLicenseActivationClient,
} from '../../src/infrastructure/licensing/http-license-activation-client';

const REQUEST = {
  key: '7K3M9-QRSTV-WXYZ0-123AB',
  installationId: '11111111-2222-4333-8444-555555555555',
  claims: { boardUuid: 'a'.repeat(64) },
  productId: 'qms',
  majorVersion: 1,
};

interface Handler {
  (body: Record<string, unknown>): {
    status: number;
    payload: string;
    contentType?: string;
    /** Held back this long before replying, to provoke a client-side timeout. */
    delayMs?: number;
  };
}

/**
 * A real HTTP server rather than a mocked `fetch`. The failure modes that
 * matter here — a connection refused, a body that is not JSON, a reply with no
 * token — are properties of the transport, and a stubbed `fetch` would only
 * ever prove that the stub returns what it was told to.
 */
async function withServer(
  handler: Handler,
  run: (url: string, received: Record<string, unknown>[]) => Promise<void>,
): Promise<void> {
  const received: Record<string, unknown>[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      received.push(body);
      const { status, payload, contentType, delayMs } = handler(body);
      const reply = () => {
        if (res.destroyed) return;
        res.writeHead(status, { 'Content-Type': contentType ?? 'application/json' });
        res.end(payload);
      };
      if (delayMs === undefined) reply();
      else setTimeout(reply, delayMs).unref();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/v1/activations`, received);
  } finally {
    // A held-back reply leaves its socket open, and close() alone would wait
    // for it — so drop connections explicitly or the suite hangs.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('HttpLicenseActivationClient — the happy path', () => {
  it('returns the token and sends exactly what the server needs to bind it', async () => {
    await withServer(
      () => ({ status: 200, payload: JSON.stringify({ token: '-----BEGIN QMS LICENSE-----ok' }) }),
      async (url, received) => {
        const result = await new HttpLicenseActivationClient(url).redeem(REQUEST);

        expect(result).toEqual({ ok: true, armoredToken: '-----BEGIN QMS LICENSE-----ok' });
        expect(received).toHaveLength(1);
        expect(received[0]).toEqual({
          key: REQUEST.key,
          installationId: REQUEST.installationId,
          claims: REQUEST.claims,
          product: { id: 'qms', majorVersion: 1 },
        });
      },
    );
  });

  it('sends an empty claim map rather than omitting it when no hardware is readable', async () => {
    // A VM or a missing bind-mount is a legitimate state that must yield an
    // unbound licence, not a failed request.
    await withServer(
      () => ({ status: 200, payload: JSON.stringify({ token: 'tok' }) }),
      async (url, received) => {
        await new HttpLicenseActivationClient(url).redeem({ ...REQUEST, claims: {} });
        expect(received[0].claims).toEqual({});
      },
    );
  });
});

describe('HttpLicenseActivationClient — the server said no', () => {
  it.each([
    ['KEY_UNKNOWN', 404, ActivationTransportFailure.KEY_UNKNOWN],
    ['KEY_ALREADY_USED', 409, ActivationTransportFailure.KEY_ALREADY_USED],
    ['KEY_REVOKED', 403, ActivationTransportFailure.KEY_REVOKED],
    ['KEY_EXPIRED', 410, ActivationTransportFailure.KEY_EXPIRED],
    ['PRODUCT_MISMATCH', 409, ActivationTransportFailure.PRODUCT_MISMATCH],
  ])('maps %s to its own failure code', async (code, status, expected) => {
    await withServer(
      () => ({ status, payload: JSON.stringify({ code }) }),
      async (url) => {
        const result = await new HttpLicenseActivationClient(url).redeem(REQUEST);
        expect(result).toMatchObject({ ok: false, failure: expected });
      },
    );
  });

  it('falls back to SERVER_ERROR for a code it has never heard of', async () => {
    // Guessing would be worse than admitting ignorance: an unknown code routed
    // to KEY_UNKNOWN would tell a customer to re-type a key that was fine.
    await withServer(
      () => ({ status: 400, payload: JSON.stringify({ code: 'QUOTA_EXCEEDED_TIER_3' }) }),
      async (url) => {
        const result = await new HttpLicenseActivationClient(url).redeem(REQUEST);
        expect(result).toMatchObject({
          ok: false,
          failure: ActivationTransportFailure.SERVER_ERROR,
        });
      },
    );
  });

  it('treats a 5xx as SERVER_ERROR', async () => {
    await withServer(
      () => ({ status: 503, payload: 'upstream down' , contentType: 'text/plain' }),
      async (url) => {
        const result = await new HttpLicenseActivationClient(url).redeem(REQUEST);
        expect(result).toMatchObject({
          ok: false,
          failure: ActivationTransportFailure.SERVER_ERROR,
        });
      },
    );
  });
});

describe('HttpLicenseActivationClient — the transport failed', () => {
  it('reports OFFLINE when nothing is listening', async () => {
    // Port 1 on loopback: reserved, never bound, refuses immediately. This is
    // the shape of "the shop has no internet", which is the most likely
    // outcome of the whole feature and must not read as a bad key.
    const result = await new HttpLicenseActivationClient(
      'http://127.0.0.1:1/v1/activations',
    ).redeem(REQUEST);

    expect(result).toMatchObject({ ok: false, failure: ActivationTransportFailure.OFFLINE });
  });

  it('reports OFFLINE when the host does not resolve', async () => {
    const result = await new HttpLicenseActivationClient(
      'https://activation.invalid/v1/activations',
    ).redeem(REQUEST);

    expect(result).toMatchObject({ ok: false, failure: ActivationTransportFailure.OFFLINE });
  });

  it('reports TIMEOUT — distinct from OFFLINE, because a retry is worth it', async () => {
    await withServer(
      () => ({ status: 200, payload: JSON.stringify({ token: 'too late' }), delayMs: 2_000 }),
      async (url) => {
        // The server is reachable and answers — just not in time. Loopback is
        // far too fast to provoke this by shrinking the budget alone, so the
        // reply is held back explicitly.
        const result = await new HttpLicenseActivationClient(url, 40).redeem(REQUEST);
        expect(result).toMatchObject({ ok: false, failure: ActivationTransportFailure.TIMEOUT });
      },
    );
  });
});

describe('HttpLicenseActivationClient — a 200 that is not usable', () => {
  it('rejects a 200 carrying no token', async () => {
    await withServer(
      () => ({ status: 200, payload: JSON.stringify({ ok: true }) }),
      async (url) => {
        const result = await new HttpLicenseActivationClient(url).redeem(REQUEST);
        expect(result).toMatchObject({
          ok: false,
          failure: ActivationTransportFailure.SERVER_ERROR,
        });
      },
    );
  });

  it('rejects a 200 whose body is a captive-portal HTML page', async () => {
    // Shop wifi behind a hotel-style portal answers 200 with HTML. Parsing must
    // fail into SERVER_ERROR, never throw out of redeem().
    await withServer(
      () => ({ status: 200, payload: '<html>Sign in to continue</html>', contentType: 'text/html' }),
      async (url) => {
        const result = await new HttpLicenseActivationClient(url).redeem(REQUEST);
        expect(result).toMatchObject({
          ok: false,
          failure: ActivationTransportFailure.SERVER_ERROR,
        });
      },
    );
  });

  it('rejects a 200 whose token is blank', async () => {
    await withServer(
      () => ({ status: 200, payload: JSON.stringify({ token: '   ' }) }),
      async (url) => {
        const result = await new HttpLicenseActivationClient(url).redeem(REQUEST);
        expect(result).toMatchObject({
          ok: false,
          failure: ActivationTransportFailure.SERVER_ERROR,
        });
      },
    );
  });
});

describe('HttpLicenseActivationClient — endpoint resolution', () => {
  const original = process.env[ACTIVATION_URL_ENV];

  afterEach(() => {
    if (original === undefined) delete process.env[ACTIVATION_URL_ENV];
    else process.env[ACTIVATION_URL_ENV] = original;
  });

  it('falls back to the compiled-in URL when the variable is unset or blank', () => {
    delete process.env[ACTIVATION_URL_ENV];
    expect(new HttpLicenseActivationClient()).toBeInstanceOf(HttpLicenseActivationClient);
    process.env[ACTIVATION_URL_ENV] = '   ';
    expect(new HttpLicenseActivationClient()).toBeInstanceOf(HttpLicenseActivationClient);
    expect(DEFAULT_ACTIVATION_URL).toMatch(/^https:\/\//);
  });

  it('honours the variable with NO NODE_ENV gate', async () => {
    // Unlike QMS_LICENSE_TRUSTED_KEY. The URL defends nothing — a hostile
    // server still cannot produce a token signed by a trusted key — so gating
    // it would buy no security and would cost the acceptance suite its seam.
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await withServer(
        () => ({ status: 200, payload: JSON.stringify({ token: 'from-env-url' }) }),
        async (url) => {
          process.env[ACTIVATION_URL_ENV] = url;
          const result = await new HttpLicenseActivationClient().redeem(REQUEST);
          expect(result).toEqual({ ok: true, armoredToken: 'from-env-url' });
        },
      );
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });
});
