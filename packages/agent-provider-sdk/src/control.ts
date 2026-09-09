export type AgentPlanAction = 'approve' | 'approve_and_resume' | 'reject';
export type AgentToolDecision = 'allow' | 'deny' | 'cancel';
export type AgentToolApprovalScope = 'once' | 'session' | 'policy';

export type AgentToolDetail =
  | { type: 'shell'; command: string; cwd?: string }
  | { type: 'read'; filePath: string }
  | { type: 'edit'; filePath: string }
  | { type: 'write'; filePath: string }
  | { type: 'search'; query: string }
  | { type: 'fetch'; url: string }
  | { type: 'other'; description: string };

export interface AgentQuestionOption {
  value: string;
  label: string;
  description?: string;
}

export interface AgentQuestion {
  questionId: string;
  header: string;
  prompt: string;
  description?: string;
  required: boolean;
  selection: 'single' | 'multiple';
  options: AgentQuestionOption[];
  allowCustomText: boolean;
  allowDismiss: boolean;
  sensitive?: boolean;
}

export interface AgentFormOption {
  value: string;
  label: string;
}

interface AgentFormFieldBase {
  fieldId: string;
  label: string;
  required: boolean;
  description?: string;
  sensitive?: boolean;
}

export type AgentFormField = AgentFormFieldBase & (
  | { type: 'text'; minLength?: number; maxLength?: number; format?: 'email' | 'uri' | 'date' | 'date-time'; defaultValue?: string }
  | { type: 'number'; integer?: boolean; minimum?: number; maximum?: number; defaultValue?: number }
  | { type: 'boolean'; defaultValue?: boolean }
  | { type: 'select'; options: AgentFormOption[]; defaultValue?: string }
  | { type: 'multiselect'; options: AgentFormOption[]; minItems?: number; maxItems?: number; defaultValue?: string[] }
);

export type AgentFormValue = string | number | boolean | string[];
export type AgentFormValues = Record<string, AgentFormValue>;
export type AgentPermissionScope = 'turn' | 'session';
export interface AgentPermission {
  resource: 'filesystem' | 'network';
  access: 'read' | 'write' | 'deny' | 'connect';
  target: string;
}

export type AgentInteractionRequest =
  | { kind: 'question'; requestId: string; questions: AgentQuestion[] }
  | { kind: 'plan_approval'; requestId: string; plan: string; allowedActions: AgentPlanAction[] }
  | {
      kind: 'tool_approval';
      requestId: string;
      toolCallId: string;
      toolName: string;
      summary: string;
      detail: AgentToolDetail;
      allowedDecisions: AgentToolDecision[];
      allowScopes: AgentToolApprovalScope[];
      policies?: { policyId: string; description: string }[];
      context?: { label: string; value: string }[];
    }
  | { kind: 'form'; requestId: string; title: string; message: string; fields: AgentFormField[] }
  | { kind: 'permission_approval'; requestId: string; summary: string; permissions: AgentPermission[]; allowScopes: AgentPermissionScope[] }
  | { kind: 'external_action'; requestId: string; title: string; message: string; url: string };

export interface AgentQuestionAnswer {
  questionId: string;
  selectedValues: string[];
  customText?: string;
  redacted?: boolean;
}

export type AgentInteractionResponse =
  | { kind: 'question'; answers: AgentQuestionAnswer[]; dismissed?: boolean }
  | { kind: 'plan_approval'; action: 'approve' | 'approve_and_resume' }
  | { kind: 'plan_approval'; action: 'reject'; feedback?: string }
  | { kind: 'tool_approval'; decision: 'allow'; scope: 'once' | 'session' }
  | { kind: 'tool_approval'; decision: 'allow'; scope: 'policy'; policyId: string }
  | { kind: 'tool_approval'; decision: 'deny' | 'cancel'; message?: string }
  | { kind: 'form'; action: 'submit'; values: AgentFormValues; redactedFields?: string[] }
  | { kind: 'form'; action: 'decline' | 'cancel' }
  | { kind: 'permission_approval'; decision: 'allow'; scope: AgentPermissionScope }
  | { kind: 'permission_approval'; decision: 'deny' }
  | { kind: 'external_action'; action: 'completed' | 'decline' | 'cancel' };
