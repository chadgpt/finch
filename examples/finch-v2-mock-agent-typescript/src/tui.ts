/**
 * Interactive chat TUI built on @earendil-works/pi-tui.
 *
 * Layout:
 *   ┌─────────────────────────────────────┐
 *   │  ScrollView (chat log)               │
 *   │  ─────────────────                   │
 *   │  you › What is 2+2?                  │
 *   │  agent › 4                           │
 *   │  ⚙ get_current_time() → 2026-...    │
 *   │  agent › The current time is 14:32.  │
 *   │  ─────────────────                   │
 *   │  you › _                            │  ← Editor (input)
 *   │  /exit to quit, /clear to reset    │
 *   └─────────────────────────────────────┘
 *
 * State machine:
 *   - `idle`     : user can type; Enter sends to the agent
 *   - `streaming` : input disabled; the agent is responding
 *
 * On stream end → back to `idle`. The user's command buffer is preserved
 * across turns so they can edit & resubmit.
 *
 * Run with: `npx tsx src/cli.ts tui` (added in cli.ts) or
 *           `npx tsx src/tui.ts` directly.
 */

import {
  TuiMainScreen,
  Editor,
  ScrollView,
  VStack,
  Text,
  ProcessTerminal,
  type TUI,
  type Component,
} from '@earendil-works/pi-tui';
import { randomUUID } from 'node:crypto';
import { runAgentTurn, type AgentEvent } from './agent.ts';
import { createLlmProvider, type LlmConfig } from './llm.ts';
import { buildLlmHistory } from './history.ts';
import { Store } from './db.ts';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const GRAY = '\x1b[90m';

const c = (color: string, s: string): string => `${color}${s}${RESET}`;

interface ChatLine {
  kind: 'user' | 'agent' | 'tool' | 'info' | 'system';
  text: string;
}

export class ChatTui {
  private tui: TUI;
  private scroll: ScrollView;
  private editor: Editor;
  private state: 'idle' | 'streaming' = 'idle';
  private config: LlmConfig;
  private store: Store;
  private sessionId: string;
  /** Per-turn live agent text. Re-rendered on every text_delta. */
  private currentAgentText: Text | null = null;
  private currentAgentRaw = '';
  private renderQueued = false;

  constructor(config: LlmConfig, store: Store) {
    this.config = config;
    this.store = store;
    this.sessionId = `tui-${randomUUID()}`;

    this.tui = new TuiMainScreen(new ProcessTerminal());

    // A scrollable chat log lives in a container we add lines to.
    // We use a single Text child that we rebuild on every append
    // (simple, correct, easy to reason about for the diff renderer).
    this.scroll = new ScrollView(new Text(''), { follow: 'end' });
    this.scroll.clear();  // remove the empty placeholder

    // Editor (input field) — theme is required.
    this.editor = new Editor(this.tui, {
      borderColor: (s: string) => c(GRAY, s),
      selectList: {
        selectedPrefix: (s: string) => c(CYAN, s),
        selectedText: (s: string) => c(BOLD, s),
        description: (s: string) => c(GRAY, s),
        scrollInfo: (s: string) => c(GRAY, s),
        noMatch: (s: string) => c(GRAY, s),
      },
    }, {
      paddingX: 1,
    });
    // onSubmit / onChange are instance properties on the Editor, set
    // after construction (not in the options bag).
    this.editor.onSubmit = (text: string) => { void this.handleSubmit(text); };
    this.editor.onChange = () => this.queueRender();

    const root: Component = new VStack([this.scroll, this.editor]);
    this.tui.addChild(root);
    this.tui.setFocus(this.editor);

    this.appendInfo(`Finch provider TUI — model: ${config.model}`);
    this.appendInfo('Type a message, Enter to send. /exit, /clear, /tools commands.');
  }

  private appendLine(line: ChatLine): void {
    // Add a new Text component to the scroll view (one per line is
    // simpler than rebuilding a single multi-line text component).
    const text = new Text(this.formatLine(line));
    this.scroll.addChild(text);
    this.scroll.scrollToEnd();
    this.queueRender();
  }

  private appendInfo(text: string): void { this.appendLine({ kind: 'info', text }); }
  private appendUser(text: string): void { this.appendLine({ kind: 'user', text }); }
  private appendTool(text: string): void { this.appendLine({ kind: 'tool', text }); }

  private formatLine(line: ChatLine): string {
    switch (line.kind) {
      case 'user': return c(CYAN, 'you › ') + line.text;
      case 'agent': return c(GREEN, 'agent › ') + line.text;
      case 'tool': return c(YELLOW, '  ⚙ ') + line.text;
      case 'info': return c(GRAY, '  ' + line.text);
      case 'system': return c(BOLD, '  ' + line.text);
    }
  }

  private queueRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    setImmediate(() => {
      this.renderQueued = false;
      try { this.tui.requestRender(); } catch { /* shutting down */ }
    });
  }

  /**
   * Update the live "agent › ..." line for streaming deltas. If no live
   * line exists yet, create one. Replaces the text each call.
   */
  private updateAgentLine(text: string): void {
    this.currentAgentRaw = text;
    if (!this.currentAgentText) {
      this.currentAgentText = new Text(this.formatLine({ kind: 'agent', text }));
      this.scroll.addChild(this.currentAgentText);
    } else {
      this.currentAgentText.setText(this.formatLine({ kind: 'agent', text }));
    }
    this.scroll.scrollToEnd();
    this.queueRender();
  }

  private async handleSubmit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed === '/exit' || trimmed === '/quit') {
      this.shutdown();
      return;
    }
    if (trimmed === '/clear') {
      this.scroll.clear();
      this.appendInfo('(history cleared)');
      // The store keeps the persisted history; create a new session
      // so the LLM doesn't see the cleared history.
      this.sessionId = `tui-${randomUUID()}`;
      this.currentAgentText = null;
      this.currentAgentRaw = '';
      return;
    }
    if (trimmed === '/tools') {
      const { BUILTIN_TOOLS } = await import('./llm.ts');
      for (const t of BUILTIN_TOOLS) {
        this.appendInfo(`• ${t.function.name} — ${t.function.description}`);
      }
      return;
    }
    if (this.state === 'streaming') {
      this.appendInfo('(still streaming — wait for the agent to finish)');
      return;
    }

    this.appendUser(trimmed);
    this.state = 'streaming';
    this.editor.disableSubmit = true;
    this.editor.setText('');  // clear the input
    this.currentAgentText = null;
    this.currentAgentRaw = '';
    this.queueRender();

    // Save the user turn to the store so the LLM history is consistent
    // with what the user sees in the chat log.
    this.store.appendMessage({ task_id: this.sessionId, role: 'user', content: trimmed });

    try {
      const llm = createLlmProvider(this.config);
      const history = buildLlmHistory(this.store, this.sessionId, this.config.systemPrompt);
      const resp = await runAgentTurn(
        {
          llm,
          systemPrompt: this.config.systemPrompt,
          model: this.config.model,
          maxTokens: this.config.maxTokens,
          onEvent: (ev: AgentEvent) => this.handleAgentEvent(ev),
        },
        history,
        trimmed,
      );
      if (!this.currentAgentRaw && resp.toolCalls.length > 0) {
        const last = resp.toolCalls[resp.toolCalls.length - 1];
        const summary = `[agent loop ended at ${resp.steps} step(s); last tool result: ${
          typeof last?.result === 'string' ? last.result : JSON.stringify(last?.result)
        }]`;
        this.updateAgentLine(summary);
      } else if (!this.currentAgentRaw) {
        this.updateAgentLine('(empty reply)');
      }
      this.store.appendMessage({
        task_id: this.sessionId,
        role: 'assistant',
        content: this.currentAgentRaw || '(empty reply)',
      });
    } catch (e) {
      this.appendInfo(`(error) ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.state = 'idle';
      this.editor.disableSubmit = false;
      this.queueRender();
    }
  }

  private handleAgentEvent(ev: AgentEvent): void {
    switch (ev.kind) {
      case 'text_delta':
        this.updateAgentLine(this.currentAgentRaw + ev.text);
        break;
      case 'tool_call':
        this.appendTool(`${ev.name}(${JSON.stringify(ev.args)})`);
        break;
      case 'tool_result':
        this.appendTool(`→ ${ev.preview}`);
        break;
      case 'final':
        // Already handled in the outer loop
        break;
    }
  }

  start(): void {
    this.tui.start();
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  private shutdown(): void {
    try { this.tui.stop(); } catch { /* already stopped */ }
    try { this.store.close(); } catch { /* */ }
    process.exit(0);
  }
}

/**
 * Standalone entry point. Reads config from env and starts the TUI.
 *
 * Set FINCH_DB_PATH for the session history (the TUI uses SQLite to back
 * the message history the agent sees).
 */
async function main(): Promise<void> {
  const baseUrl = process.env.LLM_BASE_URL ?? 'https://agw.k0s.io/v1';
  const apiKey = process.env.LLM_API_KEY ?? '-';
  const model = process.env.LLM_MODEL ?? 'MiniMax-M3';
  const systemPrompt = process.env.LLM_SYSTEM_PROMPT ?? 'You are a helpful agent. Be concise.';
  const maxTokens = parseInt(process.env.LLM_MAX_TOKENS ?? '1024', 10);
  const timeoutMs = parseInt(process.env.LLM_TIMEOUT_MS ?? '30000', 10);
  const dbPath = process.env.FINCH_DB_PATH ?? '/tmp/finch-tui.db';
  const config: LlmConfig = { baseUrl, apiKey, model, systemPrompt, maxTokens, timeoutMs };
  const store = new Store(dbPath);
  const tui = new ChatTui(config, store);
  tui.start();
}

// Run when invoked as a script (`npx tsx src/tui.ts`)
if (process.argv[1] && /tui\.[mc]?ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error('tui fatal:', e);
    process.exit(1);
  });
}
