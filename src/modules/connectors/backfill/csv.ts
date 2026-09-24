/**
 * Minimal RFC 4180 CSV writer for the backfill audit report (US17.4).
 *
 * Cells come from provider data and operator input, and the report is meant to be opened in a
 * spreadsheet, so a cell beginning with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed
 * with an apostrophe. Without it, a record titled `=HYPERLINK(...)` would run as a formula for
 * whoever opened the audit file (CSV injection).
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (typeof value === 'string' && FORMULA_LEAD.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}

/** Rows are joined with CRLF, per the RFC, and the file ends with a final line break. */
export function toCsv(header: string[], rows: unknown[][]): string {
  return [csvRow(header), ...rows.map(csvRow)].join('\r\n') + '\r\n';
}
