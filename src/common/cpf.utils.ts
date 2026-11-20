export function normalizeCpf(raw?: string | null): string {
  if (!raw) return '';
  return String(raw).replace(/\D/g, '');
}

export function isValidCpf(raw?: string | null): boolean {
  const cpf = normalizeCpf(raw);
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += Number(cpf[i]) * (10 - i);
  }
  let remainder = (sum * 10) % 11;
  if (remainder === 10) remainder = 0;
  if (remainder !== Number(cpf[9])) return false;

  sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += Number(cpf[i]) * (11 - i);
  }
  remainder = (sum * 10) % 11;
  if (remainder === 10) remainder = 0;
  return remainder === Number(cpf[10]);
}

export function maskCpf(raw?: string | null): string {
  const cpf = normalizeCpf(raw);
  if (cpf.length !== 11) return '***.***.***-**';
  return `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-**`;
}

export function formatCpf(raw?: string | null): string {
  const cpf = normalizeCpf(raw);
  if (cpf.length !== 11) return raw || '';
  return `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9, 11)}`;
}

export function normalizePhone(raw?: string | null): string {
  if (!raw) return '';
  return String(raw).replace(/\D/g, '').slice(0, 15);
}
