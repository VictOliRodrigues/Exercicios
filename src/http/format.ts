// Formatação para as telas. As datas ficam em UTC no banco e aparecem no horário de Brasília.

const TIME_ZONE = 'America/Sao_Paulo';

const dateTimeFormat = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TIME_ZONE,
  dateStyle: 'short',
  timeStyle: 'short',
});

const dateFormat = new Intl.DateTimeFormat('pt-BR', { timeZone: TIME_ZONE, dateStyle: 'short' });

const listFormat = new Intl.ListFormat('pt-BR', { style: 'long', type: 'conjunction' });

export function formatDateTime(value: Date | null | undefined): string {
  return value ? dateTimeFormat.format(value) : '';
}

export function formatDate(value: Date | null | undefined): string {
  return value ? dateFormat.format(value) : '';
}

/** "A", "A e B", "A, B e C". */
export function formatList(items: string[]): string {
  return listFormat.format(items);
}

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

/** 4899990000 → (48) 9999-0000; 48999990000 → (48) 99999-0000. */
export function formatPhone(digits: string | null | undefined): string {
  if (!digits) return '';
  const match = /^(\d{2})(\d{4,5})(\d{4})$/.exec(digits);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : digits;
}

/** plural(1, 'questão', 'questões') → "1 questão"; plural(5, ...) → "5 questões". */
export function plural(count: number, singular: string, pluralForm: string): string {
  return `${count.toLocaleString('pt-BR')} ${count === 1 ? singular : pluralForm}`;
}

export const viewHelpers = { formatDateTime, formatDate, formatList, formatPhone, plural };
