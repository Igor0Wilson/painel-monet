export interface DateParts {
  year: number;
  month: number; 
  day: number; 
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
  const clean = String(dateStr).split('T')[0];
  const [y, m, d] = clean.split('-').map(Number);
  return { year: y, month: m, day: d };
}

export function formatDateOnly(parts: DateParts): string {
  const y = String(parts.year).padStart(4, '0');
  const m = String(parts.month).padStart(2, '0');
  const d = String(parts.day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getTodayParts(): DateParts {
  const now = new Date();
  return {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
  };
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

/**
 * Avalia quanto de uma receita já entrou efetivamente no saldo disponível
 * com base na data de entrada (`incomeDate`) e recorrência mensal (`isRecurring`).
 */
export function evaluateIncomeCredit(
  income: { value: number | string; incomeDate: string; isRecurring: boolean },
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

  // Receita recorrente mensal (ex.: salário dia 30, vale/adiantamento dia 15)
  if (compareDateParts(start, today) > 0) {
    // Ainda não chegou a primeira data de entrada
    return {
      creditedOccurrences: 0,
      creditedAmount: 0,
      scheduledAmount: Number(amount.toFixed(2)),
      status: 'agendado',
      nextCreditDate: formatDateOnly(start),
    };
  }

  // Conta todas as ocorrências mensais de `start` até `today` (inclusive)
  let creditedOccurrences = 0;
  let monthIndex = start.year * 12 + (start.month - 1);
  const todayMonthIndex = today.year * 12 + (today.month - 1);

  while (monthIndex <= todayMonthIndex) {
    const year = Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1;
    const day = Math.min(start.day, getDaysInMonth(year, month));
    const occurrenceDate: DateParts = { year, month, day };

    if (compareDateParts(occurrenceDate, today) <= 0) {
      creditedOccurrences += 1;
    }
    monthIndex += 1;
  }

  // Verifica se a parcela do mês atual já entrou ou ainda está agendada
  const thisMonthDay = Math.min(start.day, getDaysInMonth(today.year, today.month));
  const thisMonthDate: DateParts = {
    year: today.year,
    month: today.month,
    day: thisMonthDay,
  };
  const currentMonthEntered = compareDateParts(thisMonthDate, today) <= 0;

  let nextCreditDate: string;
  if (!currentMonthEntered) {
    nextCreditDate = formatDateOnly(thisMonthDate);
  } else {
    const nextMonthTotal = todayMonthIndex + 1;
    const nextYear = Math.floor(nextMonthTotal / 12);
    const nextMonth = (nextMonthTotal % 12) + 1;
    const nextDay = Math.min(start.day, getDaysInMonth(nextYear, nextMonth));
    nextCreditDate = formatDateOnly({ year: nextYear, month: nextMonth, day: nextDay });
  }

  return {
    creditedOccurrences,
    creditedAmount: Number((creditedOccurrences * amount).toFixed(2)),
    scheduledAmount: currentMonthEntered ? 0 : Number(amount.toFixed(2)),
    status: currentMonthEntered ? 'creditado' : 'agendado',
    nextCreditDate,
  };
}

/**
 * Calcula quanto uma receita contribuiu em um mês específico (para o gráfico histórico).
 */
export function getIncomeAmountForMonth(
  income: { value: number | string; incomeDate: string; isRecurring: boolean },
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
  if (targetMonthIndex < startMonthIndex) return 0;

  const day = Math.min(start.day, getDaysInMonth(targetYear, targetMonth));
  const occurrence: DateParts = { year: targetYear, month: targetMonth, day };

  return compareDateParts(occurrence, today) <= 0 ? amount : 0;
}
