import { z } from "zod";

/**
 * Catálogo de tipos de Case e agente dono padrão. Novos tipos entram aqui e
 * no catálogo da arquitetura (seção 4), com a condição objetiva de encerramento.
 */
export const CASE_TYPES = {
  CLIENT_ONBOARDING: { owner: "onboarding", requiresEntity: false },
  ACCOUNTING_FIRM_MIGRATION: { owner: "implementation", requiresEntity: true },
  ACCOUNTING_CLOSING: { owner: "ledger", requiresEntity: true },
  TAX_CLOSING: { owner: "tax", requiresEntity: true },
  PAYROLL_CLOSING: { owner: "payroll", requiresEntity: true },
  EMPLOYEE_ADMISSION: { owner: "payroll", requiresEntity: true },
  EMPLOYEE_TERMINATION: { owner: "payroll", requiresEntity: true },
  VACATION: { owner: "payroll", requiresEntity: true },
  COMPANY_OPENING: { owner: "corporate", requiresEntity: false },
  COMPANY_CHANGE: { owner: "corporate", requiresEntity: true },
  COMPANY_CLOSURE: { owner: "corporate", requiresEntity: true },
  NEW_BRANCH: { owner: "corporate", requiresEntity: true },
  TAX_REGIME_CHANGE: { owner: "tax", requiresEntity: true },
  SCP_CREATION: { owner: "corporate", requiresEntity: true },
  BANK_RECONCILIATION: { owner: "reconciliation", requiresEntity: true },
  SPED_SUBMISSION: { owner: "sped", requiresEntity: true },
  ECD_SUBMISSION: { owner: "ecd", requiresEntity: true },
  ECF_SUBMISSION: { owner: "ecf", requiresEntity: true },
  TAX_NOTICE: { owner: "regularization", requiresEntity: true },
  DOCUMENT_REQUEST: { owner: "collection", requiresEntity: true },
  NONPROFIT_ACCOUNTABILITY: { owner: "ledger", requiresEntity: true },
  REGULARIZATION: { owner: "regularization", requiresEntity: true },
  TAX_REFUND: { owner: "regularization", requiresEntity: true },
  TAX_COMPENSATION: { owner: "regularization", requiresEntity: true },
  EXCEPTION: { owner: "orchestrator", requiresEntity: false },
} as const;

export type CaseType = keyof typeof CASE_TYPES;
export const CaseTypeSchema = z.enum(Object.keys(CASE_TYPES) as [CaseType, ...CaseType[]]);
