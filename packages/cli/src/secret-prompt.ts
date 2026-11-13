import { createInterface } from "node:readline/promises";
import { Redacted, type SecretPromptHandler } from "@notation/core";

export const INTERACTIVE_SECRET_PROMPT_ENV = "NOTATION_SECRET_PROMPT";

export type SecretPromptInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  pause?: () => unknown;
};

export type SecretPromptOutput = Pick<NodeJS.WritableStream, "write"> & {
  isTTY?: boolean;
};

export type SecretPromptIo = {
  stdin?: SecretPromptInput;
  stderr?: SecretPromptOutput;
};

export function isTtyPromptAvailable(io: SecretPromptIo = {}): boolean {
  const stdin = io.stdin ?? process.stdin;
  const stderr = io.stderr ?? process.stderr;
  return Boolean(stdin.isTTY && stderr.isTTY);
}

export async function promptSecretHidden(
  opts: {
    id: string;
    stage: string;
    prompt?: string;
  } & SecretPromptIo,
): Promise<Redacted<string>> {
  const stdin = opts.stdin ?? process.stdin;
  const stderr = opts.stderr ?? process.stderr;

  stderr.write(
    opts.prompt ?? `Enter value for secret ${opts.id} (stage ${opts.stage}): `,
  );

  const hasRawMode = typeof stdin.setRawMode === "function";
  const wasRaw = Boolean(stdin.isRaw);
  if (hasRawMode) {
    stdin.setRawMode!(true);
  }
  stdin.resume();

  return await new Promise<Redacted<string>>((resolve, reject) => {
    const chars: string[] = [];
    let settled = false;

    const cleanup = () => {
      stdin.off("data", onData);
      stdin.off("error", onError);
      stdin.off("end", onEnd);
      stdin.off("close", onClose);
      try {
        if (hasRawMode) {
          stdin.setRawMode!(wasRaw);
        }
      } finally {
        stdin.pause?.();
      }
    };

    const finish = (result: { value?: string; error?: unknown }) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (result.error !== undefined) {
        reject(result.error);
      } else {
        resolve(new Redacted(result.value ?? ""));
      }
    };

    const onData = (chunk: Buffer | string) => {
      const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let i = 0;
      while (i < str.length) {
        const code = str.charCodeAt(i);

        // Ctrl-C
        if (code === 0x03) {
          stderr.write("\n");
          finish({ error: new Error("Secret prompt cancelled.") });
          return;
        }

        // Enter (\r or \n)
        if (code === 0x0d || code === 0x0a) {
          stderr.write("\n");
          finish({ value: chars.join("") });
          return;
        }

        // Ctrl-D (EOF)
        if (code === 0x04) {
          stderr.write("\n");
          if (chars.length === 0) {
            finish({ error: new Error("Secret prompt cancelled.") });
          } else {
            finish({ value: chars.join("") });
          }
          return;
        }

        // Backspace / DEL
        if (code === 0x7f || code === 0x08) {
          chars.pop();
          i += 1;
          continue;
        }

        // Skip ANSI escape sequences (e.g. arrow keys).
        if (code === 0x1b) {
          i += 1;
          if (i < str.length && (str[i] === "[" || str[i] === "O")) {
            i += 1;
            while (i < str.length) {
              const b = str.charCodeAt(i);
              i += 1;
              if (b >= 0x40 && b <= 0x7e) break;
            }
          }
          continue;
        }

        const cp = str.codePointAt(i)!;
        const ch = String.fromCodePoint(cp);
        i += ch.length;

        // Ignore non-printable control characters other than tab.
        if (cp < 0x20 && cp !== 0x09) {
          continue;
        }

        chars.push(ch);
      }
    };

    const onError = (error: unknown) => {
      finish({ error });
    };

    const onEnd = () => {
      stderr.write("\n");
      finish({ error: new Error("Secret prompt cancelled (EOF).") });
    };

    const onClose = () => {
      if (!settled) {
        stderr.write("\n");
        finish({ error: new Error("Secret prompt cancelled (EOF).") });
      }
    };

    stdin.on("data", onData);
    stdin.on("error", onError);
    stdin.on("end", onEnd);
    stdin.on("close", onClose);
  });
}

export async function readSecretFromStdin(
  stdin: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(
      typeof chunk === "string"
        ? Buffer.from(chunk, "utf8")
        : Buffer.from(chunk),
    );
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.replace(/\r?\n$/, "");
}

export async function promptConfirm(
  opts: { message: string } & SecretPromptIo,
): Promise<boolean> {
  const stdin = opts.stdin ?? process.stdin;
  const stderr = opts.stderr ?? process.stderr;

  stderr.write(opts.message);
  const rl = createInterface({ input: stdin, terminal: false });
  try {
    for await (const line of rl) {
      return /^(y|yes)$/i.test(line.trim());
    }
    return false;
  } finally {
    rl.close();
  }
}

export function createSecretPromptHandler(
  io: SecretPromptIo = {},
): SecretPromptHandler {
  return ({ id, stage }) => promptSecretHidden({ id, stage, ...io });
}
