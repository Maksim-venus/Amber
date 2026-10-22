import { LOCAL_USER_ID, type User } from "../domain/user.ts";
import type { Repository } from "../ports/repository.ts";

/**
 * Local mode's single implicit user: `User(id = LOCAL_USER_ID, role = "admin")` without
 * credentials. Idempotent, so it runs on every start.
 */
export function ensureLocalUser(repository: Repository, now: () => number = Date.now): User {
  return repository.withTransaction((scope) => {
    const existing = scope.users.get(LOCAL_USER_ID);
    if (existing !== undefined) {
      return existing;
    }
    const user: User = { id: LOCAL_USER_ID, role: "admin", status: "active", createdAt: now() };
    scope.users.insert(user);
    return user;
  });
}
