import RippleKit
import SwiftUI

/// One ChatGPT provider's logins. The Codex CLI login is borrowed: the router only reads it, so it
/// can be used now but not paused, renamed or removed here.
struct ChatGptAccountsSection: View {
    let provider: String
    let accounts: [ChatGptAccount]
    let showsProviderName: Bool
    let actions: AccountActions
    let reload: () async -> Void
    @Environment(RouterStore.self) private var store

    var body: some View {
        Section {
            if accounts.isEmpty {
                Text("No ChatGPT account is signed in.").foregroundStyle(.secondary)
            }
            ForEach(accounts) { account in
                AccountRow(title: account.label.isEmpty ? (account.email ?? account.id) : account.label,
                           detail: detail(account),
                           usage: Format.quotaLine(account.quota),
                           badges: badges(account),
                           busy: actions.isBusy(.chatgpt, account.id)) {
                    rowActions(account)
                }
            }
            if let message = actions.chatgptLoginMessage {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(message).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Button("Add ChatGPT account…", systemImage: "plus") { signIn(adding: true) }
            }
        } header: {
            HStack {
                Text(showsProviderName ? "ChatGPT · \(provider)" : "ChatGPT")
                Spacer()
                Text(accounts.count == 1 ? "1 account" : "\(accounts.count) accounts").foregroundStyle(.secondary)
            }
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                FormNote("ClaudeRipple keeps its own logins in a file only your user can read and refreshes them automatically.")
                if accounts.contains(where: \.isBorrowed) {
                    FormNote("The Codex CLI login is only read, never refreshed, and used last.")
                }
            }
        }
    }

    @ViewBuilder
    private func rowActions(_ account: ChatGptAccount) -> some View {
        if account.needsSignIn, !account.isBorrowed {
            Button("Sign in again") { signIn(adding: false) }
                .disabled(actions.chatgptLoginMessage != nil)
        }
        if account.state == .cooling {
            Button("Use now") { patch(account) { try await store.client.updateChatGptAccount(account.id, clearCooldown: true) } }
                .help("Clear the cooldown and use this account again")
        }
        if !account.isBorrowed {
            Button(account.paused ? "Resume" : "Pause") {
                patch(account) { try await store.client.updateChatGptAccount(account.id, paused: !account.paused) }
            }
            AccountMoreMenu {
                actions.rename(.init(kind: .chatgpt, id: account.id, label: account.label))
            } onRemove: {
                actions.removing = .init(kind: .chatgpt, id: account.id, label: account.label)
            }
        }
    }

    private func detail(_ account: ChatGptAccount) -> String? {
        var parts: [String] = []
        if let email = account.email, email != account.label { parts.append(email) }
        if let plan = account.planType { parts.append(plan.capitalized) }
        if account.isBorrowed { parts.append("Codex CLI login") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func badges(_ account: ChatGptAccount) -> [StatusBadge] {
        switch account.state {
        case .paused: [StatusBadge("Paused", tone: .neutral, symbol: "pause.fill")]
        case .needsLogin, .quarantined: [StatusBadge("Sign in again", tone: .bad, symbol: "exclamationmark")]
        case .cooling:
            [StatusBadge(account.cooldownSeconds.map { "Cooling · \(Format.countdown(to: Date().addingTimeInterval($0)))" } ?? "Cooling",
                         tone: .warn)]
        case .ready: [account.active ? StatusBadge("In use", tone: .ok) : StatusBadge("Standby", tone: .neutral)]
        case .unknown, nil: account.paused ? [StatusBadge("Paused", tone: .neutral, symbol: "pause.fill")] : []
        }
    }

    private func patch(_ account: ChatGptAccount, _ work: @escaping () async throws -> Void) {
        Task { await actions.perform(.chatgpt, account.id, reload: reload, work) }
    }

    private func signIn(adding: Bool) {
        Task { await actions.signInChatGpt(client: store.client, adding: adding, reload: reload) }
    }
}
