import { z } from "zod";

/**
 * Catálogo de tipos de Case e agente dono padrão. Novos tipos entram aqui e
 * no catálogo da arquitetura (seção 4), com a condição objetiva de encerramento.
 */
export const CASE_TYPES = {
  CLIENT_ONBOARDING: { owner: "one-onboarding", requiresEntity: false },
  ACCOUNTING_FIRM_MIGRATION: { owner: "one-implementation", requiresEntity: true },
  ACCOUNTING_CLOSING: { owner: "one-ledger", requiresEntity: true },
  TAX_CLOSING: { owner: "one-tax", requiresEntity: true },
  PAYROLL_CLOSING: { owner: "one-payroll", requiresEntity: true },
  EMPLOYEE_ADMISSION: { owner: "one-payroll", requiresEntity: true },
  EMPLOYEE_TERMINATION: { owner: "one-payroll", requiresEntity: true },
  VACATION: { owner: "one-payroll", requiresEntity: true },
  COMPANY_OPENING: { owner: "one-corporate", requiresEntity: false },
  COMPANY_CHANGE: { owner: "one-corporate", requiresEntity: true },
  COMPANY_CLOSURE: { owner: "one-corporate", requiresEntity: true },
  NEW_BRANCH: { owner: "one-corporate", requiresEntity: true },
  TAX_REGIME_CHANGE: { owner: "one-tax", requiresEntity: true },
  SCP_CREATION: { owner: "one-corporate", requiresEntity: true },
  BANK_RECONCILIATION: { owner: "one-reconciliation", requiresEntity: true },
  SPED_SUBMISSION: { owner: "one-sped", requiresEntity: true },
  ECD_SUBMISSION: { owner: "one-ecd", requiresEntity: true },
  ECF_SUBMISSION: { owner: "one-ecf", requiresEntity: true },
  TAX_NOTICE: { owner: "one-regularization", requiresEntity: true },
  DOCUMENT_REQUEST: { owner: "one-collection", requiresEntity: true },
  NONPROFIT_ACCOUNTABILITY: { owner: "one-ledger", requiresEntity: true },
  REGULARIZATION: { owner: "one-regularization", requiresEntity: true },
  TAX_REFUND: { owner: "one-regularization", requiresEntity: true },
  TAX_COMPENSATION: { owner: "one-regularization", requiresEntity: true },
  EXCEPTION: { owner: "one-orchestrator", requiresEntity: false },
} as const;

export type CaseType = keyof typeof CASE_TYPES;
export const CaseTypeSchema = z.enum(Object.keys(CASE_TYPES) as [CaseType, ...CaseType[]]);
