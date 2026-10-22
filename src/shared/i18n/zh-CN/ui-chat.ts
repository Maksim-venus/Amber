/** UI copy of the chat area and the selection toolbar; keys are dot paths under `chat`. */
export const chat = {
  title: "对话",
  placeholder: "就这段内容提问…",
  send: "发送",
  stop: "停止",
  model: "对话模型",
  empty: "就视频内容提问，回答会附带可点的原文出处。",
  collapse: "收起对话",
  expand: "展开对话",
  full: "拉到全高",
  restore: "还原高度",
  clear: "清空对话",
  clearConfirm: "清空后这段内容的全部对话历史将被删除，无法恢复。",
  configure: "去配置",
  suggestions: "推荐追问",
  explainPrompt: "解释一下这句话",
  explainSelectionPrompt: "解释一下「{{text}}」",
  ungrounded: "未依据视频原文",
  metadataHint: "字幕尚未就绪：回答只依据标题等基本信息和模型自身知识，不附原文出处。",
  mode: {
    full: "全文",
    retrieval: "智能检索",
    metadata: "基本信息",
    estimate: "估算约 {{tokens}} tokens",
  },
  unavailable: {
    no_model: "还没有可用的模型，配置后即可对话。",
    context_window_unknown: "该模型未填写上下文窗口大小，对话需要先填写。",
  },
  status: {
    streaming: "生成中…",
    interrupted: "回答已中断，内容不完整",
    failed: "回答失败",
  },
  quote: {
    remove: "移除引用",
  },
  toolbar: {
    label: "划词工具",
    explain: "解释",
    copy: "复制",
  },
} as const;
