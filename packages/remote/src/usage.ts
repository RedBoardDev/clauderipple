export const REMOTE_USAGE = `Usage: clauderipple remote [install|uninstall|status|pair|refresh] [options]
       clauderipple remote add <ssh-host> [--port N] [--force]
       clauderipple remote remove <ssh-host>
       clauderipple remote hosts

Options:
  --bind 127.0.0.1|tailscale|lan|0.0.0.0|<ip>
  --port 8797
  --relay <https-url>|off
  --new-token
  --print                     install: print the service definition only
  --help, -h
`;
