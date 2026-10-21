import RippleKit
import SwiftUI

struct AboutPane: View {
    let app: AppController
    @Environment(RouterStore.self) private var store
    @State private var update: Loadable<UpdateCheck>?
    @State private var busy = false
    @State private var confirmUpdate = false
    @State private var actionError: String?
    /// A larger mark gives About a clear identity without becoming a content-card background.
    private static let mascotSize: CGFloat = 72
    private static let repository = URL(string: "https://github.com/RedBoardDev/clauderipple")!

    private var appVersion: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "Unknown"
        let build = info["CFBundleVersion"] as? String ?? "Unknown"
        return "\(version) (\(build))"
    }

    var body: some View {
        Form {
            Section {
                HStack(spacing: Metrics.inset) {
                    RippleMarkView(size: Self.mascotSize)
                    VStack(alignment: .leading, spacing: Metrics.labelGap) {
                        Text("ClaudeRipple").font(.title2.bold())
                        Text("Native menu-bar app").foregroundStyle(.secondary)
                    }
                }
                LabeledContent("App version", value: appVersion)
                LabeledContent("Router version", value: store.status?.version ?? "Not available")
                LabeledContent("Claude Code CLI version", value: store.status?.cliVersion ?? "Not available")
                if store.connection == .offline { FormNote("The router is not answering. The last known version may be shown.") }
            }
            Section("Updates") {
                Button("Check for updates", systemImage: "arrow.clockwise") { Task { await check() } }
                    .buttonStyle(.glass).disabled(busy)
                if let update {
                    LoadableView(update, retry: { Task { await check() } }) { check in
                        LabeledContent("Installed router", value: check.current)
                        LabeledContent("Latest release", value: check.latest ?? "Unknown")
                        if check.running == true || check.started == true {
                            Label("Update is running. The router will reconnect after restarting.", systemImage: "arrow.triangle.2.circlepath")
                                .foregroundStyle(Theme.accent)
                        } else if check.newer {
                            if check.canUpdate {
                                Button("Update router", systemImage: "arrow.down.circle") { confirmUpdate = true }
                                    .buttonStyle(.glassProminent).disabled(busy)
                            }
                        } else {
                            Label("You're up to date", systemImage: "checkmark.circle").foregroundStyle(Theme.ok)
                        }
                        if let note = check.installationNote { FormNote(note) }
                        if check.kind == "packaged" {
                            Link("Open releases on GitHub", destination: Self.repository.appending(path: "releases/latest"))
                        }
                    }
                }
                if busy { ProgressView("Working…").controlSize(.small) }
                InlineError(actionError)
            }
            Section("Project") {
                LabeledContent("License", value: "GPL-3.0-only")
                Link("ClaudeRipple on GitHub", destination: Self.repository)
                Text("ClaudeRipple is an independent project, not affiliated with Anthropic or OpenAI. Claude is a trademark of Anthropic, PBC; ChatGPT is a trademark of OpenAI.")
                    .font(.callout).fixedSize(horizontal: false, vertical: true)
            }
        }
        .formStyle(.grouped)
        .confirmationDialog("Update the router?", isPresented: $confirmUpdate) {
            Button("Update") { Task { await installUpdate() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The router restarts on the new version after in-flight requests finish. Existing connections may reconnect. The native app stays open.")
        }
    }

    private func check() async {
        guard !busy else { return }
        busy = true
        actionError = nil
        update = .loading
        defer { busy = false }
        do { update = .loaded(try await store.client.checkForUpdates()) }
        catch { update = .failed(error.asAdminError) }
    }

    private func installUpdate() async {
        guard !busy, update?.value?.canUpdate == true else { return }
        busy = true
        actionError = nil
        defer { busy = false }
        do { update = .loaded(try await store.client.startUpdate()) }
        catch { actionError = error.asAdminError.userMessage }
    }
}
