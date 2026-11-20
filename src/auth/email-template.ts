export interface PasswordResetEmailTemplateParams {
  userName: string;
  actionUrl: string;
  mode: 'reset' | 'reactivate';
  logoUrl?: string;
}

export interface FamilyInviteEmailTemplateParams {
  inviteeName: string;
  inviterName: string;
  inviterMaskedCpf: string;
  groupName: string;
  actionUrl: string;
  logoUrl?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildPasswordResetEmailSubject(
  mode: 'reset' | 'reactivate',
): string {
  return mode === 'reactivate'
    ? 'Reative sua conta no Finanças'
    : 'Redefinição de senha — Finanças';
}

export function buildFamilyInviteEmailSubject(inviterName: string): string {
  const firstName = inviterName.trim().split(/\s+/)[0] || 'Um familiar';
  return `${firstName} convidou você para o Painel Família — Finanças`;
}

export function buildFamilyInviteEmailText(
  params: FamilyInviteEmailTemplateParams,
): string {
  const firstName = params.inviteeName.trim().split(/\s+/)[0] || 'Cliente';
  return [
    `Olá, ${firstName}!`,
    '',
    `${params.inviterName} (CPF ${params.inviterMaskedCpf}) informou o seu CPF para convidar você a unificar o controle financeiro no Modo Família (${params.groupName}) do aplicativo Finanças.`,
    '',
    'Para analisar, aceitar ou recusar o convite com dupla confirmação de segurança, acesse o seu painel pelo link abaixo:',
    '',
    params.actionUrl,
    '',
    'Importante: seus dados permanecem exclusivos até que você aceite o convite dentro do aplicativo.',
    '',
    'Finanças — Gestão Patrimonial & Controle Financeiro',
  ].join('\n');
}

export function buildFamilyInviteEmailHtml(
  params: FamilyInviteEmailTemplateParams,
): string {
  const firstName = escapeHtml(
    params.inviteeName.trim().split(/\s+/)[0] || 'Cliente',
  );
  const inviterName = escapeHtml(params.inviterName);
  const inviterCpf = escapeHtml(params.inviterMaskedCpf);
  const groupName = escapeHtml(params.groupName);
  const safeUrl = escapeHtml(params.actionUrl);
  const safeLogoUrl = params.logoUrl ? escapeHtml(params.logoUrl) : '';
  const year = new Date().getFullYear();

  const logoMarkup = safeLogoUrl
    ? `<img src="${safeLogoUrl}" alt="Finanças" width="44" height="44" style="display:block;border-radius:12px;border:0;" />`
    : `<div style="width:44px;height:44px;border-radius:12px;background:#10b981;color:#ffffff;font-weight:700;font-size:20px;line-height:44px;text-align:center;">$</div>`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(buildFamilyInviteEmailSubject(params.inviterName))}</title>
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f1f5f9;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;background-color:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #e2e8f0;box-shadow:0 10px 30px rgba(15,23,42,0.08);">
          <tr>
            <td style="background:linear-gradient(135deg,#0f172a 0%,#064e3b 100%);padding:28px 32px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding-right:14px;vertical-align:middle;">
                    ${logoMarkup}
                  </td>
                  <td style="vertical-align:middle;">
                    <div style="font-size:17px;font-weight:700;color:#ffffff;letter-spacing:-0.01em;">Finanças</div>
                    <div style="font-size:12px;color:#94a3b8;margin-top:2px;">Gestão Patrimonial &amp; Controle Financeiro</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:32px;">
              <div style="display:inline-block;padding:5px 12px;border-radius:999px;background-color:#ecfdf5;color:#047857;font-size:11px;font-weight:700;letter-spacing:0.06em;margin-bottom:16px;">
                CONVITE · PAINEL FAMÍLIA
              </div>

              <h1 style="margin:0 0 12px 0;font-size:22px;line-height:1.3;font-weight:700;color:#0f172a;">
                Você recebeu um convite para o Modo Família
              </h1>

              <p style="margin:0 0 14px 0;font-size:15px;line-height:1.6;color:#334155;">
                Olá, <strong>${firstName}</strong>!
              </p>

              <p style="margin:0 0 20px 0;font-size:14px;line-height:1.65;color:#475569;">
                O usuário <strong>${inviterName}</strong> (portador do CPF <strong>${inviterCpf}</strong>) cadastrou o seu CPF para convidar você a compartilhar o <strong>${groupName}</strong> no aplicativo <strong>Finanças</strong>.
              </p>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-bottom:28px;">
                <tr>
                  <td align="center">
                    <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background-color:#059669;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;padding:15px 32px;border-radius:12px;box-shadow:0 4px 14px rgba(5,150,105,0.24);">
                      Abrir Finanças e analisar convite
                    </a>
                  </td>
                </tr>
              </table>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">
                <tr>
                  <td style="padding:14px 16px;font-size:12px;line-height:1.6;color:#475569;">
                    <strong style="color:#0f172a;">Proteção Dupla (CPF + ID):</strong> seus dados financeiros continuam 100% privados até que você acesse sua conta e confirme duas vezes a unificação do painel.
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="background-color:#f8fafc;border-top:1px solid #e2e8f0;padding:18px 32px;text-align:center;font-size:11px;color:#94a3b8;">
              &copy; ${year} Finanças · E-mail automático de segurança, não responda.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function buildPasswordResetEmailText(
  params: PasswordResetEmailTemplateParams,
): string {
  const firstName = params.userName.trim().split(/\s+/)[0] || 'Cliente';
  if (params.mode === 'reactivate') {
    return [
      `Olá, ${firstName}!`,
      '',
      'Recebemos sua solicitação para reativar sua conta no Painel Monet.',
      'Acesse o link abaixo para definir sua nova senha e liberar novamente o acesso ao seu painel com todos os seus dados preservados:',
      '',
      params.actionUrl,
      '',
      'Se você não fez esta solicitação, ignore este e-mail com segurança.',
      '',
      'Painel Monet — Gestão Patrimonial',
    ].join('\n');
  }

  return [
    `Olá, ${firstName}!`,
    '',
    'Recebemos uma solicitação para redefinir a senha da sua conta no Painel Monet.',
    'Acesse o link abaixo para escolher uma nova senha com segurança:',
    '',
    params.actionUrl,
    '',
    'Se você não solicitou esta alteração, pode ignorar este e-mail com segurança.',
    '',
    'Painel Monet — Gestão Patrimonial',
  ].join('\n');
}

export function buildPasswordResetEmailHtml(
  params: PasswordResetEmailTemplateParams,
): string {
  const firstName = escapeHtml(
    params.userName.trim().split(/\s+/)[0] || 'Cliente',
  );
  const safeUrl = escapeHtml(params.actionUrl);
  const safeLogoUrl = params.logoUrl ? escapeHtml(params.logoUrl) : '';

  const isReactivate = params.mode === 'reactivate';
  const badgeText = isReactivate
    ? 'REATIVAÇÃO DE CONTA'
    : 'RECUPERAÇÃO DE SENHA';
  const titleText = isReactivate
    ? 'Reative seu acesso ao Painel Monet'
    : 'Redefina sua senha com segurança';
  const bodyText = isReactivate
    ? 'Recebemos sua solicitação para reativar sua conta no <strong>Painel Monet</strong>. Clique no botão abaixo para definir sua nova senha — assim que concluir e entrar no painel, todos os seus dados financeiros voltarão a ficar disponíveis.'
    : 'Recebemos uma solicitação para redefinir a senha da sua conta no <strong>Painel Monet</strong>. Clique no botão abaixo para criar uma nova senha com segurança.';
  const buttonText = isReactivate
    ? 'Reativar conta e definir senha'
    : 'Redefinir minha senha';
  const buttonColor = isReactivate ? '#059669' : '#0f172a';
  const year = new Date().getFullYear();

  const logoMarkup = safeLogoUrl
    ? `<img src="${safeLogoUrl}" alt="Painel Monet" width="44" height="44" style="display:block;border-radius:12px;border:0;" />`
    : `<div style="width:44px;height:44px;border-radius:12px;background:#10b981;color:#ffffff;font-weight:700;font-size:20px;line-height:44px;text-align:center;">$</div>`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(buildPasswordResetEmailSubject(params.mode))}</title>
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f1f5f9;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;background-color:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #e2e8f0;box-shadow:0 10px 30px rgba(15,23,42,0.08);">
          <tr>
            <td style="background:linear-gradient(135deg,#0f172a 0%,#064e3b 100%);padding:28px 32px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding-right:14px;vertical-align:middle;">
                    ${logoMarkup}
                  </td>
                  <td style="vertical-align:middle;">
                    <div style="font-size:17px;font-weight:700;color:#ffffff;letter-spacing:-0.01em;">Painel Monet</div>
                    <div style="font-size:12px;color:#94a3b8;margin-top:2px;">Gestão Patrimonial &amp; Controle Financeiro</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:32px;">
              <div style="display:inline-block;padding:5px 12px;border-radius:999px;background-color:#ecfdf5;color:#047857;font-size:11px;font-weight:700;letter-spacing:0.06em;margin-bottom:16px;">
                ${badgeText}
              </div>

              <h1 style="margin:0 0 12px 0;font-size:22px;line-height:1.3;font-weight:700;color:#0f172a;">
                ${titleText}
              </h1>

              <p style="margin:0 0 14px 0;font-size:15px;line-height:1.6;color:#334155;">
                Olá, <strong>${firstName}</strong>!
              </p>

              <p style="margin:0 0 28px 0;font-size:14px;line-height:1.65;color:#475569;">
                ${bodyText}
              </p>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-bottom:28px;">
                <tr>
                  <td align="center">
                    <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background-color:${buttonColor};color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;padding:15px 32px;border-radius:12px;box-shadow:0 4px 14px rgba(15,23,42,0.18);">
                      ${buttonText}
                    </a>
                  </td>
                </tr>
              </table>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">
                <tr>
                  <td style="padding:14px 16px;font-size:12px;line-height:1.6;color:#475569;">
                    <strong style="color:#0f172a;">Dica de segurança:</strong> este link é pessoal, de uso único e expira automaticamente. Se você não fez esta solicitação, basta ignorar este e-mail — sua conta continua protegida.
                  </td>
                </tr>
              </table>

              <p style="margin:22px 0 0 0;font-size:11px;line-height:1.5;color:#94a3b8;word-break:break-all;">
                Caso o botão acima não funcione, copie e cole este link no navegador:<br />
                <a href="${safeUrl}" style="color:#0f766e;text-decoration:underline;">${safeUrl}</a>
              </p>
            </td>
          </tr>

          <tr>
            <td style="background-color:#f8fafc;border-top:1px solid #e2e8f0;padding:18px 32px;text-align:center;font-size:11px;color:#94a3b8;">
              &copy; ${year} Painel Monet · E-mail automático de segurança, não responda.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
