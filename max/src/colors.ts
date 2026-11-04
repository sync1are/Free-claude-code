// Tiny ANSI helpers — zero dependencies.

const enabled = process.stdout.isTTY && !process.env.NO_COLOR;

function wrap(code: string, s: string): string {
  return enabled ? `\x1b[${code}m${s}\x1b[0m` : s;
}

export const bold = (s: string) => wrap('1', s);
export const dim = (s: string) => wrap('2', s);
export const red = (s: string) => wrap('31', s);
export const green = (s: string) => wrap('32', s);
export const yellow = (s: string) => wrap('33', s);
export const blue = (s: string) => wrap('34', s);
export const magenta = (s: string) => wrap('35', s);
export const cyan = (s: string) => wrap('36', s);

export const check = (s: string) => green(`✓ ${s}`);
export const cross = (s: string) => red(`✗ ${s}`);
