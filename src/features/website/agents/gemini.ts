import { spawn } from 'node:child_process';
import path from 'node:path';
import type { CodingAgent, AgentTask, AgentResult } from './types.js';

const POLICY_PATH = path.resolve('policies', 'agent-sandbox.toml');

export class GeminiAgent implements CodingAgent {
  name = 'Gemini CLI';

  async execute(task: AgentTask, workingDir: string): Promise<AgentResult> {
    const prompt = this.buildPrompt(task);

    try {
      const output = await this.runGemini(prompt, workingDir);
      return {
        success: true,
        summary: output.slice(0, 2000) || 'Changes applied by Gemini CLI.',
      };
    } catch (err) {
      return {
        success: false,
        summary: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private buildPrompt(task: AgentTask): string {
    let prompt = task.prompt;
    if (task.referenceFiles && task.referenceFiles.length > 0) {
      prompt += `\n\nReference files to use:\n${task.referenceFiles.map((f) => `- ${f}`).join('\n')}`;
    }
    prompt += '\n\nMake the necessary code changes directly. Do not ask questions — just implement the task.';
    return prompt;
  }

  private static IDLE_TIMEOUT = 5 * 60 * 1000;  // 5 min no output → kill
  private static MAX_TIMEOUT = 30 * 60 * 1000;  // 30 min hard cap

  private runGemini(prompt: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const model = process.env.GEMINI_MODEL;
      const args = ['--yolo', '--skip-trust', '--policy', POLICY_PATH, '-p', '-'];
      if (model) args.push('-m', model);

      const child = spawn('gemini', args, {
        cwd,
        env: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: 'true' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Write prompt via stdin to avoid shell quoting issues
      child.stdin.write(prompt);
      child.stdin.end();

      let stdout = '';
      let stderr = '';
      let settled = false;

      const kill = (reason: string) => {
        if (settled) return;
        settled = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000);
        reject(new Error(reason));
      };

      // Idle timeout — resets on any output
      let idleTimer = setTimeout(() => kill('Gemini CLI timed out (no output for 5 minutes)'), GeminiAgent.IDLE_TIMEOUT);
      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => kill('Gemini CLI timed out (no output for 5 minutes)'), GeminiAgent.IDLE_TIMEOUT);
      };

      // Hard max timeout
      const maxTimer = setTimeout(() => kill('Gemini CLI timed out (30 minute maximum exceeded)'), GeminiAgent.MAX_TIMEOUT);

      child.stdout.on('data', (data) => { stdout += data.toString(); resetIdle(); });
      child.stderr.on('data', (data) => { stderr += data.toString(); resetIdle(); });

      child.on('close', (code) => {
        clearTimeout(idleTimer);
        clearTimeout(maxTimer);
        if (settled) return;
        settled = true;
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Gemini CLI exited with code ${code}: ${stderr || stdout}`));
        }
      });

      child.on('error', (err) => {
        clearTimeout(idleTimer);
        clearTimeout(maxTimer);
        if (settled) return;
        settled = true;
        reject(new Error(`Failed to spawn Gemini CLI: ${err.message}`));
      });
    });
  }
}
