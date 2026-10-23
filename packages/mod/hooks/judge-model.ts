// OpenCode Zen's presets.ts note documents jev's /systemone-only judging shape:
// it cannot answer an ordinary chat/Responses/Messages turn. Keep it configurable
// for judges, but never advertise it as a chat model or generate a worker for it.
export function isJudgeOnlyModel(modelId: string): boolean {
  return modelId.toLowerCase().startsWith('jev')
}
