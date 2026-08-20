/**
 * Test-suite defaults, applied before every spec file.
 *
 * Licence enforcement is switched OFF by default here. The APP_GUARD refuses
 * mutating requests on an unlicensed store, which is exactly right in
 * production and exactly wrong for the ~12 suites that boot the whole app to
 * test ticketing, routing or realtime — none of which are about licensing, and
 * all of which would otherwise have to mint and install a signed licence just
 * to reach the code they exist to cover.
 *
 * The enforcement path itself is NOT left untested: `licensing.acceptance.spec.ts`
 * turns this back on and drives the real ladder end to end (unlicensed store
 * refuses a ticket -> activate -> ticket succeeds). A spec that wants
 * enforcement simply sets this to anything other than 'off' in `beforeAll`,
 * because `isEnforcementDisabled()` reads `process.env` per call.
 *
 * This switch cannot be used in production: it also requires
 * `NODE_ENV !== 'production'`, and the Dockerfile pins `NODE_ENV=production` in
 * every shipped image.
 */
process.env.QMS_LICENSE_ENFORCEMENT ??= 'off';
