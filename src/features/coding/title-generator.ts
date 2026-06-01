import { generateText } from 'ai';
import { modelFor } from '../../config.js';
import { getModel } from '../../llm.js';
import { createLogger } from '../../logger.js';

const log = createLogger('Summarize');

export async function generateIssueTitle(taskDescription: string): Promise<string> {
  const fallback = taskDescription.split('\n')[0].slice(0, 80);

  try {
    const { text, usage } = await generateText({
      model: getModel('chat'),
      prompt: `Generate a concise GitHub issue title (max 72 chars) for this task. Return ONLY the title, no quotes or extra text.\n\nTask: ${taskDescription}`,
    });

    const title = text.trim();
    log.audit({
      type: 'title-gen',
      model: modelFor('chat'),
      input_summary: taskDescription.slice(0, 500),
      result: title || '(empty)',
      tokens_in: usage.inputTokens,
      tokens_out: usage.outputTokens,
    });
    return title || fallback;
  } catch (err) {
    log.error('Failed to generate title, using fallback:', err);
    return fallback;
  }
}
