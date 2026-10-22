import { useQuery } from "@tanstack/react-query";
import { adminUserListDtoSchema } from "../../../shared/dto/admin.ts";
import { useApi } from "../../api/context.tsx";

export const adminKeys = {
  users: ["admin", "users"] as const,
  storage: ["admin", "storage"] as const,
  allowlist: ["admin", "network-allowlist"] as const,
};

export function useAdminUsers() {
  const client = useApi();
  return useQuery({ queryKey: adminKeys.users, queryFn: () => client.get("/api/admin/users", adminUserListDtoSchema) });
}
