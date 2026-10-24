import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
  merchantId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();
