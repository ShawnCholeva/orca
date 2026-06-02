import {
  createWorkflowTemplate,
  duplicateWorkflowTemplate,
  listWorkflowTemplates,
  updateWorkflowTemplate,
} from "../api";
import type { CreateWorkflowTemplateRequest, WorkflowTemplate } from "@orca/contracts";

export type WorkflowTemplateInput = CreateWorkflowTemplateRequest;

export type TemplateResult = {
  template: WorkflowTemplate;
  warnings: string[];
};

export async function listTemplates() {
  return listWorkflowTemplates();
}

export async function createTemplate(input: WorkflowTemplateInput): Promise<TemplateResult> {
  const response = await createWorkflowTemplate(input);
  return { template: response.template, warnings: response.warnings };
}

export async function saveTemplate(
  id: string,
  input: WorkflowTemplateInput,
): Promise<TemplateResult> {
  const response = await updateWorkflowTemplate(id, input);
  return { template: response.template, warnings: response.warnings };
}

export async function duplicateTemplate(
  sourceTemplateId: string,
  name: string,
): Promise<TemplateResult> {
  const response = await duplicateWorkflowTemplate(sourceTemplateId, {
    sourceTemplateId,
    name,
  });
  return { template: response.template, warnings: response.warnings };
}
