import { Request } from 'express';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      userId?: string;
      userEmail?: string;
    }
  }
}

export interface AuthenticatedRequest extends Request {
  userId: string;
  userEmail?: string;
}





