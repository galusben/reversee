import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, Copy, ExternalLink, Sparkles, X } from 'lucide-react';
import { useUiStore } from '../stores/uiStore';

const CLAUDE_CMD = 'claude mcp add reversee -- npx -y reversee-mcp';
const CURSOR_JSON = `{
  "mcpServers": {
    "reversee": { "command": "npx", "args": ["-y", "reversee-mcp"] }
  }
}`;
const REPO = 'https://github.com/galusben/reversee#mcp-integration-claude-code--cursor';

function CopyBlock({ label, text }: { label: string; text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void window.reversee.copyToClipboard(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-neutral-500">{label}</div>
      <div className="flex items-start gap-2">
        <pre className="grow overflow-x-auto rounded-md bg-neutral-900 p-2.5 font-mono text-xs leading-5 text-neutral-100">
          {text}
        </pre>
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy ${label}`}
          className="flex shrink-0 items-center gap-1 rounded-md border border-neutral-300 px-2 py-1.5 text-xs text-neutral-600 hover:bg-neutral-50"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

export function ConnectAiDialog(): React.JSX.Element {
  const open = useUiStore((s) => s.connectAiOpen);
  const setOpen = useUiStore((s) => s.setConnectAiOpen);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[560px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-5 shadow-xl">
          <div className="mb-1 flex items-center justify-between">
            <Dialog.Title className="flex items-center gap-2 text-base font-semibold">
              <Sparkles className="h-4 w-4 text-fuchsia-500" aria-hidden />
              Connect an AI agent
            </Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="rounded p-1 hover:bg-neutral-100">
                <X className="h-4 w-4" aria-hidden />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="mb-4 text-sm text-neutral-500">
            Let Claude Code, Cursor, or any MCP client inspect and control Reversee. Keep this app
            running, then register the server:
          </Dialog.Description>

          <div className="space-y-4">
            <CopyBlock label="Claude Code" text={CLAUDE_CMD} />
            <CopyBlock label="Cursor — add to ~/.cursor/mcp.json" text={CURSOR_JSON} />
          </div>

          <div className="mt-4 flex items-center justify-between border-t border-neutral-100 pt-3">
            <p className="text-xs text-neutral-500">
              Read-only by default — enable <span className="font-medium">Allow MCP to Control the Proxy</span>{' '}
              in the Proxy Settings menu to let agents start/stop it.
            </p>
            <a
              href={REPO}
              target="_blank"
              rel="noreferrer"
              className="flex shrink-0 items-center gap-1 text-xs text-blue-600 hover:underline"
            >
              Learn more <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
