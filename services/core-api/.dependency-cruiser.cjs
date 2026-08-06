/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  extends: 'dependency-cruiser/configs/recommended-strict',
  forbidden: [
    {
      // NFR-MNT-01 / DoD-1: the Domain layer must be free of ORM, HTTP
      // framework, and I/O library dependencies. No exceptions.
      name: 'domain-no-framework-imports',
      severity: 'error',
      from: { path: '^src/domain/' },
      to: {
        // dep-cruiser resolves bare specifiers to `node_modules/<pkg>/...`, so the
        // anchor must allow that prefix (without it the regex never matches and
        // the rule is a silent no-op). `node:` covers built-in modules. The
        // I/O built-ins (crypto/fs/net/http/child_process/https/tls) are listed
        // explicitly because the Domain layer must be pure TypeScript —
        // `node:crypto` in particular is the password-hashing / token primitive
        // and MUST stay in infrastructure behind a port (QUE-43), never in the
        // domain. The `(node:)?` prefix matches both `crypto` and `node:crypto`.
        path: '^(node:)?(node_modules/)?(@nestjs/.*|typeorm|@prisma/.*|pg|express|ws|reflect-metadata|mikro-orm|knex|sequelize|mongoose|fastify|crypto|fs|net|http|https|tls|child_process)',
      },
    },
    {
      // Domain may only depend on itself + node built-ins. It must never reach
      // into application, infrastructure, or interface-adapter layers.
      name: 'domain-isolation',
      severity: 'error',
      from: { path: '^src/domain/' },
      to: {
        path: '^src/(application|infrastructure|interface-adapters)/',
      },
    },
    {
      // Bounded-context anti-corruption: the Queue context must not import Store
      // Config internals. The only legitimate link between the two contexts is
      // Store Config -> Queue (Store Config implements the Queue-defined
      // ITransitionPolicy port). Shared types belong in the shared kernel.
      name: 'queue-no-store-config',
      severity: 'error',
      from: { path: '^src/domain/queue/' },
      to: { path: '^src/domain/store-config/' },
    },
    {
      // Bounded-context anti-corruption (QUE-43): the Identity context must not
      // import any other bounded context's internals. Identity (users/sessions/
      // auth) is self-contained — it shares only the shared kernel (Identifier,
      // Entity, ValueObject, DomainError). Cross-context coupling would let an
      // auth change ripple into queue/store-config/audit/reporting (or vice
      // versa), eroding the context boundaries the rest of the rules enforce.
      name: 'identity-anti-corruption',
      severity: 'error',
      from: { path: '^src/domain/identity/' },
      to: { path: '^src/domain/(queue|store-config|audit|reporting)/' },
    },
    {
      // Bounded-context anti-corruption (QUE-43), symmetric: no other bounded
      // context may import the Identity context's internals. The Queue/Store
      // Config/Audit/Reporting domains depend on the shared kernel, not on User
      // / session types — the authenticated principal is an interface-adapter
      // concern (attached to `req.user` by guards), never a domain dependency.
      name: 'no-context-imports-identity',
      severity: 'error',
      from: { path: '^src/domain/(queue|store-config|audit|reporting)/' },
      to: { path: '^src/domain/identity/' },
    },
    {
      // No circular imports within the domain.
      name: 'domain-no-circular',
      severity: 'error',
      from: { path: '^src/domain/' },
      to: { path: '^src/domain/', circular: true },
    },
    {
      // NFR-MNT-01 (Clean Architecture) applied to the Application layer: use
      // cases depend on domain ports, never on infrastructure concretions
      // (DIP). The interface-adapter layer wires concrete repositories in.
      name: 'application-no-infrastructure',
      severity: 'error',
      from: { path: '^src/application/' },
      to: { path: '^src/infrastructure/' },
    },
    {
      // NFR-MNT-01 (Clean Architecture) applied to the Application layer: use
      // cases must stay free of ORM / HTTP framework / I-O library imports
      // (mirrors `domain-no-framework-imports`). Enforced from QUE-30 onward
      // now that `pg` lives in the repo, so a use case can never reach for the
      // driver directly — it goes through the {@link ITransactionManager} /
      // repository ports defined in the domain. The I/O built-ins
      // (crypto/fs/net/http/child_process/https/tls) are banned too — a use
      // case that needs hashing/tokens depends on the {@link IPasswordHasher}
      // / {@link ITokenGenerator} ports (QUE-43), never on `node:crypto`.
      name: 'application-no-framework-imports',
      severity: 'error',
      from: { path: '^src/application/' },
      to: {
        // dep-cruiser resolves bare specifiers to `node_modules/<pkg>/...`, so the
        // anchor must allow that prefix (without it the regex never matches and
        // the rule is a silent no-op — it previously passed a real `@nestjs/common`
        // import in queue-event-dispatcher). `node:` covers built-in modules.
        path: '^(node:)?(node_modules/)?(@nestjs/.*|typeorm|@prisma/.*|pg|express|ws|reflect-metadata|mikro-orm|knex|sequelize|mongoose|fastify|crypto|fs|net|http|https|tls|child_process)',
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ['exports'] },
    exclude: { path: ['test/', '\\.spec\\.', '\\.d\\.ts$'] },
  },
};