// npm's Windows batch launcher needs cmd.exe; native .exe and SDK's bundled CLI stay direct.
import { spawn } from "node:child_process";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
export function batchCommand(command: string, args: string[]): string {
  // cmd expands these even inside quotes. Refuse rather than execute a different command.
  const words = [command, ...args];
  if (words.some(word => /[\r\n"%!^&|<>]/.test(word))) throw new Error("unsafe character in Windows Claude batch launcher arguments; use claude.exe instead");
  return words.map(word => `"${word}"`).join(" ");
}
export function launcherOptions(binary: string | undefined, platform = process.platform): Pick<Options, "spawnClaudeCodeProcess"> {
  if (platform !== "win32" || !binary || !/\.(cmd|bat)$/i.test(binary)) return {};
  return { spawnClaudeCodeProcess: options => spawn(batchCommand(options.command, options.args), {
    cwd: options.cwd, env: options.env, signal: options.signal, shell: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  }) };
}
/** The SDK's close() initiates graceful shutdown but does not await process exit.
 * Handoff must wait for the actual writer, not just the SDK's message iterator. */
export const sdkQuery = (input: Parameters<typeof query>[0]): ReturnType<typeof query> & { processExited: Promise<void> } => {
  const exited = Promise.withResolvers<void>();
  const custom = input.options?.spawnClaudeCodeProcess ?? launcherOptions(input.options?.pathToClaudeCodeExecutable).spawnClaudeCodeProcess;
  const result = query({ ...input, options: { ...input.options, spawnClaudeCodeProcess: options => {
    const child = custom ? custom(options) : spawn(options.command, options.args, {
      cwd: options.cwd, env: options.env, signal: options.signal, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    if ("stderr" in child && child.stderr) child.stderr.on("data", (chunk: Buffer) => input.options?.stderr?.(chunk.toString()));
    child.once("exit", () => exited.resolve());
    child.once("error", error => {
      // A failed spawn has no writer; an abort/error on a running child still needs its exit.
      if ((error as NodeJS.ErrnoException).syscall?.startsWith("spawn")) exited.resolve();
    });
    return child;
  } } });
  return Object.assign(result, { processExited: exited.promise });
};
