// Formatação para as telas. As datas ficam em UTC no banco e aparecem no horário de Brasília.

const TIME_ZONE = 'America/Sao_Paulo';

const dateFormat = new Intl.DateTimeFormat('pt-BR', { timeZone: TIME_ZONE, dateStyle: 'short' });

const timeFormat = new Intl.DateTimeFormat('pt-BR', { timeZone: TIME_ZONE, timeStyle: 'short' });

const listFormat = new Intl.ListFormat('pt-BR', { style: 'long', type: 'conjunction' });

/** 15/10/2026 08:32 */
export function formatDateTime(value: Date | null | undefined): string {
  return value ? `${dateFormat.format(value)} ${timeFormat.format(value)}` : '';
}

/** 15/10/2026 às 08:32 */
export function formatDateTimeAt(value: Date | null | undefined): string {
  return value ? `${dateFormat.format(value)} às ${timeFormat.format(value)}` : '';
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

const scoreFormat = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const percentFormat = new Intl.NumberFormat('pt-BR', {
  style: 'percent',
  maximumFractionDigits: 1,
});

/**
 * A nota fica com 2 casas e aparece com 1: 7,78 → "7,8". O arredondamento é feito em centésimos
 * inteiros, para 7,85 virar 7,9 (em ponto flutuante, 7,85 é 7,8499…).
 */
export function formatScore(score: number | string | null | undefined): string {
  if (score === null || score === undefined) return '';
  const hundredths = Math.round(Number(score) * 100);
  return scoreFormat.format(Math.round(hundredths / 10) / 10);
}

/** 7 de 9 → "77,8%". */
export function formatPercent(part: number, total: number): string {
  return percentFormat.format(total ? part / total : 0);
}

/** 3725 → "1 h 2 min 5 s"; 754 → "12 min 34 s"; 45 → "45 s". */
export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined) return '';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours) parts.push(`${hours} h`);
  if (minutes) parts.push(`${minutes} min`);
  if (seconds || !parts.length) parts.push(`${seconds} s`);
  return parts.join(' ');
}

/** 3725 → "01:02:05", como no cronômetro da prova. */
export function formatClock(totalSeconds: number): string {
  const value = Math.max(0, Math.floor(totalSeconds));
  return [Math.floor(value / 3600), Math.floor((value % 3600) / 60), value % 60]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

export const viewHelpers = {
  formatDateTime,
  formatDateTimeAt,
  formatDate,
  formatList,
  formatPhone,
  plural,
  formatScore,
  formatPercent,
  formatDuration,
  formatClock,
};
