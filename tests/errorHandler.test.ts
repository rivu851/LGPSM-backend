import express from 'express';
import request from 'supertest';
import { errorHandler, notFoundHandler } from '../src/middlewares/errorHandler';

function makeErrorApp(error: unknown) {
  const testApp = express();
  testApp.get('/error', (_req, _res, next) => next(error));
  testApp.use(errorHandler);
  return testApp;
}

describe('central error handler', () => {
  it.each([
    [{ name: 'CastError', path: '_id', message: 'Cast failed' }, 400, 'Invalid _id format'],
    [{ name: 'ValidationError', message: 'Title is required' }, 400, 'Title is required'],
    [{ name: 'ZodError', issues: [{ path: ['email'], message: 'Invalid email' }] }, 400, 'Validation failed: email: Invalid email'],
    [{ name: 'JsonWebTokenError', message: 'invalid signature' }, 401, 'Invalid or expired token'],
    [{ code: 11000, message: 'duplicate key' }, 409, 'A record with the same unique value already exists'],
    [{ type: 'entity.too.large', message: 'body too large' }, 413, 'Request body is too large'],
    [{ name: 'MulterError', code: 'LIMIT_FILE_SIZE', message: 'file too large' }, 413, 'Uploaded file is too large'],
    [{ statusCode: 422, message: 'Invalid input' }, 422, 'Invalid input'],
    [{ status: 200, message: 'Incorrect status' }, 500, 'Internal Server Error'],
    [{ statusCode: 503, message: 'database connection failed' }, 503, 'Internal Server Error'],
    [{ message: 'database connection failed' }, 500, 'Internal Server Error'],
  ])('returns the appropriate response for %o', async (error, status, message) => {
    const response = await request(makeErrorApp(error)).get('/error');

    expect(response.status).toBe(status);
    expect(response.body).toMatchObject({ success: false, message });
  });

  it('returns a JSON 404 response for unmatched routes', async () => {
    const testApp = express();
    testApp.use(notFoundHandler);
    const response = await request(testApp).get('/api/route-that-does-not-exist');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ success: false, message: 'Route not found' });
  });

  it('returns a clear client error for malformed JSON', async () => {
    const testApp = express();
    testApp.use(express.json());
    testApp.post('/json', (_req, res) => res.sendStatus(204));
    testApp.use(errorHandler);

    const response = await request(testApp)
      .post('/json')
      .set('Content-Type', 'application/json')
      .send('{"broken":');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ success: false, message: 'Malformed JSON request body' });
  });
});
