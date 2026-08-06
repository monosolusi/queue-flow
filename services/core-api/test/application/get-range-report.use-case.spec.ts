import {
  RangeQueueReport,
  type IReportQueryPort,
} from '../../src/domain/reporting';
import { Identifier } from '../../src/domain/shared';
import { InvalidArgumentException } from '../../src/domain/shared/errors';
import {
  GetRangeReportUseCase,
  MAX_RANGE_DAYS,
  daySpan,
  projectRangeReport,
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

/** Builds a small {@link RangeQueueReport} for projection assertions. */
function sampleRange(): RangeQueueReport {
  return new RangeQueueReport(
    Identifier.generate(),
    '2026-08-01',
    '2026-08-02',
    4,
    1200,
    30000,
    [
      { date: '2026-08-01', totalTickets: 3, avgWaitTimeMs: 1000, avgServiceTimeMs: 28000, ticketsServed: 2 },
      { date: '2026-08-02', totalTickets: 1, avgWaitTimeMs: 2000, avgServiceTimeMs: 40000, ticketsServed: 1 },
    ],
    [
      { categoryId: 'cat-a-id', code: 'A', totalTickets: 3, avgWaitTimeMs: 1000, avgServiceTimeMs: 28000 },
      { categoryId: 'cat-b-id', code: 'B', totalTickets: 1, avgWaitTimeMs: 2000, avgServiceTimeMs: 40000 },
    ],
    [{ counterId: 1, ticketsServed: 3, avgServiceTimeMs: 30000 }],
  );
}

describe('GetRangeReportUseCase (FR-ADM-03 / QUE-44)', () => {
  it('returns null when the query port has no report for the range', async () => {
    const useCase = new GetRangeReportUseCase(fakeReportQuery());
    expect(await useCase.execute({ from: '2026-08-01', to: '2026-08-02' })).toBeNull();
  });

  it('projects the read model to the transport DTO without domain leakage', async () => {
    const useCase = new GetRangeReportUseCase(
      fakeReportQuery({ rangeReport: async () => sampleRange() }),
    );

    const dto = await useCase.execute({ from: '2026-08-01', to: '2026-08-02' });

    expect(dto).toEqual({
      from: '2026-08-01',
      to: '2026-08-02',
      totalTickets: 4,
      avgWaitTimeMs: 1200,
      avgServiceTimeMs: 30000,
      perDay: [
        { date: '2026-08-01', totalTickets: 3, avgWaitTimeMs: 1000, avgServiceTimeMs: 28000, ticketsServed: 2 },
        { date: '2026-08-02', totalTickets: 1, avgWaitTimeMs: 2000, avgServiceTimeMs: 40000, ticketsServed: 1 },
      ],
      perCategory: [
        { categoryId: 'cat-a-id', code: 'A', totalTickets: 3, avgWaitTimeMs: 1000, avgServiceTimeMs: 28000 },
        { categoryId: 'cat-b-id', code: 'B', totalTickets: 1, avgWaitTimeMs: 2000, avgServiceTimeMs: 40000 },
      ],
      perCounter: [{ counterId: 1, ticketsServed: 3, avgServiceTimeMs: 30000 }],
    });
  });

  it('throws InvalidArgumentException for a malformed from date', async () => {
    const useCase = new GetRangeReportUseCase(fakeReportQuery());
    await expect(
      useCase.execute({ from: '2026-8-1', to: '2026-08-02' }),
    ).rejects.toBeInstanceOf(InvalidArgumentException);
  });

  it('throws InvalidArgumentException for a malformed to date', async () => {
    const useCase = new GetRangeReportUseCase(fakeReportQuery());
    await expect(
      useCase.execute({ from: '2026-08-01', to: 'not-a-date' }),
    ).rejects.toBeInstanceOf(InvalidArgumentException);
  });

  it('throws InvalidArgumentException when from > to', async () => {
    const useCase = new GetRangeReportUseCase(fakeReportQuery());
    await expect(
      useCase.execute({ from: '2026-08-02', to: '2026-08-01' }),
    ).rejects.toBeInstanceOf(InvalidArgumentException);
  });

  it('rejects a span exceeding MAX_RANGE_DAYS (91 days) but allows exactly 90', async () => {
    const useCase = new GetRangeReportUseCase(
      fakeReportQuery({ rangeReport: async () => sampleRange() }),
    );
    // 90-day span is allowed — the port is consulted (returns the sample, whose
    // bounds differ but projection still runs; the guard is on the command span).
    await expect(
      useCase.execute({ from: '2026-01-01', to: '2026-03-31' }),
    ).resolves.toBeDefined();
    // 91-day span is rejected before the port is consulted.
    const querySpy = fakeReportQuery({ rangeReport: async () => sampleRange() });
    const useCase91 = new GetRangeReportUseCase(querySpy);
    await expect(
      useCase91.execute({ from: '2026-01-01', to: '2026-04-01' }),
    ).rejects.toBeInstanceOf(InvalidArgumentException);
  });

  it('daySpan counts inclusive local days (same-day = 1, 7-day range = 7)', () => {
    expect(daySpan('2026-08-01', '2026-08-01')).toBe(1);
    expect(daySpan('2026-08-01', '2026-08-07')).toBe(7);
  });

  it('MAX_RANGE_DAYS is 90', () => {
    expect(MAX_RANGE_DAYS).toBe(90);
  });

  it('projectRangeReport maps every slice', () => {
    const dto = projectRangeReport(sampleRange());
    expect(dto.from).toBe('2026-08-01');
    expect(dto.perDay).toHaveLength(2);
    expect(dto.perCategory).toHaveLength(2);
    expect(dto.perCounter).toHaveLength(1);
  });
});