// Central place for environment configuration.
// All secrets come from Netlify environment variables (Site settings → Environment variables).

function env(name, fallback = '') {
  const v = (globalThis.Netlify?.env?.get?.(name)) ?? process.env[name];
  return v === undefined || v === null || v === '' ? fallback : String(v);
}

export function getConfig() {
  return {
    appSecret: env('APP_SECRET'),
    adminPassword: env('ADMIN_PASSWORD'),
    notifyEmail: env('NOTIFY_EMAIL'),
    mailFrom: env('MAIL_FROM'),
    smtp: {
      host: env('SMTP_HOST'),
      port: Number(env('SMTP_PORT', '587')),
      user: env('SMTP_USER'),
      pass: env('SMTP_PASS'),
      secure: env('SMTP_SECURE', '') === 'true' || env('SMTP_PORT', '587') === '465',
    },
    sessionMinutes: Number(env('SESSION_MINUTES', '30')),
    adminSessionHours: Number(env('ADMIN_SESSION_HOURS', '12')),
  };
}

export function assertConfigured(cfg) {
  const missing = [];
  if (!cfg.appSecret || cfg.appSecret.length < 32) missing.push('APP_SECRET (at least 32 characters)');
  if (!cfg.adminPassword || cfg.adminPassword.length < 10) missing.push('ADMIN_PASSWORD (at least 10 characters)');
  return missing;
}
