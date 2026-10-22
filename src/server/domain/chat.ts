import type { ChatMessageStatus } from "../../shared/enums.ts";
import type { Citation } from "./artifact.ts";
import type { ModelRefSnapshot, PromptRef } from "./model-ref.ts";

/** One persistent conversation per Content. */
export interface ChatThread {
  id: string;
  contentId: string;
  currentCompactionId?: string;
}

/** Rolling summary produced by the chat context policy; an immutable AI artifact with provenance. */
export interface ChatCompaction {
  id: string;
  threadId: string;
  throughMessageId: string;
  body: string;
  modelRef: ModelRefSnapshot;
  promptRef: PromptRef;
  promptSnapshot: string;
  createdAt: number;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  /** Citations appear as canonical `[[seg:<segmentId>]]` markers. */
  text: string;
  /** A half-streamed answer must never look complete after a reload. */
  status: ChatMessageStatus;
  modelRef?: ModelRefSnapshot;
  /** Fixed to the primary revision at the time the message was answered. */
  contextTranscriptRevisionId?: string;
  citations: Citation[];
  suggestions?: string[];
  createdAt: number;
}
