import RippleKit
import SwiftUI

/// Claude logins: the rotation switch first (it decides whether added accounts are used at all),
/// then the accounts in the order the router tries them, then "remove all" on its own.
struct ClaudeAccountsSection: View {
    let book: AccountsBook
    let actions: AccountActions
    let reload: () async -> Void
    @Environment(RouterStore.self) private var store
    @State private var savingRotation: String?
    @State private var rotationError: String?

    private var accounts: ClaudeAccountsResponse? { book.claude }

    var body: some View {
        Section {
            ForEach(book.providers.claude, id: \.self) { name in
                Toggle(isOn: rotationBinding(name)) {
                    Text("Rotate Claude accounts automatically")
                    if book.providers.claude.count > 1 { Text(name) }
                }
                .disabled(savingRotation != nil)
            }
            InlineError(rotationError)
        } header: {
            Text("Claude")
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                FormNote("A conversation stays on one account to keep its prompt cache. ClaudeRipple moves to the next account only when quota or sign-in fails before the answer starts.")
                if book.providers.claudeRotating.isDisjoint(with: book.providers.claude) {
                    Text("Rotation is off: added accounts are not used for Claude app and Claude Code requests.")
                        .font(.callout).foregroundStyle(Theme.warn)
                }
                FormNote("Using several subscriptions may be subject to Anthropic's terms. Use only your own accounts.")
            }
        }

        Section {
            let rows = accounts?.rows() ?? []
            let choosable = accounts?.hasChoice ?? false
            if rows.isEmpty {
                Text("No Claude account yet.").foregroundStyle(.secondary)
            }
            ForEach(rows) { row in
                AccountRow(title: row.isCurrentLogin ? "Current Claude login" : row.label,
                           detail: row.isCurrentLogin ? "Claude Code / Claude Desktop sign-in" : row.email,
                           usage: Format.quotaLine(row.quota),
                           badges: badges(for: row, choosable: choosable),
                           busy: actions.isBusy(.claude, row.id)) {
                    rowActions(row, choosable: choosable)
                }
            }
            Button("Add Claude account…", systemImage: "plus") { actions.signingInClaude = true }
        } header: {
            HStack {
                Text("Claude accounts")
                Spacer()
                if let accounts { Text(count(accounts)).foregroundStyle(.secondary) }
            }
        } footer: {
            if accounts?.hasChoice == true {
                FormNote("New conversations start on the first account. When it hits its limit they move to the next one; once it resets, new conversations go back to it.")
            }
        }

        if let accounts, !accounts.accounts.isEmpty {
            Section {
                LabeledContent("Added accounts") {
                    Button("Remove all…", role: .destructive) { actions.removingAllClaude = true }
                        .disabled(actions.isBusy(.claude, "*"))
                }
            } footer: {
                FormNote("Removes every account added to ClaudeRipple. The Claude Code and Claude Desktop login is not changed.")
            }
        }
    }

    @ViewBuilder
    private func rowActions(_ row: ClaudeAccountRow, choosable: Bool) -> some View {
        if row.needsSignIn {
            Button("Sign in again") { actions.signingInClaude = true }
        }
        if choosable, !row.isFirst {
            Button("Use first") { useFirst(row) }
                .disabled(row.needsSignIn)
                .help("New conversations start on this account")
        }
        if row.isStored {
            AccountMoreMenu {
                actions.rename(.init(kind: .claude, id: row.id, label: row.label))
            } onRemove: {
                actions.removing = .init(kind: .claude, id: row.id, label: row.label)
            }
        }
    }

    private func badges(for row: ClaudeAccountRow, choosable: Bool) -> [StatusBadge] {
        var out: [StatusBadge] = []
        if choosable, row.isFirst { out.append(StatusBadge("First", tone: .accent, symbol: "star.fill")) }
        if row.needsSignIn { out.append(StatusBadge("Sign in again", tone: .bad, symbol: "exclamationmark")) }
        else if row.isCurrentLogin { out.append(StatusBadge("Current login", tone: .ok)) }
        return out
    }

    private func count(_ accounts: ClaudeAccountsResponse) -> String {
        let n = (accounts.current == nil ? 0 : 1) + accounts.accounts.count
        return n == 1 ? "1 account" : "\(n) accounts"
    }

    private func useFirst(_ row: ClaudeAccountRow) {
        Task {
            await actions.perform(.claude, row.id, reload: reload) {
                // The current login is first by default: preferring it clears the preference.
                try await store.client.setPreferredClaudeAccount(row.isCurrentLogin ? nil : row.id)
            }
        }
    }

    private func rotationBinding(_ name: String) -> Binding<Bool> {
        Binding {
            book.providers.claudeRotating.contains(name)
        } set: { on in
            savingRotation = name
            rotationError = nil
            Task {
                do {
                    let warning = try await store.client.updateConfig { config in
                        try AccountProviders.setRotation(on, provider: name, in: &config)
                    }
                    rotationError = warning
                } catch {
                    rotationError = error.asAdminError.userMessage
                }
                await reload()
                savingRotation = nil
            }
        }
    }
}
