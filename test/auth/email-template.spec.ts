import {
  buildPasswordResetEmailHtml,
  buildPasswordResetEmailSubject,
  buildPasswordResetEmailText,
} from '../../src/auth/email-template';

describe('email-template', () => {
  it('renders branded HTML with styled button and escapes HTML injection in user name', () => {
    const html = buildPasswordResetEmailHtml({
      userName: '<script>alert(1)</script> Igor',
      actionUrl:
        'https://painel-monet-front.vercel.app/auth/action?mode=resetPassword&oobCode=abc',
      mode: 'reactivate',
      logoUrl: 'https://painel-monet-front.vercel.app/logo192.png',
    });

    expect(html).toContain('Painel Monet');
    expect(html).toContain('Reativar conta e definir senha');
    expect(html).toContain(
      'https://painel-monet-front.vercel.app/logo192.png',
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('builds distinct subjects and plain text for reset vs reactivate', () => {
    expect(buildPasswordResetEmailSubject('reset')).toContain('Redefinição');
    expect(buildPasswordResetEmailSubject('reactivate')).toContain('Reative');
    expect(
      buildPasswordResetEmailText({
        userName: 'Maria Silva',
        actionUrl:
          'https://painel-monet-front.vercel.app/auth/action?oobCode=123',
        mode: 'reset',
      }),
    ).toContain('Olá, Maria!');
  });
});
