/**
 * Coding Agent Interface
 *
 * All coding agents must implement this interface.
 * The agent receives a task and a working directory (a cloned repo),
 * makes code changes on disk, and returns a result.
 *
 * The agent does NOT handle git operations (branch, commit, push, PR) —
 * the orchestrator handles that.
 */

export interface AgentTask {
  /** Natural language description of what to do */
  prompt: string;
}

export interface AgentResult {
  success: boolean;
  /** Summary of what the agent did (for PR description) */
  summary: string;
  /** Error message if failed */
  error?: string;
}

export interface CodingAgent {
  /** Human-readable name for logging */
  name: string;
  /**
   * Execute a coding task in the given working directory.
   * The agent should read files, make changes, and write them back to disk.
   * It should NOT commit or push.
   */
  execute(task: AgentTask, workingDir: string): Promise<AgentResult>;
}
