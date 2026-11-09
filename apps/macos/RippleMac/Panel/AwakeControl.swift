import RippleKit
import SwiftUI

/// Keep-awake mode from the panel (the Laptop pane has the details).
struct AwakeControl: View {
    let power: PowerStatus
    @Environment(RouterStore.self) private var store
    @State private var pending: AwakeStatus.Mode?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Label("Keep awake", systemImage: power.awake.applied ? "cup.and.heat.waves.fill" : "cup.and.saucer")
                    .font(.system(size: 12))
                    .labelStyle(.titleAndIcon)
                Spacer()
                Picker("Keep awake", selection: binding) {
                    ForEach(AwakeStatus.Mode.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .controlSize(.small)
                .fixedSize()
                .disabled(power.awake.setup == "unsupported")
            }
            if let error {
                Text(error).font(.system(size: 11)).foregroundStyle(Theme.bad)
            } else if power.awake.mode != .off {
                Text(power.awake.reason).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .help("Working: awake while Claude has requests in flight. On: always (until a battery floor).")
    }

    private var binding: Binding<AwakeStatus.Mode> {
        Binding(get: { pending ?? power.awake.mode }, set: { mode in
            pending = mode
            error = nil
            Task {
                do { try await store.setAwake(mode) } catch { self.error = error.asAdminError.userMessage }
                pending = nil
            }
        })
    }
}
