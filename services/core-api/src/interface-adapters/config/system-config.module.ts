import { Module } from '@nestjs/common';
import { TRANSITION_POLICY_RESOLVER } from '../../domain/queue';
import { SYSTEM_CONFIGURATION_REPOSITORY } from '../../domain/store-config';
import { PersistenceModule } from '../../infrastructure/persistence/persistence.module';
import { StateTransitionValidator } from './state-transition.validator';

/**
 * Wires the active-state-machine resolver (QUE-2). Provides the domain
 * {@link TRANSITION_POLICY_RESOLVER} port bound to {@link StateTransitionValidator},
 * which reads the singleton `SystemConfiguration` and yields its active
 * `StateMachine` as the {@link ITransitionPolicy} the queue command use cases
 * validate every transition against.
 *
 * The validator stays a framework-free class (no `@Inject`/`@Injectable` — it
 * stays decoupled from Nest, consistent with the interface-adapter seam), so it
 * is provided via a factory that receives the {@link ISystemConfigurationRepository}
 * port from {@link PersistenceModule}. The resolver is exported so the
 * use-case wiring modules ({@link QueueOperationsModule}) can inject it.
 *
 * Lives here (interface-adapters) — not in domain or application — because it is
 * the anti-corruption seam between the Store-Config context (where the state
 * machine is configured) and the Queue use cases (which depend only on the
 * `ITransitionPolicyResolver` port). dep-cruiser permits interface-adapters →
 * infrastructure/domain.
 */
@Module({
  imports: [PersistenceModule.forRoot()],
  providers: [
    {
      provide: TRANSITION_POLICY_RESOLVER,
      inject: [SYSTEM_CONFIGURATION_REPOSITORY],
      useFactory: (config) => new StateTransitionValidator(config),
    },
  ],
  exports: [TRANSITION_POLICY_RESOLVER],
})
export class SystemConfigModule {}