/** Strip the orca:action fenced block from an orchestrator turn, leaving the
 *  reasoning prose. Provisional: the orchestrator currently yields one final
 *  blob per turn (no incremental transcript). Trims; returns "" if nothing left. */
export function extractOrchestratorReasoning(fullText: string): string {
  return fullText.replace(/```orca:action[\s\S]*?```/g, "").trim();
}
