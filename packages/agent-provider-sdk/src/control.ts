export type AgentPlanAction = 'approve' | 'approve_and_resume' | 'reject';
export type AgentToolDecision = 'allow' | 'deny';
export type AgentToolApprovalScope = 'once' | 'session';

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
    };

export interface AgentQuestionAnswer {
  questionId: string;
  selectedValues: string[];
  customText?: string;
}

export type AgentInteractionResponse =
  | { kind: 'question'; answers: AgentQuestionAnswer[]; dismissed?: boolean }
  | { kind: 'plan_approval'; action: 'approve' | 'approve_and_resume' }
  | { kind: 'plan_approval'; action: 'reject'; feedback?: string }
  | { kind: 'tool_approval'; decision: 'allow'; scope: AgentToolApprovalScope }
  | { kind: 'tool_approval'; decision: 'deny'; message?: string };
