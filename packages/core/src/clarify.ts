/**
 * Clarify — ask Rafael questions during Organism execution.
 * Currently uses CLI stdin/stdout. Telegram integration planned.
 */

import * as readline from 'readline';

export interface Clarification {
  question: string;
  answer: string;
  context?: string;
  askedAt: number;
  answeredAt: number;
}

/**
 * Ask Rafael a question interactively via the CLI.
 * Returns the answer as a string.
 */
export async function askRafael(question: string, context?: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log('');
    if (context) {
      console.log(`  Context: ${context}`);
    }
    rl.question(`  [Organism asks] ${question}\n  > `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Ask multiple questions in sequence. Returns all Q&A pairs.
 */
export async function askMultiple(
  questions: Array<{ question: string; context?: string }>,
): Promise<Clarification[]> {
  const results: Clarification[] = [];
  for (const q of questions) {
    const askedAt = Date.now();
    const answer = await askRafael(q.question, q.context);
    results.push({
      question: q.question,
      answer,
      context: q.context,
      askedAt,
      answeredAt: Date.now(),
    });
  }
  return results;
}
