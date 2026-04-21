import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

let transporter;

function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE).toLowerCase() !== 'false',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
  return transporter;
}

export async function verifySmtp() {
  return getTransporter().verify();
}

function buildRaw(mail) {
  return new Promise((resolve, reject) => {
    new MailComposer(mail).compile().build((err, message) => {
      if (err) return reject(err);
      resolve(message);
    });
  });
}

export async function sendEmail({ to, subject, body }) {
  const from = `"${process.env.EMAIL_FROM_NAME || 'Benjamin Jowers'}" <${process.env.EMAIL_USER}>`;
  const mail = { from, to, subject, text: body };
  const info = await getTransporter().sendMail(mail);
  // Build a raw MIME representation for IMAP append.
  // nodemailer generated its own message internally; rebuild with the same fields
  // and set the Message-ID so the raw matches what the SMTP server accepted.
  const raw = await buildRaw({ ...mail, messageId: info.messageId });
  return {
    messageId: info.messageId,
    accepted: info.accepted || [],
    rejected: info.rejected || [],
    response: info.response,
    raw,
  };
}
