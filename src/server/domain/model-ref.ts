/**
 * Model identity is "which model of which Profile": two relays exposing the same model
 * name must stay distinguishable.
 */
export interface ModelRef {
  providerProfileId: string;
  modelId: string;
}

/** "Which model of which ASR profile". */
export interface AsrModelRef {
  asrProfileId: string;
  modelId: string;
}

/** Keeps historical artifacts explainable after the Profile is renamed or deleted. */
export interface ModelRefSnapshot extends ModelRef {
  providerNameSnapshot: string;
  modelDisplaySnapshot: string;
}

/** Identity of a builtin or custom prompt / template version. */
export interface PromptRef {
  id: string;
  version: number;
}
