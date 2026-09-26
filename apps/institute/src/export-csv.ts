import { Platform } from 'react-native';

/** RFC 4180 CSV, with spreadsheet-formula injection neutralised (=, +, -, @ prefixes). */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** Saves the CSV to a temporary file and opens the share sheet (Drive, email, WhatsApp…). */
export async function shareCsv(filename: string, csv: string): Promise<void> {
  const safe = filename.replace(/[^A-Za-z0-9._-]+/g, '_');
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = safe;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5_000);
    return;
  }
  const [{ File, Paths }, Sharing] = await Promise.all([import('expo-file-system'), import('expo-sharing')]);
  const file = new File(Paths.cache, safe);
  if (file.exists) file.delete();
  file.create();
  file.write(csv);
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing isn’t available on this phone.');
  await Sharing.shareAsync(file.uri, { mimeType: 'text/csv', dialogTitle: safe, UTI: 'public.comma-separated-values-text' });
}
