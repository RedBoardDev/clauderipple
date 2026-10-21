import RippleKit
import SwiftUI

/// "Drain Work first: 51% of its week resets in 4d 19h." with a one-click "Use first" for Claude.
/// The suggestion half of the planned smart switch: nothing changes until the user clicks.
struct DrainHint: View {
    let advice: DrainAdvice
    let now: Date
    @Environment(RouterStore.self) private var store
    @State private var applying = false
    @State private var error: String?

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "arrow.triangle.2.circlepath")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.accent)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                Text(message)
                    .font(.system(size: 11.5))
                    .fixedSize(horizontal: false, vertical: true)
                if let error {
                    Text(error).font(.system(size: 11)).foregroundStyle(Theme.bad)
                }
            }
            Spacer(minLength: 4)
            if let target = advice.useNow, target.kind == .claude, !target.isPreferred {
                Button(applying ? "…" : "Use first") { apply(target) }
                    .buttonStyle(.glass)
                    .controlSize(.small)
                    .disabled(applying)
                    .help("Make \(target.label) the account new Claude conversations start on")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Theme.accent.opacity(0.1), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var message: String {
        let first = advice.drainFirst
        var text = "Drain \(first.label) first: \(Format.percent(advice.expiringPercent)) of its week"
        if let reset = first.weekly?.resetsAt { text += " resets in \(Format.countdown(to: reset, now: now))" }
        text += "."
        if let reopens = advice.availableFrom {
            text += " Its 5h window reopens in \(Format.countdown(to: reopens, now: now))"
            text += advice.meanwhile.map { "; \($0.label) meanwhile." } ?? "."
        }
        return text
    }

    private func apply(_ target: AccountUsage) {
        applying = true
        error = nil
        Task {
            do {
                try await store.client.setPreferredClaudeAccount(target.accountId == "current" ? nil : target.accountId)
                await store.reloadAccounts()
            } catch {
                self.error = error.asAdminError.userMessage
            }
            applying = false
        }
    }
}
