import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { canPrompt, confirm, promptHidden, readStdin } from "../src/prompt";

function terminal() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn(function (this: { isRaw: boolean }, mode: boolean) {
      this.isRaw = mode;
    }),
  });
  let written = "";
  const output = {
    write: (chunk: string) => {
      written += chunk;
      return true;
    },
  };
  return { input, output, written: () => written };
}

describe("promptHidden", () => {
  it("reads a line in raw mode without echoing it", async () => {
    const { input, output, written } = terminal();

    const answer = promptHidden("Value: ", { input, output });
    input.write("hunter3\u007f2\r");

    await expect(answer).resolves.toBe("hunter2");
    expect(written()).toBe("Value: \n");
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(canPrompt(input)).toBe(true);
  });

  it("drops escape sequences, such as the arrow keys, and other control characters", async () => {
    const { input, output } = terminal();

    const answer = promptHidden("Value: ", { input, output });
    input.write("hun\u001b[D");
    input.write("ter\u001bOA\t\u001b[1;5C\u001bb");
    input.write("\u001b[200~2\u001b[201~é\r");

    await expect(answer).resolves.toBe("hunter2é");
  });

  it("rejects on Ctrl-C", async () => {
    const { input, output } = terminal();

    const answer = promptHidden("Value: ", { input, output });
    input.write("abc\u0003");

    await expect(answer).rejects.toThrow("The prompt was cancelled.");
  });
});

describe("confirm", () => {
  it("counts only y or yes as yes", async () => {
    for (const [reply, expected] of [
      ["y", true],
      ["YES", true],
      ["", false],
      ["no", false],
    ] as const) {
      const input = new PassThrough();
      const answer = confirm("Delete?", { input, output: new PassThrough() });
      input.write(`${reply}\n`);
      await expect(answer).resolves.toBe(expected);
    }
  });
});

describe("readStdin", () => {
  it("reads everything and drops one trailing line break", async () => {
    const input = new PassThrough();
    input.end("line one\nline two\n\n");

    await expect(readStdin(input)).resolves.toBe("line one\nline two\n");
    expect(canPrompt(input)).toBe(false);
  });
});
