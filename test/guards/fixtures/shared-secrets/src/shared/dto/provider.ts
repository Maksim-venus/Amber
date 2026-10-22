import { z } from "zod";

export interface ProviderCredentialView {
  hasCredential: boolean;
  apiKey: string;
}

export type CookiePayload = { value: string };

export const platformCookieSchema = z.object({ cookie: z.string() });
