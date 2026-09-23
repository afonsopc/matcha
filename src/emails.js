// Transactional emails. Every message has a plain-text part (what shows up in
// the console in dev) and a table-based HTML part with inline styles only,
// because that is all most mail clients will render.

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout({ preheader, heading, body, button, url, footnote }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(heading)}</title></head>
<body style="margin:0;padding:0;background:#f4f3ef;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${escape(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f3ef;padding:32px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:2px solid #161616;">
      <tr><td style="background:#161616;padding:18px 28px;">
        <span style="font-family:Helvetica,Arial,sans-serif;font-size:22px;font-weight:bold;color:#ffffff;letter-spacing:.5px;">Matcha</span>
      </td></tr>
      <tr><td style="padding:32px 28px 8px;font-family:Helvetica,Arial,sans-serif;color:#161616;">
        <h1 style="margin:0 0 14px;font-size:28px;line-height:1.15;font-weight:bold;">${escape(heading)}</h1>
        ${body.map((p) => `<p style="margin:0 0 14px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#3b3a33;">${escape(p)}</p>`).join('')}
      </td></tr>
      <tr><td style="padding:10px 28px 26px;">
        <a href="${escape(url)}" style="display:inline-block;background:#d9481c;color:#ffffff;font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:bold;text-decoration:none;padding:13px 22px;border:2px solid #161616;">${escape(button)}</a>
        <p style="margin:18px 0 0;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#777777;">Button not working? Paste this into your browser:<br><a href="${escape(url)}" style="color:#d9481c;word-break:break-all;">${escape(url)}</a></p>
      </td></tr>
      <tr><td style="border-top:1px dashed #dddddd;padding:16px 28px;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#777777;">${escape(footnote)}</td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function verifyEmail({ firstName, url }) {
  const heading = `Confirm your email, ${firstName}`;
  const body = [
    'Click the button below to activate your Matcha account.'
  ];
  const footnote = 'If you did not sign up for Matcha, ignore this email and nothing will happen.';
  return {
    subject: 'Confirm your Matcha account',
    text: `${heading}\n\n${body.join('\n\n')}\n\n${url}\n\n${footnote}`,
    html: layout({ preheader: 'Activate your Matcha account.', heading, body, button: 'Confirm my email', url, footnote })
  };
}

function resetEmail({ username, url }) {
  const heading = 'Reset your password';
  const body = [
    `Someone asked to reset the password for @${username}.`,
    'The link works once and expires in one hour.'
  ];
  const footnote = 'If you did not ask for this, ignore this email. Your password will not change.';
  return {
    subject: 'Reset your Matcha password',
    text: `${heading}\n\n${body.join('\n\n')}\n\n${url}\n\n${footnote}`,
    html: layout({ preheader: 'Password reset link, valid for one hour.', heading, body, button: 'Choose a new password', url, footnote })
  };
}

module.exports = { verifyEmail, resetEmail };
