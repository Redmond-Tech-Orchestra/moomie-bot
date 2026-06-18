import type { CodingAgent } from './agent-types.js';
import { GeminiAgent } from './gemini-cli.js';
import { CodexAgent } from './codex-cli.js';
import { CODING_AGENT } from '../../../config.js';

export type { CodingAgent, AgentTask, AgentResult, CodingProgress, ProgressCallback } from './agent-types.js';

/**
 * Returns the configured coding agent.
 * Set CODING_AGENT env var to switch: "gemini" | "claude" | "codex"
 */
export function getAgent(): CodingAgent {
  const agentName = CODING_AGENT;

  switch (agentName) {
    case 'gemini':
      return new GeminiAgent();
    case 'codex':
      return new CodexAgent();
    // case 'claude':
    //   return new ClaudeAgent();
    default:
      throw new Error(`Unknown coding agent: ${agentName}. Supported: gemini, codex`);
  }
}
