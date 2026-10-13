#!/usr/bin/env -S npx tsx
/**
 * Finch provider CLI — runs the server (`start`), or starts an interactive
 * REPL against the agent (`ask`).
 *
 * Subcommands:
 *   start                  Start the HTTP server with config from env
 *                          (MOCK_REQUEST_SECRET etc). Same as `npx tsx
 *                          src/provider.ts`.
 *   ask [--prompt "..."]   Interactive REPL. Type messages, get replies
 *                          from the configured LLM via the agent. Use
 *                          /exit to quit, /clear to reset history.
 *                          Optional --prompt sends a single prompt and
 *                          prints the response, then exits.
 *
 * The REPL uses the same LlmProvider and the same BUILTIN_TOOLS as the
 * P1 protocol handler — so anything you build in the REPL is what your
 * Finch provider will say to the merchant on the wire.
 */

import * as readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { runAgentTurn, type AgentEvent } from './agent.ts';
import { createLlmProvider, type LlmConfig } from './llm.ts';

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  gray: '\x1b[90m',
};

function color(c: keyof typeof COLORS, s: string): string {
  return process.stdout.isTTY ? `${COLORS[c]}${s}${COLORS.reset}` : s;
}

function readLlmConfigFromEnv(): LlmConfig {
  const baseUrl = process.env.LLM_BASE_URL ?? 'https://agw.k0s.io/v1';
  const apiKey = process.env.LLM_API_KEY ?? '-';
  const model = process.env.LLM_MODEL ?? 'MiniMax-M3';
  const systemPrompt = process.env.LLM_SYSTEM_PROMPT ?? 'You are a helpful agent. Be concise.';
  const maxTokens = parseInt(process.env.LLM_MAX_TOKENS ?? '1024', 10);
  const timeoutMs = parseInt(process.env.LLM_TIMEOUT_MS ?? '30000', 10);
  return { baseUrl, apiKey, model, systemPrompt, maxTokens, timeoutMs };
}

function newSessionId(): string {
  return `cli-${randomUUID()}`;
}

async function runPrompt(
  cfg: LlmConfig,
  history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
  userMessage: string,
  onEvent?: (ev: AgentEvent) => void,
): Promise<{ text: string; usage: { input_tokens: number; output_tokens: number }; steps: number }> {
  const llm = createLlmProvider(cfg);
  const resp = await runAgentTurn(
    {
      llm,
      systemPrompt: cfg.systemPrompt,
      model: cfg.model,
      maxTokens: cfg.maxTokens,
      onEvent,
    },
    history,
    userMessage,
  );
  return { text: resp.text, usage: resp.usage, steps: resp.steps };
}

async function askSubcommand(argv: string[]): Promise<void> {
  // Parse --prompt "..."
  let oneShot: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--prompt' && i + 1 < argv.length) {
      oneShot = argv[i + 1]!;
      i++;
    } else if (argv[i]?.startsWith('--prompt=')) {
      oneShot = argv[i]!.slice('--prompt='.length);
    }
  }

  const cfg = readLlmConfigFromEnv();
  const history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];

  if (oneShot !== undefined) {
    const resp = await runPrompt(cfg, history, oneShot, (ev) => {
      if (ev.kind === 'tool_call') {
        console.error(color('dim', `  ⚙ ${ev.name}(${JSON.stringify(ev.args)})`));
      } else if (ev.kind === 'tool_result') {
        console.error(color('dim', `  → ${ev.preview}`));
      }
    });
    console.log(resp.text);
    return;
  }

  // Interactive REPL
  console.log(color('bold', 'Finch provider REPL'));
  console.log(color('dim', `  model: ${cfg.model}`));
  console.log(color('dim', `  base:  ${cfg.baseUrl}`));
  console.log(color('dim', '  type /exit to quit, /clear to reset history, /tools to list tools\n'));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const prompt = color('cyan', 'you › ');
  const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, res));

  // Make sure we exit on SIGINT
  process.on('SIGINT', () => {
    console.log('\n' + color('dim', 'bye'));
    rl.close();
    process.exit(0);
  });

  while (true) {
    let userInput: string;
    try {
      userInput = (await ask(prompt)).trim();
    } catch {
      break;
    }
    if (!userInput) continue;
    if (userInput === '/exit' || userInput === '/quit') break;
    if (userInput === '/clear') {
      history.length = 0;
      console.log(color('dim', '(history cleared)'));
      continue;
    }
    if (userInput === '/tools') {
      const { BUILTIN_TOOLS } = await import('./llm.ts');
      for (const t of BUILTIN_TOOLS) {
        console.log(`  • ${t.function.name} — ${t.function.description}`);
      }
      continue;
    }

    process.stdout.write(color('green', 'agent › '));
    let firstChunk = true;
    try {
      // For the REPL we don't stream to the terminal (would require ANSI
      // handling for partial JSON deltas). Use complete() with a spinner.
      const spinnerFrames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
      let i = 0;
      const spinner = setInterval(() => {
        if (firstChunk) process.stdout.write('\b'.repeat(spinnerFrames[i]!.length + 2) + spinnerFrames[i]! + '  ');
        i = (i + 1) % spinnerFrames.length;
      }, 80);

      const resp = await runPrompt(cfg, history, userInput, (ev) => {
        if (ev.kind === 'tool_call') {
          clearInterval(spinner);
          process.stdout.write('\n' + color('yellow', `  ⚙ ${ev.name}(${JSON.stringify(ev.args)})`));
          firstChunk = false;
        } else if (ev.kind === 'tool_result') {
          process.stdout.write('\n' + color('dim', `  → ${ev.preview}`));
        }
      });
      clearInterval(spinner);
      if (!firstChunk) process.stdout.write('\n');
      process.stdout.write('\b\b\b\b\b\b\b\b\b\b');
      console.log(resp.text);
      const usageLine = color('dim', `  [${resp.steps} step(s), ${resp.usage.input_tokens}+${resp.usage.output_tokens} tok]`);
      console.log(usageLine);
      history.push({ role: 'user', content: userInput });
      history.push({ role: 'assistant', content: resp.text });
    } catch (e) {
      console.log(color('yellow', `\n(error) ${e instanceof Error ? e.message : String(e)}`));
    }
    console.log();
  }
  rl.close();
}

async function startSubcommand(): Promise<void> {
  // Delegate to the provider's main entry. Re-import here to avoid pulling
  // the http server into the REPL process.
  const { startServer, readConfig } = await import('./provider.ts');
  const cfg = readConfig();
  const s = startServer(cfg);
  console.log(`finch-async-mock-ts listening on 127.0.0.1:${s.port}`);
  // Park forever; SIGINT/SIGTERM will exit
  await new Promise(() => {});
}

async function main(): Promise<void> {
  const sub = process.argv[2];
  if (sub === 'start') return startSubcommand();
  if (sub === 'ask') return askSubcommand(process.argv.slice(3));
  console.error('Usage:');
  console.error('  finch start                  # run HTTP server');
  console.error('  finch ask [--prompt "..."]   # interactive REPL or one-shot');
  process.exit(1);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
