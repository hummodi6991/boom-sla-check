// Optional helper (not required by check.mjs). Kept for compatibility.
import nodemailer from "nodemailer";

export async function sendAlert({ subject, text, html }) {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const to   = process.env.ALERT_TO;
  const fromName = process.env.ALERT_FROM_NAME || "Boom SLA Bot";

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });

  await transporter.sendMail({
    from: { name: fromName, address: user },
    to,
    subject,
    text,
    html
  });
}
