import { createInterface } from "node:readline/promises";
import { recordSecretValue, type SecretPrompt } from "@notation/core";

type Input = NodeJS.ReadableStream & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};

type Output = Pick<NodeJS.WritableStream, "write">;

export type PromptStreams = { input?: Input; output?: Output };

/** True when a person can answer a prompt. */
export function canPrompt(input: Input = process.stdin): boolean {
  return Boolean(input.isTTY && input.setRawMode);
}

/**
 * Asks for a value without echoing what is typed. The question and the line
 * break go to stderr, as stdout can carry JSON.
 */
export function promptHidden(
  question: string,
  { input = process.stdin, output = process.stderr }: PromptStreams = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    output.write(question);
    const wasRaw = input.isRaw ?? false;
    input.setRawMode?.(true);
    input.setEncoding("utf8");
    input.resume();
    let value = "";

    const finish = (error?: Error) => {
      input.off("data", onData);
      input.setRawMode?.(wasRaw);
      input.pause();
      output.write("\n");
      if (error) reject(error);
      else resolve(value);
    };

    // Raw mode passes each key through, so line endings, backspace, Ctrl-C
    // and Ctrl-D are handled here.
    const onData = (chunk: string | Buffer) => {
      for (const char of String(chunk)) {
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u0003") {
          return finish(new Error("The prompt was cancelled."));
        }
        if (char === "\u0004") {
          return value === ""
            ? finish(new Error("The prompt was cancelled."))
            : finish();
        }
        if (char === "\u007f" || char === "\b") {
          value = [...value].slice(0, -1).join("");
          continue;
        }
        value += char;
      }
    };
    input.on("data", onData);
  });
}

/** Asks a yes or no question. Only `y` or `yes` counts as yes. */
export async function confirm(
  question: string,
  { input = process.stdin, output = process.stderr }: PromptStreams = {},
): Promise<boolean> {
  const readline = createInterface({
    input,
    output: output as NodeJS.WritableStream,
  });
  try {
    const answer = await readline.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

/** Reads all of stdin, and drops one trailing line break. */
export async function readStdin(input: Input = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
}

/** Asks for a secret's value with a hidden prompt on the terminal. */
export function terminalSecretPrompt(
  streams: PromptStreams = {},
): SecretPrompt {
  return async ({ id, stage }) => {
    const value = await promptHidden(
      `Value of the secret ${id} for stage ${stage}: `,
      streams,
    );
    if (value === "") throw new Error(`No value was given for ${id}.`);
    recordSecretValue(value);
    return value;
  };
}

/**
 * Wraps a prompt so that it asks once for each secret, and only one question
 * is on the terminal at a time. `watch` uses it, so that it asks for a value
 * at the first deploy that needs it.
 */
export function onceEachSecret(prompt: SecretPrompt): SecretPrompt {
  const answers = new Map<string, Promise<string>>();
  let queue: Promise<unknown> = Promise.resolve();
  return (request) => {
    const key = `${request.stage}\u0000${request.id}`;
    let answer = answers.get(key);
    if (!answer) {
      answer = queue.then(() => prompt(request));
      queue = answer.catch(() => {});
      answers.set(key, answer);
      // A failed prompt asks again next time.
      answer.catch(() => answers.delete(key));
    }
    return answer;
  };
}
