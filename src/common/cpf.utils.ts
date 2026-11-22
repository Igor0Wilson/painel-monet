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

export function maskPhone(raw?: string | null): string | null {
  const digits = normalizePhone(raw);
  if (!digits) return null;
  if (digits.length < 4) return '****';
  const last4 = digits.slice(-4);
  if (digits.length >= 10) {
    const ddd = digits.slice(0, 2);
    return `(${ddd}) *****-${last4}`;
  }
  return `*****${last4}`;
}

export function maskEmail(raw?: string | null): string {
  if (!raw || typeof raw !== 'string') return '***';
  const trimmed = raw.trim();
  const atIdx = trimmed.indexOf('@');
  if (atIdx <= 0) return '***';
  const local = trimmed.slice(0, atIdx);
  const domain = trimmed.slice(atIdx + 1);
  if (!domain) return '***';
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***@${domain}`;
}
