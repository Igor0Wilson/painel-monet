export interface DateParts {
  year: number;
  month: number;
  day: number;
}

export interface MonthlyOverrideBase {
  value?: number;
  amount?: number;
  name?: string;
  day?: number;
  date?: string;
  creditDate?: string;
  accountTypeId?: string;
  skipped?: boolean;
  materializedExpenseId?: string;
}

export interface IncomeCreditEvaluation {
  creditedOccurrences: number;
  creditedAmount: number;
  scheduledAmount: number;
  status: 'creditado' | 'agendado';
  nextCreditDate: string | null;
}

export function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

export function parseDateOnly(dateStr: string): DateParts {
  const clean = String(dateStr || '').split('T')[0];
  const [y, m, d] = clean.split('-').map(Number);
  return { year: y, month: m, day: d };
}

export function formatDateOnly(parts: DateParts): string {
  const y = String(parts.year).padStart(4, '0');
  const m = String(parts.month).padStart(2, '0');
  const d = String(parts.day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getMonthKeyFromParts(parts: { year: number; month: number }): string {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}`;
}

export function parseMonthKey(
  monthKey?: string | null,
): { year: number; month: number; monthIndex: number } | null {
  if (!monthKey || !/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) {
    return null;
  }
  const [year, month] = monthKey.split('-').map(Number);
  return { year, month, monthIndex: year * 12 + (month - 1) };
}

export function shiftMonthKey(monthKey: string, deltaMonths: number): string {
  const parsed = parseMonthKey(monthKey);
  if (!parsed) return monthKey;
  const total = parsed.monthIndex + deltaMonths;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return getMonthKeyFromParts({ year, month });
}

export function getTodayParts(referenceDate: Date = new Date()): DateParts {
  return getBrazilTodayParts(referenceDate);
}

export function getBrazilTodayParts(referenceDate: Date = new Date()): DateParts {
  try {
    const formatted = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(referenceDate);
    const [y, m, d] = formatted.split('-').map(Number);
    if (y && m && d) {
      return { year: y, month: m, day: d };
    }
  } catch {
    // Fallback para UTC-3 se Intl timezone indisponível no ambiente
  }
  const shifted = new Date(referenceDate.getTime() - 3 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

export function addDaysDateOnly(
  dateOrParts: string | DateParts,
  days: number,
): string {
  const start =
    typeof dateOrParts === 'string' ? parseDateOnly(dateOrParts) : dateOrParts;
  const target = new Date(
    Date.UTC(start.year, start.month - 1, start.day + days),
  );
  return formatDateOnly({
    year: target.getUTCFullYear(),
    month: target.getUTCMonth() + 1,
    day: target.getUTCDate(),
  });
}

export function compareDateParts(a: DateParts, b: DateParts): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  return a.day - b.day;
}

export function addMonthsDateOnly(dateStr: string, monthsToAdd: number): string {
  const start = parseDateOnly(dateStr);
  const totalMonths = start.year * 12 + (start.month - 1) + monthsToAdd;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = (totalMonths % 12) + 1;
  const clampedDay = Math.min(start.day, getDaysInMonth(targetYear, targetMonth));
  return formatDateOnly({ year: targetYear, month: targetMonth, day: clampedDay });
}

function resolveOccurrenceDateForMonth(
  baseStart: DateParts,
  year: number,
  month: number,
  override?: MonthlyOverrideBase | null,
): DateParts {
  const explicitDate = override?.creditDate || override?.date;
  if (explicitDate && /^\d{4}-\d{2}-\d{2}/.test(explicitDate)) {
    const parsed = parseDateOnly(explicitDate);
    if (parsed.year === year && parsed.month === month) {
      return parsed;
    }
    const clamped = Math.min(parsed.day, getDaysInMonth(year, month));
    return { year, month, day: clamped };
  }
  const targetDay = override?.day ?? baseStart.day;
  return {
    year,
    month,
    day: Math.min(targetDay, getDaysInMonth(year, month)),
  };
}

function resolveOverrideAmount(
  baseAmount: number,
  override?: MonthlyOverrideBase | null,
): number {
  if (override?.value !== undefined) return Number(override.value) || 0;
  if (override?.amount !== undefined) return Number(override.amount) || 0;
  return baseAmount;
}

/**
 * Avalia quanto de uma receita já entrou efetivamente no saldo disponível
 * com base na data de entrada (`incomeDate`), recorrência mensal (`isRecurring`),
 * eventual mês limite (`recurrenceEndMonth`) e ajustes pontuais por mês (`monthlyOverrides`).
 */
export function evaluateIncomeCredit(
  income: {
    value: number | string;
    incomeDate: string;
    isRecurring: boolean;
    recurrenceEndMonth?: string | null;
    monthlyOverrides?: Record<string, MonthlyOverrideBase> | null;
  },
  today: DateParts = getTodayParts(),
): IncomeCreditEvaluation {
  const amount = Number(income.value) || 0;
  const start = parseDateOnly(income.incomeDate);

  if (!income.isRecurring) {
    const hasEntered = compareDateParts(start, today) <= 0;
    return {
      creditedOccurrences: hasEntered ? 1 : 0,
      creditedAmount: hasEntered ? Number(amount.toFixed(2)) : 0,
      scheduledAmount: hasEntered ? 0 : Number(amount.toFixed(2)),
      status: hasEntered ? 'creditado' : 'agendado',
      nextCreditDate: hasEntered ? null : formatDateOnly(start),
    };
  }

  const startMonthIndex = start.year * 12 + (start.month - 1);
  const parsedEnd = parseMonthKey(income.recurrenceEndMonth);
  const endMonthIndex = parsedEnd ? parsedEnd.monthIndex : Number.POSITIVE_INFINITY;
  const todayMonthIndex = today.year * 12 + (today.month - 1);
  const overrides = income.monthlyOverrides || {};

  const findNextActiveOccurrence = (fromMonthIdx: number): { date: DateParts; value: number } | null => {
    const maxLookahead = Math.min(endMonthIndex, fromMonthIdx + 24);
    for (let idx = fromMonthIdx; idx <= maxLookahead; idx += 1) {
      const y = Math.floor(idx / 12);
      const m = (idx % 12) + 1;
      const mKey = getMonthKeyFromParts({ year: y, month: m });
      const ov = overrides[mKey];
      if (ov?.skipped) continue;
      return {
        date: resolveOccurrenceDateForMonth(start, y, m, ov),
        value: resolveOverrideAmount(amount, ov),
      };
    }
    return null;
  };

  if (compareDateParts(start, today) > 0) {
    const firstActive = findNextActiveOccurrence(startMonthIndex);
    if (!firstActive || endMonthIndex < startMonthIndex) {
      return {
        creditedOccurrences: 0,
        creditedAmount: 0,
        scheduledAmount: 0,
        status: 'creditado',
        nextCreditDate: null,
      };
    }
    return {
      creditedOccurrences: 0,
      creditedAmount: 0,
      scheduledAmount: Number(firstActive.value.toFixed(2)),
      status: 'agendado',
      nextCreditDate: formatDateOnly(firstActive.date),
    };
  }

  let creditedOccurrences = 0;
  let creditedAmount = 0;
  const lastElapsedMonth = Math.min(todayMonthIndex, endMonthIndex);

  for (let idx = startMonthIndex; idx <= lastElapsedMonth; idx += 1) {
    const year = Math.floor(idx / 12);
    const month = (idx % 12) + 1;
    const mKey = getMonthKeyFromParts({ year, month });
    const ov = overrides[mKey];
    if (ov?.skipped) continue;

    const occurrenceDate = resolveOccurrenceDateForMonth(start, year, month, ov);
    if (compareDateParts(occurrenceDate, today) <= 0) {
      creditedOccurrences += 1;
      creditedAmount += resolveOverrideAmount(amount, ov);
    }
  }

  const todayKey = getMonthKeyFromParts(today);
  const currentOv = overrides[todayKey];
  const isCurrentActive =
    todayMonthIndex >= startMonthIndex &&
    todayMonthIndex <= endMonthIndex &&
    !currentOv?.skipped;

  if (!isCurrentActive) {
    const nextOcc =
      todayMonthIndex + 1 <= endMonthIndex
        ? findNextActiveOccurrence(Math.max(startMonthIndex, todayMonthIndex + 1))
        : null;
    return {
      creditedOccurrences,
      creditedAmount: Number(creditedAmount.toFixed(2)),
      scheduledAmount: 0,
      status: 'creditado',
      nextCreditDate: nextOcc ? formatDateOnly(nextOcc.date) : null,
    };
  }

  const thisMonthDate = resolveOccurrenceDateForMonth(
    start,
    today.year,
    today.month,
    currentOv,
  );
  const currentMonthEntered = compareDateParts(thisMonthDate, today) <= 0;
  const thisMonthVal = resolveOverrideAmount(amount, currentOv);

  let nextCreditDate: string | null = null;
  if (!currentMonthEntered) {
    nextCreditDate = formatDateOnly(thisMonthDate);
  } else {
    const nextOcc = findNextActiveOccurrence(todayMonthIndex + 1);
    nextCreditDate = nextOcc ? formatDateOnly(nextOcc.date) : null;
  }

  return {
    creditedOccurrences,
    creditedAmount: Number(creditedAmount.toFixed(2)),
    scheduledAmount: currentMonthEntered ? 0 : Number(thisMonthVal.toFixed(2)),
    status: currentMonthEntered ? 'creditado' : 'agendado',
    nextCreditDate,
  };
}

/**
 * Calcula quanto uma receita contribuiu em um mês específico (para o gráfico histórico).
 */
export function getIncomeAmountForMonth(
  income: {
    value: number | string;
    incomeDate: string;
    isRecurring: boolean;
    recurrenceEndMonth?: string | null;
    monthlyOverrides?: Record<string, MonthlyOverrideBase> | null;
  },
  targetYear: number,
  targetMonth: number, // 1-12
  today: DateParts = getTodayParts(),
): number {
  const amount = Number(income.value) || 0;
  const start = parseDateOnly(income.incomeDate);

  if (!income.isRecurring) {
    if (
      start.year === targetYear &&
      start.month === targetMonth &&
      compareDateParts(start, today) <= 0
    ) {
      return amount;
    }
    return 0;
  }

  const startMonthIndex = start.year * 12 + (start.month - 1);
  const targetMonthIndex = targetYear * 12 + (targetMonth - 1);
  const parsedEnd = parseMonthKey(income.recurrenceEndMonth);
  const endMonthIndex = parsedEnd ? parsedEnd.monthIndex : Number.POSITIVE_INFINITY;
  if (targetMonthIndex < startMonthIndex || targetMonthIndex > endMonthIndex) {
    return 0;
  }

  const mKey = getMonthKeyFromParts({ year: targetYear, month: targetMonth });
  const ov = income.monthlyOverrides?.[mKey];
  if (ov?.skipped) return 0;

  const occurrence = resolveOccurrenceDateForMonth(start, targetYear, targetMonth, ov);
  return compareDateParts(occurrence, today) <= 0
    ? resolveOverrideAmount(amount, ov)
    : 0;
}
