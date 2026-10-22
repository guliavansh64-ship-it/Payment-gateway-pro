import type { Merchant, User } from '../domain/models';
import type { SessionRecord } from '../domain/models';

declare global {
  namespace Express {
    interface Request {
      auth?: {
        user: User;
        session: SessionRecord;
        csrfToken: string;
      };
      merchant?: Merchant;
      requestId: string;
    }
  }
}

export {};
