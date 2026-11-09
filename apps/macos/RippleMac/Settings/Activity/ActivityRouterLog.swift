import RippleKit
import SwiftUI

struct ActivityRouterLog: View {
    let client: AdminClient
    let refreshRevision: Int
    @State private var log: Loadable<String> = .loading
    @State private var retryRevision = 0

    /// The router log matches the dashboard's three-second tail cadence.
    private static let refreshInterval: Duration = .seconds(3)
    /// Readable terminal-style text in the settings form.
    private static let logFontSize: CGFloat = 12
    private static let logHeight: CGFloat = 350
    private static let bottomID = "router-log-bottom"

    var body: some View {
        Form {
            Section {
                LoadableView(log, retry: { retryRevision += 1 }) { text in
                    ScrollViewReader { proxy in
                        ScrollView([.horizontal, .vertical]) {
                            VStack(alignment: .leading, spacing: 0) {
                                Text(text.isEmpty ? "No log entries." : text)
                                    .font(.system(size: Self.logFontSize, design: .monospaced))
                                    .textSelection(.enabled)
                                Color.clear.frame(height: 0).id(Self.bottomID)
                            }
                            .frame(minWidth: 0, alignment: .leading)
                        }
                        .frame(height: Self.logHeight)
                        .onAppear { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
                        .onChange(of: text) { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
                    }
                }
            } header: {
                Label("Router log", systemImage: "terminal")
            } footer: {
                FormNote("Last 200 lines · refreshes every 3 seconds while visible · follows new entries")
            }
        }
        .formStyle(.grouped)
        .task(id: [refreshRevision, retryRevision]) { await poll() }
    }

    private func poll() async {
        while !Task.isCancelled {
            await load()
            do { try await Task.sleep(for: Self.refreshInterval) } catch { return }
        }
    }

    private func load() async {
        do {
            let text = try await client.activityRouterLog()
            guard !Task.isCancelled else { return }
            log = .loaded(text)
        } catch {
            guard !Task.isCancelled else { return }
            log = .failed(error.asAdminError)
        }
    }
}
