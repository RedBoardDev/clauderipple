import Foundation

/// Where the router's admin API answers.
///
/// Same rule as the router (`adminPort` in packages/router/src/config.ts) and the old Electron tray:
/// `admin.port` from `~/.clauderipple/config.json`, else `listen.port + 1`, else 8791. Only those two
/// numbers are decoded; nothing else in the file (accounts, keys) is kept or parsed.
public enum Endpoint {
    /// The router's default proxy port; the admin API sits one above it.
    public static let defaultProxyPort = 8790
    /// Loopback only: the admin API refuses a non-loopback Host.
    public static let host = "127.0.0.1"
    /// Overrides the discovered URL, for running the app against a stand-in router.
    public static let overrideEnvironmentKey = "CLAUDERIPPLE_APP_ADMIN_URL"

    /// `CLAUDERIPPLE_HOME`, else `~/.clauderipple`, as every other ClaudeRipple component resolves it.
    public static func homeDirectory(environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        if let home = environment["CLAUDERIPPLE_HOME"], !home.isEmpty {
            return URL(fileURLWithPath: home, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appending(path: ".clauderipple", directoryHint: .isDirectory)
    }

    public static func adminURL(environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        if let override = environment[overrideEnvironmentKey], let url = URL(string: override) {
            return url
        }
        let configURL = homeDirectory(environment: environment).appending(path: "config.json")
        let data = try? Data(contentsOf: configURL)
        return adminURL(configData: data)
    }

    /// Pure half of `adminURL()`, so the port rule is pinned by tests without touching the disk.
    public static func adminURL(configData: Data?) -> URL {
        let ports = configData.flatMap { try? JSONDecoder().decode(PortsOnly.self, from: $0) }
        let proxy = ports?.listen?.port ?? defaultProxyPort
        let admin = ports?.admin?.port ?? proxy + 1
        return URL(string: "http://\(host):\(admin)")!
    }

    /// The only part of config.json this app decodes.
    private struct PortsOnly: Decodable {
        struct Port: Decodable { let port: Int? }
        let listen: Port?
        let admin: Port?
    }
}
