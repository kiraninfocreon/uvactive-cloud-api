/**
 * One shared HTML shell for every outbound email — logo header, a
 * plain message body, and a footer. Kept intentionally simple (inline
 * styles only, no external stylesheet, no web fonts) because email
 * clients strip or mangle anything fancier; this renders correctly in
 * Gmail, Outlook, and Apple Mail alike.
 *
 * `bodyHtml` is caller-supplied HTML for the message itself — callers
 * building it from user/DB data must escape any untrusted text with
 * escapeHtml() below before interpolating it in.
 */
export interface EmailTemplateParams {
  logoUrl: string;
  appName: string;
  heading: string;
  bodyHtml: string;
  /** Optional short callout box for a credential/code — rendered in a distinct highlighted block. */
  highlight?: string;
}

export function renderEmail(params: EmailTemplateParams): string {
  const { logoUrl, appName, heading, bodyHtml, highlight } = params;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:520px;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e4e4e7;">
          <tr>
            <td align="center" style="background-color:#111113;padding:28px 24px;">
              <img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(appName)}" width="56" height="56" style="border-radius:12px;display:block;" />
              <div style="color:#ffffff;font-size:18px;font-weight:700;margin-top:12px;letter-spacing:0.2px;">${escapeHtml(appName)}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 28px;">
              <h1 style="margin:0 0 16px 0;font-size:20px;line-height:1.3;color:#111113;">${escapeHtml(heading)}</h1>
              <div style="font-size:15px;line-height:1.6;color:#3f3f46;">${bodyHtml}</div>
              ${highlight ? `
              <div style="margin-top:20px;padding:16px 20px;background-color:#fafafa;border:1px solid #e4e4e7;border-radius:8px;text-align:center;">
                <span style="font-size:22px;font-weight:700;letter-spacing:2px;color:#111113;">${escapeHtml(highlight)}</span>
              </div>` : ''}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px 28px 28px;border-top:1px solid #f0f0f0;">
              <p style="margin:0;font-size:12px;color:#a1a1aa;line-height:1.5;">
                This is an automated message from ${escapeHtml(appName)}. If you weren't expecting this email, you can safely ignore it.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
