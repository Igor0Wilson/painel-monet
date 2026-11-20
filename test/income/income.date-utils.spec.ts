import {
  addMonthsDateOnly,
  compareDateParts,
  evaluateIncomeCredit,
  formatDateOnly,
  getDaysInMonth,
  getIncomeAmountForMonth,
  parseDateOnly,
} from '../../src/income/income.date-utils';

describe('income.date-utils', () => {
  it('parses and formats date strings with zero padding', () => {
    expect(parseDateOnly('2026-03-05T12:00:00Z')).toEqual({
      year: 2026,
      month: 3,
      day: 5,
    });
    expect(formatDateOnly({ year: 2026, month: 3, day: 5 })).toBe('2026-03-05');
    expect(getDaysInMonth(2024, 2)).toBe(29);
    expect(getDaysInMonth(2026, 2)).toBe(28);
  });

  it('compares DateParts accurately across year, month, and day boundaries', () => {
    expect(
      compareDateParts(
        { year: 2025, month: 12, day: 31 },
        { year: 2026, month: 1, day: 1 },
      ),
    ).toBeLessThan(0);
    expect(
      compareDateParts(
        { year: 2026, month: 2, day: 1 },
        { year: 2026, month: 1, day: 31 },
      ),
    ).toBeGreaterThan(0);
    expect(
      compareDateParts(
        { year: 2026, month: 11, day: 19 },
        { year: 2026, month: 11, day: 19 },
      ),
    ).toBe(0);
  });

  it('credits vale on day 15 and keeps salary on day 30 scheduled when today is day 19', () => {
    const today = { year: 2026, month: 11, day: 19 };

    const vale = evaluateIncomeCredit(
      { value: 1500, incomeDate: '2026-11-15', isRecurring: true },
      today,
    );
    expect(vale).toEqual({
      status: 'creditado',
      creditedOccurrences: 1,
      creditedAmount: 1500,
      scheduledAmount: 0,
      nextCreditDate: '2026-12-15',
    });

    const salario = evaluateIncomeCredit(
      { value: 3000, incomeDate: '2026-11-30', isRecurring: true },
      today,
    );
    expect(salario).toEqual({
      status: 'agendado',
      creditedOccurrences: 0,
      creditedAmount: 0,
      scheduledAmount: 3000,
      nextCreditDate: '2026-11-30',
    });
  });

  it('credits recurring income in earlier months while marking current month scheduled if pay day not yet reached', () => {
    const today = { year: 2026, month: 12, day: 10 };
    const salario = evaluateIncomeCredit(
      { value: 2500, incomeDate: '2026-11-30', isRecurring: true },
      today,
    );
    expect(salario).toEqual({
      status: 'agendado',
      creditedOccurrences: 1,
      creditedAmount: 2500,
      scheduledAmount: 2500,
      nextCreditDate: '2026-12-30',
    });
  });

  it('credits salary automatically once day 30 arrives and handles year rollover', () => {
    const today = { year: 2026, month: 12, day: 30 };

    const salario = evaluateIncomeCredit(
      { value: 3000, incomeDate: '2026-12-30', isRecurring: true },
      today,
    );
    expect(salario).toEqual({
      status: 'creditado',
      creditedOccurrences: 1,
      creditedAmount: 3000,
      scheduledAmount: 0,
      nextCreditDate: '2027-01-30',
    });
  });

  it('accumulates recurring occurrences across months and clamps February day 30 to day 28', () => {
    const today = { year: 2027, month: 2, day: 28 };
    const salario = evaluateIncomeCredit(
      { value: 2000, incomeDate: '2026-12-30', isRecurring: true },
      today,
    );
    expect(salario.creditedOccurrences).toBe(3);
    expect(salario.creditedAmount).toBe(6000);
    expect(salario.status).toBe('creditado');
    expect(salario.nextCreditDate).toBe('2027-03-30');
  });

  it('handles one-off income based on exact boundary dates', () => {
    const today = { year: 2026, month: 11, day: 19 };
    expect(
      evaluateIncomeCredit(
        { value: 500, incomeDate: '2026-11-20', isRecurring: false },
        today,
      ),
    ).toEqual({
      status: 'agendado',
      creditedOccurrences: 0,
      creditedAmount: 0,
      scheduledAmount: 500,
      nextCreditDate: '2026-11-20',
    });

    expect(
      evaluateIncomeCredit(
        { value: 500, incomeDate: '2026-11-19', isRecurring: false },
        today,
      ),
    ).toEqual({
      status: 'creditado',
      creditedOccurrences: 1,
      creditedAmount: 500,
      scheduledAmount: 0,
      nextCreditDate: null,
    });
  });

  it('computes monthly chart amount for recurring and one-off incomes', () => {
    const today = { year: 2026, month: 11, day: 19 };
    const recurringFuture = {
      value: 3000,
      incomeDate: '2026-11-30',
      isRecurring: true,
    };
    expect(getIncomeAmountForMonth(recurringFuture, 2026, 10, today)).toBe(0);
    expect(getIncomeAmountForMonth(recurringFuture, 2026, 11, today)).toBe(0);

    const vale = { value: 1500, incomeDate: '2026-11-15', isRecurring: true };
    expect(getIncomeAmountForMonth(vale, 2026, 10, today)).toBe(0);
    expect(getIncomeAmountForMonth(vale, 2026, 11, today)).toBe(1500);

    const oneOff = { value: 800, incomeDate: '2026-11-10', isRecurring: false };
    expect(getIncomeAmountForMonth(oneOff, 2026, 11, today)).toBe(800);
    expect(getIncomeAmountForMonth(oneOff, 2026, 10, today)).toBe(0);
  });

  it('adds months safely without month overflow', () => {
    expect(addMonthsDateOnly('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsDateOnly('2026-11-19', 2)).toBe('2027-01-19');
    expect(addMonthsDateOnly('2026-03-31', 1)).toBe('2026-04-30');
  });
});
