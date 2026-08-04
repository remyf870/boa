// Excel export helper. Every workbook produced here carries the labelling
// block required by A.5.13 (classification, exporter, timestamp, filter) and
// every caller must audit-log the export with its row count (A.8.12).
import ExcelJS from 'exceljs';

export interface ExportMeta {
  title: string;
  classification: 'Internal' | 'Confidential';
  exportedBy: string; // display name <email>
  filterDescription: string;
  columns: { header: string; key: string; width?: number }[];
  rows: Record<string, unknown>[];
}

export async function buildLabelledWorkbook(meta: ExportMeta): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Massy Purchasing';
  wb.created = new Date();
  const ws = wb.addWorksheet(meta.title.slice(0, 31));

  // A.5.13 labelling block — first thing on page 1
  ws.addRow([`Classification: ${meta.classification}`]);
  ws.addRow([`Exported by: ${meta.exportedBy}`]);
  ws.addRow([`Exported at (UTC): ${new Date().toISOString()}`]);
  ws.addRow([`Filter: ${meta.filterDescription}`]);
  ws.addRow([`Rows: ${meta.rows.length}`]);
  ws.addRow([]);
  for (let i = 1; i <= 5; i++) {
    const cell = ws.getRow(i).getCell(1);
    cell.font = { bold: i === 1, size: i === 1 ? 12 : 10, color: { argb: i === 1 ? 'FF7F1D1D' : 'FF334155' } };
  }

  const headerRow = ws.addRow(meta.columns.map((c) => c.header));
  headerRow.font = { bold: true };
  headerRow.border = { bottom: { style: 'thin' } };
  meta.columns.forEach((c, idx) => {
    ws.getColumn(idx + 1).width = c.width ?? 24;
  });
  for (const row of meta.rows) {
    ws.addRow(meta.columns.map((c) => row[c.key] ?? ''));
  }

  // Repeat the classification in the print footer (A.5.13)
  ws.headerFooter.oddFooter = `&L${meta.classification}&RExported ${new Date().toISOString()}`;

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
