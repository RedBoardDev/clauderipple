import RippleKit
import SwiftUI

/// Mark, name, router state, and the refresh button.
struct PanelHeader: View {
    @Environment(RouterStore.self) private var store
    @State private var refreshing = false

    var body: some View {
        HStack(alignment: .center, spacing: 9) {
            RippleMarkView(size: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text("ClaudeRipple").font(.system(size: 14, weight: .semibold))
                subtitle
            }
            Spacer(minLength: 8)
            refreshButton
        }
    }

    private var subtitle: some View {
        HStack(spacing: 5) {
            Circle().fill(dotColor).frame(width: 7, height: 7)
            Text(stateText)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .help(store.problems.isEmpty ? stateText : "Router reports: " + store.problems.joined(separator: ", "))
    }

    private var stateText: String {
        switch store.connection {
        case .connecting: return "Connecting…"
        case .offline: return "Not answering"
        case .online:
            let version = store.status.map { "v\($0.version)" } ?? ""
            let inFlight = store.status?.stats?.messagesInFlight ?? store.status?.stats?.inFlight ?? 0
            var parts = [store.problems.isEmpty ? "Running" : "Needs attention", version]
            if inFlight > 0 { parts.append("\(inFlight) in flight") }
            return parts.filter { !$0.isEmpty }.joined(separator: " · ")
        }
    }

    private var dotColor: Color {
        switch store.connection {
        case .connecting: Theme.warn
        case .offline: Theme.bad
        case .online: store.problems.isEmpty ? Theme.ok : Theme.warn
        }
    }

    private var refreshButton: some View {
        Button {
            guard !refreshing else { return }
            refreshing = true
            Task {
                await store.refresh()
                refreshing = false
            }
        } label: {
            // Spinner and glyph share one frame, so the header never shifts while refreshing.
            ZStack {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 12, weight: .semibold))
                    .opacity(refreshing ? 0 : 1)
                if refreshing { ProgressView().controlSize(.mini) }
            }
            .frame(width: 26, height: 26)
            .background(.quaternary, in: Circle())
            .contentShape(Circle())
        }
        .buttonStyle(.borderless)
        .foregroundStyle(.secondary)
        .keyboardShortcut("r", modifiers: .command)
        .help(store.lastUpdated.map { "Updated \(Format.age(of: $0)). Refresh now (⌘R)" } ?? "Refresh now (⌘R)")
        .accessibilityLabel("Refresh")
        .pointingHandCursor()
    }
}
