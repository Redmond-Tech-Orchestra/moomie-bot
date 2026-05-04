const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

export async function generateIssueTitle(taskDescription: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return taskDescription.split('\n')[0].slice(0, 80);

  try {
    const res = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
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
    const data = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const title = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return title || taskDescription.split('\n')[0].slice(0, 80);
  } catch (err) {
    console.error('[Summarize] Failed to generate title, using fallback:', err);
    return taskDescription.split('\n')[0].slice(0, 80);
  }
}
