import {
  formatCpf,
  isValidCpf,
  maskCpf,
  normalizeCpf,
  normalizePhone,
} from '../../src/common/cpf.utils';

function buildCpf(base9: string): string {
  const digits = base9.split('').map(Number);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += digits[i] * (10 - i);
  let d1 = (sum * 10) % 11;
  if (d1 === 10) d1 = 0;
  digits.push(d1);

  sum = 0;
  for (let i = 0; i < 10; i++) sum += digits[i] * (11 - i);
  let d2 = (sum * 10) % 11;
  if (d2 === 10) d2 = 0;
  digits.push(d2);
  return digits.join('');
}

describe('cpf.utils', () => {
  describe('normalizeCpf', () => {
    it('strips non-numeric characters and handles empty/null inputs', () => {
      expect(normalizeCpf('123.456.789-01')).toBe('12345678901');
      expect(normalizeCpf('')).toBe('');
      expect(normalizeCpf(null)).toBe('');
      expect(normalizeCpf(undefined)).toBe('');
    });
  });

  describe('isValidCpf', () => {
    it('validates legitimate CPFs including formatted strings and remainder-10 edge cases', () => {
      const valid1 = buildCpf('123456789');
      const valid2 = buildCpf('111444777');
      const valid3 = buildCpf('000000001');
      const validRem10 = buildCpf('100000000');

      expect(isValidCpf(valid1)).toBe(true);
      expect(isValidCpf(formatCpf(valid1))).toBe(true);
      expect(isValidCpf(valid2)).toBe(true);
      expect(isValidCpf(valid3)).toBe(true);
      expect(isValidCpf(validRem10)).toBe(true);
    });

    it('rejects invalid lengths, repeated digits, and wrong check digits', () => {
      expect(isValidCpf('')).toBe(false);
      expect(isValidCpf(null)).toBe(false);
      expect(isValidCpf('1234567890')).toBe(false);
      expect(isValidCpf('123456789012')).toBe(false);
      expect(isValidCpf('11111111111')).toBe(false);
      expect(isValidCpf('00000000000')).toBe(false);

      const valid = buildCpf('123456789');
      const wrongFirstCheck =
        valid.slice(0, 9) + String((Number(valid[9]) + 1) % 10) + valid[10];
      const wrongSecondCheck =
        valid.slice(0, 10) + String((Number(valid[10]) + 1) % 10);

      expect(isValidCpf(wrongFirstCheck)).toBe(false);
      expect(isValidCpf(wrongSecondCheck)).toBe(false);
    });
  });

  describe('maskCpf', () => {
    it('masks valid 11-digit CPFs and falls back for invalid ones', () => {
      expect(maskCpf('12345678901')).toBe('***.456.789-**');
      expect(maskCpf('123.456.789-01')).toBe('***.456.789-**');
      expect(maskCpf('12345')).toBe('***.***.***-**');
      expect(maskCpf(null)).toBe('***.***.***-**');
    });
  });

  describe('formatCpf', () => {
    it('formats 11-digit CPFs and preserves raw/empty values otherwise', () => {
      expect(formatCpf('12345678901')).toBe('123.456.789-01');
      expect(formatCpf('12345')).toBe('12345');
      expect(formatCpf(null)).toBe('');
    });
  });

  describe('normalizePhone', () => {
    it('removes formatting and clamps to 15 digits', () => {
      expect(normalizePhone('(11) 99999-8888')).toBe('11999998888');
      expect(normalizePhone('+55 (11) 99999-8888123456')).toBe(
        '551199999888812',
      );
      expect(normalizePhone('')).toBe('');
      expect(normalizePhone(undefined)).toBe('');
    });
  });
});
