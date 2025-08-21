import nodemailer from "nodemailer";

/**
 * Sends an alert email using SMTP creds from env:
 * - SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 * - ALERT_TO, ALERT_FROM_NAME (optional)
 */
export async function sendAlert({ subject, html, text }) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const to   = process.env.ALERT_TO;
  const fromName = process.env.ALERT_FROM_NAME || "Boom SLA Bot";

  if (!host || !port || !user || !pass || !to) {
    console.log("Alert needed, but SMTP/recipient envs are not fully set.");
    return { sent: false, reason: "smtp_missing" };
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // true for 465, false for 587/25
    auth: { user, pass }
  });

  const message = {
    from: `"${fromName}" <${user}>`,
    to,
    subject,
    text: text || "",
    html: html || ""
  };

  await transporter.sendMail(message);
  return { sent: true };
}
