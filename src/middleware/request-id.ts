import { MiddlewareHandler } from 'hono';
import { v4 as uuidv4 } from 'uuid';

export const requestId = (): MiddlewareHandler => {
  return async (c, next) => {
    const id = c.req.header('X-Request-ID') || uuidv4();
    c.set('requestId', id);
    await next();
    c.header('X-Request-ID', id);
  };
};