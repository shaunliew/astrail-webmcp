/**
 * Local mirror of the WebMCP tool shape.
 *
 * We register through `use-webmcp-tool` (Chrome's hook), but the SPECS are plain data produced
 * by pure factory functions. That separation is what lets the contract test validate every
 * tool's name, description length and schema without mounting React — and a tool whose
 * registration is silently rejected (duplicate name, empty description, bad schema) is an
 * absent tool that nobody notices until a judge does.
 */

export type JsonSchema = {
  type: 'object'
  properties?: Record<string, { type: string; description?: string; enum?: readonly string[]; items?: unknown; minimum?: number }>
  required?: string[]
  additionalProperties?: boolean
}

export type ToolAnnotations = {
  /** True only if calling it is safe to do speculatively, unnoticed. A camera fly is NOT. */
  readOnlyHint?: boolean
  /** True if any part of the output can originate from an Instagram caption. */
  untrustedContentHint?: boolean
}

export type ToolSpec = {
  name: string
  description: string
  inputSchema?: JsonSchema
  annotations?: ToolAnnotations
  execute: (args: Record<string, unknown>) => unknown | Promise<unknown>
}

/** Budgets from Chrome's tool-security guidance. Enforced by the contract test, not by hope. */
export const LIMITS = {
  NAME: 30,
  DESCRIPTION: 500,
  PARAM_DESCRIPTION: 150,
} as const
