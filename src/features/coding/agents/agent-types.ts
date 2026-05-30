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

/**
 * A single mid-run progress signal extracted from the agent's transcript.
 * Lets callers surface "what the agent is thinking/doing" while it works,
 * instead of only seeing the final result.
 */
export interface CodingProgress {
  /** Short one-line headline (a thought subject or a tool-call title). */
  headline: string;
  /** Optional longer detail (e.g. a thought description). */
  detail?: string;
  /** Tool name, when the step is a tool call. */
  toolName?: string;
  /** Milliseconds elapsed since the agent run started. */
  elapsedMs: number;
}

/** Optional callback invoked as the agent makes progress during a run. */
export type ProgressCallback = (progress: CodingProgress) => void;

export interface CodingAgent {
  /** Human-readable name for logging */
  name: string;
  /**
   * Execute a coding task in the given working directory.
   * The agent should read files, make changes, and write them back to disk.
   * It should NOT commit or push.
   *
   * `onProgress` (optional) is called as the agent works, so callers can relay
   * intermediate thinking/steps to the user. Agents that can't introspect their
   * own progress may ignore it.
   */
  execute(task: AgentTask, workingDir: string, onProgress?: ProgressCallback): Promise<AgentResult>;
}
