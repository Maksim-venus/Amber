import { useQuery } from "@tanstack/react-query";
import { chatDtoSchema } from "../../shared/dto/chat.ts";
import type { ModelRefDto } from "../../shared/dto/model-ref.ts";
import type { ProviderProfileDto } from "../../shared/dto/provider.ts";
import type { UserSettingsDto } from "../../shared/dto/settings.ts";
import { queryString } from "../api/queries.ts";
import { useApi } from "../api/context.tsx";

/**
 * How often the history is read again while an answer is still `streaming` on the server: a
 * stopped answer is stored as `interrupted` only once the server has seen the disconnect.
 */
const STREAMING_REFRESH_MS = 1000;

export const chatKeys = {
  all: (contentId: string) => ["chat", contentId] as const,
  thread: (contentId: string, modelRef: ModelRefDto | undefined) =>
    ["chat", contentId, modelRef?.providerProfileId ?? "", modelRef?.modelId ?? ""] as const,
};

/** A model the dialogue can use, with the label of the model selector. */
export interface ChatModelOption {
  modelRef: ModelRefDto;
  label: string;
}

export function modelKey(modelRef: ModelRefDto): string {
  return `${modelRef.providerProfileId}\u0000${modelRef.modelId}`;
}

/** Every model of a Profile with a stored credential, in the user's order. */
export function chatModelOptions(profiles: readonly ProviderProfileDto[]): ChatModelOption[] {
  return profiles
    .filter((profile) => profile.hasCredential)
    .flatMap((profile) =>
      profile.models.map((model) => ({ modelRef: { providerProfileId: profile.id, modelId: model.modelId }, label: `${profile.name} · ${model.modelId}` })),
    );
}

/** The selector's default: the last chat model, then the default model, then the first one listed. */
export function defaultChatModel(options: readonly ChatModelOption[], settings: UserSettingsDto | undefined): ModelRefDto | undefined {
  const listed = (modelRef: ModelRefDto | undefined): ModelRefDto | undefined =>
    modelRef === undefined ? undefined : options.find((option) => modelKey(option.modelRef) === modelKey(modelRef))?.modelRef;
  return listed(settings?.chatModelRef) ?? listed(settings?.defaultModelRef) ?? options[0]?.modelRef;
}

/** `GET /api/contents/:id/chat` for the selected model: history plus the context the next question would get. */
export function useChat(contentId: string, modelRef: ModelRefDto | undefined, enabled = true) {
  const client = useApi();
  return useQuery({
    queryKey: chatKeys.thread(contentId, modelRef),
    queryFn: () =>
      client.get(
        `/api/contents/${encodeURIComponent(contentId)}/chat${queryString({ providerProfileId: modelRef?.providerProfileId, modelId: modelRef?.modelId })}`,
        chatDtoSchema,
      ),
    enabled,
    // The context depends on model settings edited elsewhere; read it afresh on every mount.
    staleTime: 0,
    refetchInterval: (query) => (query.state.data?.messages.some((message) => message.status === "streaming") === true ? STREAMING_REFRESH_MS : false),
  });
}
