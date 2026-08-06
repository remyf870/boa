// Approval certificate PDF (plan §5.3): the document a requester may send to
// the supplier as proof an Approval Reference exists. Labelled per A.5.13 —
// classification, exporter identity and timestamp on the page, classification
// repeated in the footer. Callers audit-log the export (A.8.12).
import PDFDocument from 'pdfkit';

export interface CertificateData {
  reference: string;
  approvalReference: string;
  approvedAt: Date;
  costCentreCode: string;
  categoryName: string;
  supplierName: string | null;
  description: string;
  amount: string;
  currency: string;
  requesterName: string;
  approvers: {
    stepNo: number;
    role: string | null;
    name: string | null;
    jobTitle: string | null;
    decidedAt: Date | null;
  }[];
  exportedBy: string;
}

const CLASSIFICATION_LABEL = 'Internal — may be shared with the named supplier only';

export function buildApprovalCertificate(data: CertificateData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: `Approval ${data.approvalReference}` } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // A.5.13 labelling block — first thing on page 1
    doc.fontSize(8).fillColor('#7f1d1d').text(CLASSIFICATION_LABEL);
    doc.fillColor('#475569');
    doc.text(`Exported by: ${data.exportedBy}`);
    doc.text(`Exported at (UTC): ${new Date().toISOString()}`);
    doc.moveDown(1.5);

    doc.fillColor('#0f172a').fontSize(18).text('Massy Motors — Purchase Approval Certificate');
    doc.moveDown(0.3);
    doc
      .fontSize(11)
      .fillColor('#334155')
      .text('This certifies that the purchase below has been approved under the Massy Motors Delegation of Authority.');
    doc.moveDown(1);

    doc.fontSize(13).fillColor('#0f172a').text(`Approval Reference: ${data.approvalReference}`);
    doc.moveDown(0.8);

    const field = (label: string, value: string) => {
      doc.fontSize(10).fillColor('#64748b').text(label);
      doc.fontSize(11).fillColor('#0f172a').text(value);
      doc.moveDown(0.5);
    };
    field('Requisition reference', data.reference);
    field('Approved on (UTC)', data.approvedAt.toISOString());
    field('Cost centre', data.costCentreCode);
    field('Category', data.categoryName);
    field('Supplier', data.supplierName ?? '(not specified)');
    field('Description', data.description);
    field('Approved amount', `${data.currency} ${Number(data.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    field('Requested by', data.requesterName);

    doc.moveDown(0.5);
    doc.fontSize(10).fillColor('#64748b').text('Approval chain');
    for (const a of data.approvers) {
      doc
        .fontSize(11)
        .fillColor('#0f172a')
        .text(
          `${a.stepNo}. ${a.name ?? '(system)'}${a.jobTitle ? ` — ${a.jobTitle}` : ''}${
            a.decidedAt ? `  (approved ${a.decidedAt.toISOString()})` : ''
          }`,
        );
    }

    doc.moveDown(1.5);
    doc
      .fontSize(9)
      .fillColor('#64748b')
      .text(
        'Accounting will only post invoices that quote a valid Approval Reference. ' +
          'Please quote the Approval Reference above on your invoice.',
      );

    // Classification repeated at the foot of the page (A.5.13)
    doc.fontSize(8).fillColor('#7f1d1d').text(CLASSIFICATION_LABEL, 56, doc.page.height - 70);

    doc.end();
  });
}
