import { toDateKey } from '../../src/application/queue';
import { ResetDailyQueueUseCase } from '../../src/application/queue';
import { SYSTEM_AGGREGATE_ID } from '../../src/domain/queue';
import { spyDispatcher } from './test-doubles';

const FIXED_NOW = 1_700_000_000_000;
const EXPECTED_DATE = toDateKey(FIXED_NOW);

/** A minimal mock sequence repo — only `resetDaily` is exercised here. */
function mockSequences(): any {
  return {
    resetDaily: jest.fn(async () => undefined),
    nextTicketNumber: jest.fn(),
    currentSequence: jest.fn(),
  };
}

describe('ResetDailyQueueUseCase (daily reset engine — FR-ENG-05)', () => {
  let sequences: ReturnType<typeof mockSequences>;
  let dispatcher: ReturnType<typeof spyDispatcher>;
  let useCase: ResetDailyQueueUseCase;

  beforeEach(() => {
    sequences = mockSequences();
    dispatcher = spyDispatcher();
    useCase = new ResetDailyQueueUseCase(sequences, dispatcher, () => FIXED_NOW);
  });

  it('rolls the per-day sequence back to resetTo for today (derived from the clock)', async () => {
    const result = await useCase.execute({ resetTo: 1 });

    expect(result).toEqual({ status: 'reset', date: EXPECTED_DATE, resetTo: 1 });
    expect(sequences.resetDaily).toHaveBeenCalledTimes(1);
    expect(sequences.resetDaily).toHaveBeenCalledWith(EXPECTED_DATE, 1);
  });

  it('emits a SYSTEM_RESET event carrying resetTo and the date, via dispatchEvents', async () => {
    await useCase.execute({ resetTo: 5 });

    // System reset is not an aggregate-root operation, so it is published through
    // dispatchEvents (free-standing domain events), not dispatch (FR-ENG-04/05).
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    expect(dispatcher.dispatchEvents).toHaveBeenCalledTimes(1);

    const events = dispatcher.dispatchEvents.mock.calls[0][0] as readonly any[];
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.type).toBe('SYSTEM_RESET');
    expect(event.aggregateId).toBe(SYSTEM_AGGREGATE_ID);
    expect(event.resetTo).toBe(5);
    expect(event.date).toBe(EXPECTED_DATE);
    expect(event.occurredAt).toBe(FIXED_NOW);
  });

  it('forwards the configured resetTo value through to resetDaily', async () => {
    await useCase.execute({ resetTo: 101 });
    expect(sequences.resetDaily).toHaveBeenCalledWith(EXPECTED_DATE, 101);
  });
});