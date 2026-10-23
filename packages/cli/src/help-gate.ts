// `--help` or `-h` anywhere on the command line prints usage and runs nothing. A command that
// only reads its own flags would otherwise run with them: `uninstall --purge --help` deleted a
// live ~/.clauderipple on 2026-10-23.

export async function withCommandHelp(argv: string[], dispatch: () => Promise<void>, help: () => void): Promise<void> {
  if (!argv.some(arg => arg === "--help" || arg === "-h")) return dispatch();
  if (argv[0] === "remote") {
    const { REMOTE_USAGE } = await import("../../remote/src/usage.ts");
    console.log(REMOTE_USAGE);
  } else help();
}
