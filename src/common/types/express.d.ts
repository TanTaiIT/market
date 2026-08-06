import { Role } from '../constants'

// Augment Express Request để gắn user sau khi authenticate.
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string
        role: Role
      }
    }
  }
}
