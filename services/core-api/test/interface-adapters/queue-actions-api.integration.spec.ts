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
import { Identifier, TransitionAction } from '../../src/domain/shared';
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
 * The backend publishes every edge the manager configured with the action they
 * declared for it; the caller renders one button per entry. Nothing about an
 * edge's meaning is resolved from its endpoints — that inference is the defect
 * this endpoint used to carry.
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
          action: 'UPDATE_STATUS',
          unavailableReason: null,
        },
      ],
      CALLING: [
        {
          from: 'CALLING',
          to: 'SERVING',
          actionLabel: 'Mulai Melayani',
          action: 'UPDATE_STATUS',
          unavailableReason: null,
        },
        {
          from: 'CALLING',
          to: 'SKIPPED',
          actionLabel: 'Lewati / Absen',
          action: 'UPDATE_STATUS',
          unavailableReason: null,
        },
      ],
      SERVING: [
        {
          from: 'SERVING',
          to: 'COMPLETED',
          actionLabel: 'Selesai Layan',
          action: 'UPDATE_STATUS',
          unavailableReason: null,
        },
      ],
      SKIPPED: [
        {
          from: 'SKIPPED',
          to: 'CALLING',
          actionLabel: 'Panggil Ulang',
          action: 'UPDATE_STATUS',
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
    expect(res.body.byStatus.WAITING[0].action).toBe('UPDATE_STATUS');
  });

  it('publishes a customised graph verbatim: custom states, a declared transfer, a re-announce, and a re-queue', async () => {
    await seedStateMachine(
      new StateMachine(
        StateSchema.of(['WAITING', 'CALLING', 'SERVING', 'SKIPPED', 'COMPLETED', 'PEMBAYARAN']),
        [
          StateTransitionRule.of('WAITING', 'CALLING', 'Panggil Berikutnya'),
          StateTransitionRule.of('CALLING', 'CALLING', 'Panggil Lagi'),
          StateTransitionRule.of('CALLING', 'SERVING', 'Mulai Melayani'),
          // Two edges with the SAME endpoints as each other's neighbours and
          // opposite meanings — the pair alone could never tell them apart.
          StateTransitionRule.of('CALLING', 'WAITING', 'Kembalikan ke Antrian'),
          StateTransitionRule.of(
            'SERVING',
            'WAITING',
            'Pindah Kategori',
            TransitionAction.TRANSFER_CATEGORY,
          ),
          StateTransitionRule.of('SERVING', 'PEMBAYARAN', 'Ke Pembayaran'),
          StateTransitionRule.of('SERVING', 'SERVING', 'Ulangi Layanan'),
          StateTransitionRule.of('PEMBAYARAN', 'COMPLETED', 'Selesai Layan'),
          // Once unroutable ("nothing moves an in-progress ticket back to
          // CALLING"); a per-ticket transition reaches it now.
          StateTransitionRule.of('PEMBAYARAN', 'CALLING', 'Panggil Kembali'),
        ],
      ),
    );

    const res = await http(app).get('/api/queue/actions').set(authHeader(callerToken));

    expect(res.status).toBe(200);
    const flat = Object.values(res.body.byStatus)
      .flat()
      .map((a: any) => [a.from, a.to, a.action, a.unavailableReason]);
    expect(flat).toEqual([
      ['WAITING', 'CALLING', 'UPDATE_STATUS', null],
      ['CALLING', 'CALLING', 'UPDATE_STATUS', null],
      ['CALLING', 'SERVING', 'UPDATE_STATUS', null],
      ['CALLING', 'WAITING', 'UPDATE_STATUS', null],
      ['SERVING', 'WAITING', 'TRANSFER_CATEGORY', null],
      ['SERVING', 'PEMBAYARAN', 'UPDATE_STATUS', null],
      ['SERVING', 'SERVING', 'UPDATE_STATUS', 'NO_STATUS_CHANGE'],
      ['PEMBAYARAN', 'COMPLETED', 'UPDATE_STATUS', null],
      ['PEMBAYARAN', 'CALLING', 'UPDATE_STATUS', null],
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
    // The raw graph endpoint returns the graph as configured — including each
    // edge's declared action, which is part of the definition, not a ruling
    // layered on top of it.
    expect(stateMachine.body.transitions[0]).toEqual({
      from: 'WAITING',
      to: 'CALLING',
      actionLabel: 'Panggil Berikutnya',
      action: 'UPDATE_STATUS',
    });
  });
});
