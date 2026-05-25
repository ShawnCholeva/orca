import {
  createWorkflowTemplate,
  duplicateWorkflowTemplate,
  getWorkflowTemplate,
  listWorkflowTemplates,
  updateWorkflowTemplate,
} from "../api";
import type { CreateWorkflowTemplateRequest, WorkflowTemplate } from "@orca/contracts";

export type WorkflowTemplateInput = CreateWorkflowTemplateRequest;

export async function listTemplates() {
  return listWorkflowTemplates();
}

export async function getTemplate(id: string) {
  return getWorkflowTemplate(id);
}

export async function createTemplate(input: WorkflowTemplateInput): Promise<WorkflowTemplate> {
  const response = await createWorkflowTemplate(input);
  return response.template;
}

export async function saveTemplate(
  id: string,
  input: WorkflowTemplateInput,
): Promise<WorkflowTemplate> {
  const response = await updateWorkflowTemplate(id, input);
  return response.template;
}

export async function duplicateTemplate(
  sourceTemplateId: string,
  name: string,
): Promise<WorkflowTemplate> {
  const response = await duplicateWorkflowTemplate(sourceTemplateId, {
    sourceTemplateId,
    name,
  });
  return response.template;
}
