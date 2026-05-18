export type InspectionErrorCode =
  | "invalid_input"
  | "not_found"
  | "not_a_directory"
  | "not_readable"
  | "inspection_timeout";

export class WorkspaceInspectionError extends Error {
  constructor(
    public readonly code: InspectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceInspectionError";
  }
}

export const invalidInput = (msg: string) =>
  new WorkspaceInspectionError("invalid_input", msg);

export const notFound = (p: string) =>
  new WorkspaceInspectionError("not_found", `Path not found: ${p}`);

export const notADirectory = (p: string) =>
  new WorkspaceInspectionError("not_a_directory", `Not a directory: ${p}`);

export const notReadable = (p: string) =>
  new WorkspaceInspectionError("not_readable", `Not readable: ${p}`);

export const inspectionTimeout = (p: string) =>
  new WorkspaceInspectionError("inspection_timeout", `Inspection timed out: ${p}`);
