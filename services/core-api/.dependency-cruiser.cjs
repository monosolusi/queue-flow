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
        path: '^(node:)?(@nestjs/.*|typeorm|@prisma/.*|pg|express|ws|reflect-metadata|mikro-orm|knex|sequelize|mongoose|fastify)',
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
      // repository ports defined in the domain.
      name: 'application-no-framework-imports',
      severity: 'error',
      from: { path: '^src/application/' },
      to: {
        path: '^(node:)?(@nestjs/.*|typeorm|@prisma/.*|pg|express|ws|reflect-metadata|mikro-orm|knex|sequelize|mongoose|fastify)',
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