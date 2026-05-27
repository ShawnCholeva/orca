// interview.ts
import { InterviewTurn, type WorkflowArtifact } from "@orca/contracts";

export function reconstructTranscript(artifacts: WorkflowArtifact[]): InterviewTurn[] {
  const turns: InterviewTurn[] = [];
  for (const a of artifacts) {
    if (a.type !== "interview_turn") continue;
    const parsed = InterviewTurn.safeParse(JSON.parse(a.body));
    if (parsed.success) turns.push(parsed.data);
  }
  return turns.sort((x, y) => x.turnIndex - y.turnIndex);
}

export function nextTurnIndex(artifacts: WorkflowArtifact[]): number {
  return reconstructTranscript(artifacts).reduce((max, t) => Math.max(max, t.turnIndex + 1), 0);
}
