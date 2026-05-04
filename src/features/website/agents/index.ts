import type { CodingAgent } from './types.js';
import { GeminiAgent } from './gemini.js';

export type { CodingAgent, AgentTask, AgentResult } from './types.js';

/**
 * Returns the configured coding agent.
 * Set CODING_AGENT env var to switch: "gemini" | "claude" | "codex"
 */
export function getAgent(): CodingAgent {
  const agentName = process.env.CODING_AGENT || 'gemini';

  switch (agentName) {
    case 'gemini':
      return new GeminiAgent();
    // case 'claude':
    //   return new ClaudeAgent();
    // case 'codex':
    //   return new CodexAgent();
    default:
      throw new Error(`Unknown coding agent: ${agentName}. Supported: gemini`);
  }
}
