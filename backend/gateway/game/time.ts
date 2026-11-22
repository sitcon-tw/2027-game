// Dart saves may include microseconds beyond Date's milliseconds.
const submillis = new WeakMap<Date, string>();

export function parseDate(value: string): Date {
  const date = new Date(value);
  const fraction = /T\d{2}:\d{2}:\d{2}\.\d{3}(\d{1,3})/.exec(value)?.[1].padEnd(3, '0');
  if (fraction && fraction !== '000') submillis.set(date, fraction);
  return date;
}

export const optionalDate = (value: string | null | undefined) => value == null ? null : parseDate(value);

export function stamp(date: Date): string {
  const result = date.toISOString();
  const fraction = submillis.get(date);
  return fraction ? `${result.slice(0, -1)}${fraction}Z` : result;
}

export function addSeconds(date: Date, seconds: number): Date {
  const next = new Date(date.getTime() + seconds * 1000);
  const fraction = submillis.get(date);
  if (fraction) submillis.set(next, fraction);
  return next;
}

export function isBefore(a: Date, b: Date): boolean {
  const diff = a.getTime() - b.getTime();
  return diff < 0 || (diff === 0 && (submillis.get(a) ?? '000') < (submillis.get(b) ?? '000'));
}
