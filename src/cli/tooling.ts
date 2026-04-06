/** @format */

export const TOOL_NAME_GET_FILE = "get_file_at_ref";
export const TOOL_NAME_GREP = "grep_repository";
export const MAX_TOOL_ROUNDS = 12;
export const MAX_FILE_TOOL_ROUNDS = 5;
/** Pass 4 (verification): confirm drafts against repo without duplicating main-review depth. */
export const MAX_VERIFICATION_TOOL_ROUNDS = 10;

export function logToolUsageMinimal(
  logStep: (message: string) => void,
  toolName: string,
  argsRaw: string,
  contextFile?: string,
): void {
  try {
    const parsed = JSON.parse(argsRaw) as { path?: string; query?: string };
    if (toolName === TOOL_NAME_GET_FILE) {
      const path = parsed.path?.trim() || "(unknown-path)";
      const suffix = contextFile ? ` review_file=${contextFile}` : "";
      logStep(`[tools] ${toolName} path=${path}${suffix}`);
      return;
    }
    if (toolName === TOOL_NAME_GREP) {
      const query = parsed.query?.trim() || "(empty-query)";
      const suffix = contextFile ? ` review_file=${contextFile}` : "";
      logStep(`[tools] ${toolName} query=${query}${suffix}`);
      return;
    }
  } catch {
    // Fall through to raw args logging.
  }
  const suffix = contextFile ? ` review_file=${contextFile}` : "";
  logStep(`[tools] ${toolName} args=${argsRaw.slice(0, 120)}${suffix}`);
}

