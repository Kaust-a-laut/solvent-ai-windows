import { Response } from 'express';
import { SolventError, getSafeErrorMessage, logError } from './errors';

export interface RouteErrorContext {
  res: Response;
  error: unknown;
  context: string;
  statusCode?: number;
}

export function handleRouteError({ res, error, context, statusCode }: RouteErrorContext) {
  const errorId = logError(context, error);
  if (res.headersSent) return;
  const resolvedStatus = statusCode ?? (error instanceof SolventError ? error.status : 500);
  const message = getSafeErrorMessage(error, context);
  res.status(resolvedStatus).json({ error: message, reference: errorId });
}

