import { sendEmail } from '../src/utils/email.provider';

describe('sendEmail over the Brevo HTTPS API', () => {
  const original = { ...process.env };
  const fetchMock = jest.fn();

  beforeEach(() => {
    process.env.BREVO_API_KEY = 'test-key';
    process.env.SMTP_FROM = '"LGPSM Events <sender@example.com>"';
    delete process.env.BREVO_SENDER;
    fetchMock.mockReset();
    (global as any).fetch = fetchMock;
  });

  afterAll(() => {
    process.env = original;
  });

  it('posts the message with the parsed sender', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 201 });
    process.env.SMTP_FROM = 'LGPSM Events <sender@example.com>';

    await expect(sendEmail('a@b.com', 'Hi', '<p>x</p>')).resolves.toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(init.headers['api-key']).toBe('test-key');
    expect(JSON.parse(init.body)).toMatchObject({
      sender: { name: 'LGPSM Events', email: 'sender@example.com' },
      to: [{ email: 'a@b.com' }],
      subject: 'Hi',
    });
  });

  it('throws FAILED_TO_SEND_EMAIL when the API rejects the request', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    process.env.SMTP_FROM = 'sender@example.com';

    await expect(sendEmail('a@b.com', 'Hi', '<p>x</p>')).rejects.toThrow('FAILED_TO_SEND_EMAIL');
  });

  it('does not use the API when the message has attachments', async () => {
    process.env.SMTP_HOST = '';
    await expect(
      sendEmail('a@b.com', 'Hi', '<p>x</p>', [{ filename: 'a.png', content: 'x', cid: 'c' }])
    ).rejects.toThrow('PROVIDER_NOT_CONFIGURED');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
