/**
 * Mail over HTTPS (Brevo's API), which is how mail has to go on hosts that block SMTP (Render's free tier): inline images are linked by
 * their public address instead of embedded by attachment, images the guest needs are attached as plain files when they cannot be linked,
 * and a refusal from the mail service is reported with its reason.
 */
import request from 'supertest';

describe('mail sent over HTTPS', () => {
  const fetchMock = jest.fn();
  const load = (publicUrl?: string) => {
    jest.resetModules();
    process.env.BREVO_API_KEY = 'xkeysib-test';
    process.env.BREVO_SENDER = 'LGPSM <events@example.com>';
    if (publicUrl === undefined) delete process.env.PUBLIC_API_URL; else process.env.PUBLIC_API_URL = publicUrl;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../src/utils/email.provider') as typeof import('../src/utils/email.provider');
  };
  beforeEach(() => { fetchMock.mockReset(); fetchMock.mockResolvedValue({ ok: true, status: 201, json: async () => ({}) }); (global as any).fetch = fetchMock; });
  afterAll(() => { delete process.env.BREVO_API_KEY; delete process.env.BREVO_SENDER; delete process.env.PUBLIC_API_URL; });
  const sent = () => JSON.parse(fetchMock.mock.calls[0][1].body);

  it('sends a plain email with the sender and recipient', async () => {
    const { sendEmail } = load();
    await sendEmail('guest@x.com', 'Hello', '<p>Hi</p>');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.brevo.com/v3/smtp/email');
    expect(sent()).toMatchObject({ sender: { name: 'LGPSM', email: 'events@example.com' }, to: [{ email: 'guest@x.com' }], subject: 'Hello', htmlContent: '<p>Hi</p>' });
    expect(sent().attachment).toBeUndefined();
  });

  it('links an inline image by its public address (the guest\'s card also goes as a plain file), and trims a trailing slash from the API address', async () => {
    const { sendEmail, publicApiUrl } = load('https://api.example.com/');
    expect(publicApiUrl()).toBe('https://api.example.com');
    await sendEmail('g@x.com', 'S', '<img src="cid:card-1"><img src="cid:icon-1">', [
      { filename: 'card.png', content: Buffer.from('png'), cid: 'card-1', url: 'https://api.example.com/api/v1/public/invitations/T/card', essential: true },
      { filename: 'icon.png', content: Buffer.from('png'), cid: 'icon-1', url: 'https://api.example.com/api/v1/public/email-assets/icon-1.png' },
    ]);
    expect(sent().htmlContent).toBe('<img src="https://api.example.com/api/v1/public/invitations/T/card"><img src="https://api.example.com/api/v1/public/email-assets/icon-1.png">');
    // only the card the guest needs is also attached; the small icon is just linked
    expect(sent().attachment).toEqual([{ name: 'card.png', content: Buffer.from('png').toString('base64') }]);
  });

  it('an image that can be neither linked nor embedded is removed from the HTML, not left broken', async () => {
    const { sendEmail } = load();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await sendEmail('g@x.com', 'S', '<p>Hi</p><img src="cid:icon-1" width="20"><img src="cid:logo-1">', [
      { filename: 'icon.png', content: Buffer.from('icon'), cid: 'icon-1' },
      { filename: 'logo.png', content: Buffer.from('logo'), cid: 'logo-1' },
    ]);
    expect(sent().htmlContent).toBe('<p>Hi</p>');
  });

  it('without a public address, attaches only the images the guest needs, as plain files', async () => {
    const { sendEmail } = load();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await sendEmail('g@x.com', 'S', '<img src="cid:card-1"><img src="cid:icon-1">', [
      { filename: 'invitation-card.png', content: Buffer.from('card'), cid: 'card-1', essential: true },
      { filename: 'icon.png', content: Buffer.from('icon'), cid: 'icon-1' },
    ]);
    expect(sent().attachment).toEqual([{ name: 'invitation-card.png', content: Buffer.from('card').toString('base64') }]);
  });

  it('reports a refusal with Brevo\'s reason (never the key) and fails the send', async () => {
    const { sendEmail } = load();
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ code: 'invalid_parameter', message: 'Sender is not valid' }) });
    await expect(sendEmail('g@x.com', 'S', '<p>x</p>')).rejects.toThrow('FAILED_TO_SEND_EMAIL');
    expect(JSON.stringify(err.mock.calls)).toMatch(/Sender is not valid/);
    expect(JSON.stringify(err.mock.calls)).not.toMatch(/xkeysib/);
  });

  it('serves the email icons and logo publicly, and nothing else', async () => {
    load();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const app = require('../src/app').default;
    const ok = await request(app).get('/api/v1/public/email-assets/lgpsm-icon-event.png');
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toMatch(/image\/png/);
    expect((await request(app).get('/api/v1/public/email-assets/not-an-image.png')).status).toBe(404);
    expect((await request(app).get('/api/v1/public/email-assets/..%2Fsecret.png')).status).toBe(404);
  });
});
