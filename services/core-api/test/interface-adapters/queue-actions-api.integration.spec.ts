import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  StateMachine,
  StateSchema,
  StateTransitionRule,
  SystemConfiguration,
  BrandColor,
  DailyResetPolicy,
  EdgeRoutingLayout,
  EndSources,
  NodeActions,
  NodePositions,
  PrinterConfiguration,
  ServiceThemes,
  TerminalNodes,
  TvPanelLayout,
} from '../../src/domain/store-config';
import { Identifier } from '../../src/domain/shared';
import { Role, USER_REPOSITORY, type IUserRepository } from '../../src/domain/identity';
import { CreateUserUseCase } from '../../src/application/identity';
import {
  authHeader,
  bootstrapAuthedAdmin,
  clearRepos,
  createApp,
  http,
  repos,
  seedPrdConfig,
} from '../acceptance/_helpers';

/**
 * Integration: `GET /api/queue/actions` — the caller panel's dynamic action set.
 * The backend resolves, for every edge the manager configured, **which queue
 * command executes it**; the caller renders one button per entry and invokes
 * the named command rather than keeping its own client-side routing table.
 *
 * Boots the real Nest app on the in-memory persistence profile so the endpoint
 * is exercised through the real guards, the real `StateTransitionValidator`
 * (which reads the persisted `SystemConfiguration`), and the real
 * {@link DomainExceptionFilter}.
 */
describe('GET /api/queue/actions (integration — caller dynamic actions, FR-CLR-02)', () => {
  let app: INestApplication;
  let adminToken: string;
  let callerToken: string;

  /** Persists a system configuration carrying `machine` as the active graph. */
  async function seedStateMachine(machine: StateMachine): Promise<void> {
    const config = SystemConfiguration.reconstitute({
      id: Identifier.generate(),
      storeName: 'Toko Utama Surabaya',
      isInitialSetupCompleted: true,
      stateMachine: machine,
      dailyResetPolicy: DailyResetPolicy.DEFAULT,
      brandColor: BrandColor.DEFAULT,
      serviceThemes: ServiceThemes.DEFAULT,
      tvPanelLayout: TvPanelLayout.DEFAULT,
      edgeRoutingLayout: EdgeRoutingLayout.DEFAULT,
      nodePositions: NodePositions.DEFAULT,
      nodeActions: NodeActions.DEFAULT,
      terminalNodes: TerminalNodes.DEFAULT,
      endSources: EndSources.DEFAULT,
      printerConfiguration: PrinterConfiguration.DEFAULT,
    });
    await repos(app).systemConfig.save(config);
  }

  beforeAll(async () => {
    ({ app } = await createApp());
    adminToken = await bootstrapAuthedAdmin(app);
    // A caller-staff principal too — this endpoint's whole purpose is the
    // counter panel, so the non-admin role must reach it.
    const createUser = app.get(CreateUserUseCase);
    const userRepo = app.get(USER_REPOSITORY) as IUserRepository;
    if (!(await userRepo.findByUsername('petugas1'))) {
      await createUser.execute({
        username: 'petugas1',
        password: 'password123',
        role: Role.CALLER_STAFF,
      });
    }
    const login = await http(app)
      .post('/api/auth/login')
      .send({ username: 'petugas1', password: 'password123' });
    callerToken = login.body.token as string;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    clearRepos(app);
  });

  it('401s an unauthenticated request (same classification as GET /api/system/state-machine)', async () => {
    await seedPrdConfig(app);

    const res = await request(app.getHttpServer()).get('/api/queue/actions');

    expect(res.status).toBe(401);
  });

  it('409s before first-run setup, matching GET /api/system/state-machine', async () => {
    // `clearRepos` wiped the system configuration — the policy resolver throws
    // SystemNotConfiguredException, which the domain filter maps to 409.
    const res = await http(app).get('/api/queue/actions').set(authHeader(adminToken));

    expect(res.status).toBe(409);
  });

  it('serves the PRD §7 default graph to an authenticated caller-staff principal', async () => {
    await seedPrdConfig(app);

    const res = await http(app).get('/api/queue/actions').set(authHeader(callerToken));

    expect(res.status).toBe(200);
    expect(res.body.byStatus).toEqual({
      WAITING: [
        {
          from: 'WAITING',
          to: 'CALLING',
          actionLabel: 'Panggil Berikutnya',
          command: 'CALL_NEXT',
          unavailableReason: null,
        },
      ],
      CALLING: [
        {
          from: 'CALLING',
          to: 'SERVING',
          actionLabel: 'Mulai Melayani',
          command: 'SERVE',
          unavailableReason: null,
        },
        {
          from: 'CALLING',
          to: 'SKIPPED',
          actionLabel: 'Lewati / Absen',
          command: 'SKIP',
          unavailableReason: null,
        },
      ],
      SERVING: [
        {
          from: 'SERVING',
          to: 'COMPLETED',
          actionLabel: 'Selesai Layan',
          command: 'COMPLETE',
          unavailableReason: null,
        },
      ],
      SKIPPED: [
        {
          from: 'SKIPPED',
          to: 'CALLING',
          actionLabel: 'Panggil Ulang',
          command: 'RECALL',
          unavailableReason: null,
        },
      ],
      COMPLETED: [],
    });
  });

  it('serves the same graph to an admin principal', async () => {
    await seedPrdConfig(app);

    const res = await http(app).get('/api/queue/actions').set(authHeader(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.byStatus.WAITING[0].command).toBe('CALL_NEXT');
  });

  it('resolves a wizard-customised graph: custom states, transfer, re-announce, and a dead edge', async () => {
    await seedStateMachine(
      new StateMachine(
        StateSchema.of(['WAITING', 'CALLING', 'SERVING', 'SKIPPED', 'COMPLETED', 'PEMBAYARAN']),
        [
          StateTransitionRule.of('WAITING', 'CALLING', 'Panggil Berikutnya'),
          StateTransitionRule.of('CALLING', 'CALLING', 'Panggil Lagi'),
          StateTransitionRule.of('CALLING', 'SERVING', 'Mulai Melayani'),
          StateTransitionRule.of('CALLING', 'WAITING', 'Pindah Kategori'),
          StateTransitionRule.of('SERVING', 'PEMBAYARAN', 'Ke Pembayaran'),
          StateTransitionRule.of('SERVING', 'SERVING', 'Ulangi Layanan'),
          StateTransitionRule.of('PEMBAYARAN', 'COMPLETED', 'Selesai Layan'),
          // A dead edge: nothing can move an in-progress ticket back to CALLING.
          StateTransitionRule.of('PEMBAYARAN', 'CALLING', 'Panggil Kembali'),
        ],
      ),
    );

    const res = await http(app).get('/api/queue/actions').set(authHeader(callerToken));

    expect(res.status).toBe(200);
    const flat = Object.values(res.body.byStatus)
      .flat()
      .map((a: any) => [a.from, a.to, a.command, a.unavailableReason]);
    expect(flat).toEqual([
      ['WAITING', 'CALLING', 'CALL_NEXT', null],
      ['CALLING', 'CALLING', 'REANNOUNCE', null],
      ['CALLING', 'SERVING', 'SERVE', null],
      ['CALLING', 'WAITING', 'TRANSFER', null],
      ['SERVING', 'PEMBAYARAN', 'APPLY_TRANSITION', null],
      ['SERVING', 'SERVING', null, 'NO_STATUS_CHANGE'],
      ['PEMBAYARAN', 'COMPLETED', 'COMPLETE', null],
      ['PEMBAYARAN', 'CALLING', null, 'NO_COMMAND'],
    ]);
    // Custom + sink states are keyed even when they have no usable action.
    expect(res.body.byStatus.SKIPPED).toEqual([]);
    expect(res.body.byStatus.COMPLETED).toEqual([]);
  });

  it('leaves the existing read-only surface untouched (additive change)', async () => {
    await seedPrdConfig(app);

    const board = await http(app).get('/api/queue/board');
    const stateMachine = await http(app)
      .get('/api/system/state-machine')
      .set(authHeader(callerToken));

    expect(board.status).toBe(200);
    expect(board.body).toEqual({ active: [], waiting: [], waitingCount: 0 });
    expect(stateMachine.status).toBe(200);
    expect(stateMachine.body.transitions).toHaveLength(5);
    // The raw graph endpoint still returns the graph only — no `command` field
    // leaked into it.
    expect(stateMachine.body.transitions[0]).toEqual({
      from: 'WAITING',
      to: 'CALLING',
      actionLabel: 'Panggil Berikutnya',
    });
  });
});
