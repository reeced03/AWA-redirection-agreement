// Email the signed PDF to AWA. Uses SMTP (works with Microsoft 365, Google Workspace, etc.).
// If SMTP isn't configured the submission is still saved and the PDF is available on the admin page.
import { getConfig } from './config.mjs';

export async function emailSignedAgreement({ to, template, submission, pdfBytes }) {
  const cfg = getConfig();
  const recipients = to || cfg.notifyEmail;
  if (!recipients) return { status: 'skipped', detail: 'No notification email set for this company or NOTIFY_EMAIL.' };
  if (!cfg.smtp.host || !cfg.mailFrom) return { status: 'skipped', detail: 'SMTP_HOST / MAIL_FROM not configured.' };

  const { default: nodemailer } = await import('nodemailer');
  const transport = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.secure,
    auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.pass } : undefined,
  });
  const emp = submission.employee;
  const decision = submission.decision === 'enroll' ? 'Enrolled' : 'Waived / declined benefits';
  const safeName = emp.name.replace(/[^\w .-]/g, '').replace(/\s+/g, '_');
  try {
    await transport.sendMail({
      from: cfg.mailFrom,
      to: recipients,
      subject: `Signed Redirection Agreement – ${template.companyName} – ${emp.name}`,
      text: [
        `A Redirection Agreement was signed.`,
        ``,
        `Company: ${template.companyName}`,
        `Employee: ${emp.name}`,
        `Decision: ${decision}`,
        `Signed: ${new Date(submission.signedAt).toLocaleString('en-US', { timeZone: 'America/New_York' })} (Eastern)`,
        `Confirmation: ${submission.confirmation}`,
        ``,
        `The signed agreement is attached. Download the Open Enrollment Redirection spreadsheet from the admin page.`,
      ].join('\n'),
      attachments: [{ filename: `Redirection_Agreement_${safeName}.pdf`, content: Buffer.from(pdfBytes), contentType: 'application/pdf' }],
    });
    return { status: 'sent', to: recipients };
  } catch (e) {
    console.error('Email failed:', e?.message);
    return { status: 'failed', detail: String(e?.message || e).slice(0, 300) };
  }
}
