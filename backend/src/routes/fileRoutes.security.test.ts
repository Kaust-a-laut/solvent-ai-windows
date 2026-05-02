import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import fileRoutes from './fileRoutes';
import { config } from '../config';

vi.mock('../services/toolService', () => ({
  toolService: {
    executeTool: vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '' }),
  },
}));

const app = express();
app.use((req, _res, next) => {
  req.id = 'test-request';
  next();
});
app.use(express.json());
app.use('/api/files', fileRoutes);

describe('file route security', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.SOLVENT_ENABLE_HTTP_SHELL = false;
  });

  it('rejects traversal in project listing before creating directories', async () => {
    const response = await request(app).get('/api/files/list').query({ project: '../outside' });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Access denied');
  });

  it('rejects traversal in raw file reads', async () => {
    const response = await request(app).get('/api/files/raw').query({ path: '../package.json' });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Access denied');
  });

  it('blocks HTTP shell execution when disabled', async () => {
    const response = await request(app)
      .post('/api/files/shell')
      .send({ command: 'echo hi' });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('HTTP shell execution is disabled');
  });
});
