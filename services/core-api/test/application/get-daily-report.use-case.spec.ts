import {
  CounterPerformance,
  DailyQueueReport,
  type IReportQueryPort,
} from '../../src/domain/reporting';
import { Identifier } from '../../src/domain/shared';
import {
  GetCounterPerformanceUseCase,
  GetDailyReportUseCase,
} from '../../src/application/reporting';

/** A controllable fake {@link IReportQueryPort} for unit tests. */
function fakeReportQuery(overrides: Partial<IReportQueryPort> = {}): IReportQueryPort {
  return {
    dailyReport: async () => null,
    counterPerformance: async () => null,
    rangeReport: async () => null,
    ...overrides,
  };
}

describe('GetDailyReportUseCase (FR-ADM-03 / QUE-26)', () => {
  it('returns null when the query port has no report for the date', async () => {
    const useCase = new GetDailyReportUseCase(fakeReportQuery());
    expect(await useCase.execute({ date: '2026-08-01' })).toBeNull();
  });

  it('projects the read model to the transport DTO without domain leakage', async () => {
    const report = new DailyQueueReport(
      Identifier.generate(),
      '2026-08-01',
      4,
      1200,
      30000,
      [
        {
          categoryId: 'cat-a-id',
          code: 'A',
          categoryName: 'Loket Umum',
          totalTickets: 3,
          avgWaitTimeMs: 1000,
          avgServiceTimeMs: 28000,
        },
        {
          categoryId: 'cat-b-id',
          code: 'B',
          categoryName: 'Prioritas Lansia',
          totalTickets: 1,
          avgWaitTimeMs: 2000,
          avgServiceTimeMs: 40000,
        },
      ],
    );
    const useCase = new GetDailyReportUseCase(
      fakeReportQuery({ dailyReport: async () => report }),
    );

    const dto = await useCase.execute({ date: '2026-08-01' });

    expect(dto).toEqual({
      date: '2026-08-01',
      totalTickets: 4,
      avgWaitTimeMs: 1200,
      avgServiceTimeMs: 30000,
      perCategory: [
        { categoryId: 'cat-a-id', code: 'A', categoryName: 'Loket Umum', totalTickets: 3, avgWaitTimeMs: 1000, avgServiceTimeMs: 28000 },
        { categoryId: 'cat-b-id', code: 'B', categoryName: 'Prioritas Lansia', totalTickets: 1, avgWaitTimeMs: 2000, avgServiceTimeMs: 40000 },
      ],
    });
  });
});

describe('GetCounterPerformanceUseCase (FR-ADM-03 / QUE-26)', () => {
  it('returns null when the counter served nothing that day', async () => {
    const useCase = new GetCounterPerformanceUseCase(fakeReportQuery());
    expect(await useCase.execute({ counterId: 1, date: '2026-08-01' })).toBeNull();
  });

  it('projects the read model to the transport DTO', async () => {
    const perf = new CounterPerformance(Identifier.generate(), 2, '2026-08-01', 5, 42000);
    const useCase = new GetCounterPerformanceUseCase(
      fakeReportQuery({ counterPerformance: async () => perf }),
    );

    expect(await useCase.execute({ counterId: 2, date: '2026-08-01' })).toEqual({
      counterId: 2,
      date: '2026-08-01',
      ticketsServed: 5,
      avgServiceTimeMs: 42000,
    });
  });
});