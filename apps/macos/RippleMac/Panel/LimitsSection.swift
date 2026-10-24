import RippleKit
import SwiftUI

/// Per-provider groups of account cards: Claude first, then ChatGPT.
struct LimitsSection: View {
    let now: Date
    @Environment(RouterStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.sectionGap) {
            ForEach(ProviderKind.allCases, id: \.self) { kind in
                let accounts = store.accounts(of: kind)
                if !accounts.isEmpty {
                    VStack(alignment: .leading, spacing: Metrics.labelGap) {
                        SectionLabel(kind: kind, count: accounts.count, rotation: kind == .claude ? store.claudeRotation : nil)
                        ForEach(accounts) { AccountCard(account: $0, now: now) }
                    }
                }
            }
        }
    }
}

private struct SectionLabel: View {
    let kind: ProviderKind
    let count: Int
    let rotation: Bool?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(kind.title)
                .font(.system(size: 12, weight: .semibold))
            Text(detail)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
            Spacer()
        }
    }

    private var detail: String {
        let accounts = count == 1 ? "1 account" : "\(count) accounts"
        guard let rotation, count > 1 else { return accounts }
        return accounts + (rotation ? " · rotation on" : " · rotation off")
    }
}
