import { MODEL_CHAT, geminiUrl } from '../../config.js';
import { createLogger } from '../../logger.js';

const log = createLogger('Summarize');

export async function generateIssueTitle(taskDescription: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return taskDescription.split('\n')[0].slice(0, 80);

  try {
    const res = await fetch(`${geminiUrl(MODEL_CHAT)}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `Generate a concise GitHub issue title (max 72 chars) for this task. Return ONLY the title, no quotes or extra text.\n\nTask: ${taskDescription}`,
          }],
        }],
      }),
    });

    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
    const title = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    log.audit({
      type: 'title-gen',
      model: MODEL_CHAT,
      input_summary: taskDescription.slice(0, 500),
      result: title ?? '(empty)',
      tokens_in: data.usageMetadata?.promptTokenCount,
      tokens_out: data.usageMetadata?.candidatesTokenCount,
    });
    return title || taskDescription.split('\n')[0].slice(0, 80);
  } catch (err) {
    log.error('Failed to generate title, using fallback:', err);
    return taskDescription.split('\n')[0].slice(0, 80);
  }
}
