// Interactive prompts. Masked input for API keys (stars instead of echo).

import readline from "node:readline";
import { Writable } from "node:stream";

export function ask(
  question: string,
  opts: { mask?: boolean } = {},
): Promise<string> {
  return new Promise((resolve) => {
    if (!opts.mask) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
      return;
    }

    // Masked: swallow everything readline echoes; print stars for typed chars.
    process.stdout.write(question);
    let lastWasNewline = false;
    const sink = new Writable({
      write(chunk: any, _enc: string, cb: (err?: Error | null) => void) {
        const s = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        // printable single chars -> star; control chars / escape seqs -> ignore
        if (s.length === 1 && s >= " " && s <= "~") {
          process.stdout.write("*");
        } else if (s === "\r" || s === "\n") {
          process.stdout.write("\n");
          lastWasNewline = true;
        }
        cb();
      },
    });
    sink.on("error", () => {});
    const rl = readline.createInterface({
      input: process.stdin,
      output: sink as Writable,
      terminal: true,
    });
    rl.question("", (answer) => {
      if (!lastWasNewline) process.stdout.write("\n");
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function confirm(question: string, defaultYes = true): Promise<boolean> {
  return new Promise((resolve) => {
    const hint = defaultYes ? "[Y/n]" : "[y/N]";
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(`${question} ${hint} `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === "") return resolve(defaultYes);
      resolve(a === "y" || a === "yes");
    });
  });
}
