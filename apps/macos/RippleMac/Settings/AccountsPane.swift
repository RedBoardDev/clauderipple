import RippleKit
import SwiftUI

/// Every subscription account the router can use: Claude logins (rotation, use first, add, rename,
/// remove) and ChatGPT logins per provider (pause, use now, add, rename, remove). Google
/// Antigravity accounts stay in the web dashboard.
struct AccountsPane: View {
    let app: AppController
    @Environment(RouterStore.self) private var store
    @State private var book: Loadable<AccountsBook> = .loading
    @State private var revision = 0
    @State private var actions = AccountActions()

    /// Cooldowns and quotas move on their own; re-read while the pane is on screen.
    private static let refreshInterval: Duration = .seconds(15)

    var body: some View {
        LoadableView(book, retry: { revision += 1 }) { book in
            Form {
                if let message = actions.error {
                    Section { InlineError(message) }
                }
                if book.providers.claude.isEmpty, book.providers.chatgpt.isEmpty {
                    Section {
                        ContentUnavailableView("No subscription providers", systemImage: "person.crop.circle.badge.questionmark",
                                               description: Text("Add a Claude or ChatGPT subscription provider in the web dashboard, then sign in here."))
                    }
                }
                if !book.providers.claude.isEmpty {
                    ClaudeAccountsSection(book: book, actions: actions, reload: reload)
                }
                ForEach(book.chatgpt, id: \.provider) { entry in
                    ChatGptAccountsSection(provider: entry.provider, accounts: entry.accounts,
                                           showsProviderName: book.chatgpt.count > 1, actions: actions, reload: reload)
                }
                if !book.providers.google.isEmpty {
                    Section {
                        LabeledContent("Antigravity accounts") {
                            Button("Open web dashboard") { app.openWebDashboard(section: "providers") }
                        }
                    } header: {
                        Text("Google")
                    } footer: {
                        FormNote("Google sign-in shows Google's terms and a verification step, which the web dashboard handles.")
                    }
                }
            }
            .formStyle(.grouped)
        }
        .toolbar {
            ToolbarItem {
                Button("Refresh", systemImage: "arrow.clockwise") { revision += 1 }
                    .help("Refresh accounts")
            }
        }
        .task(id: revision) {
            if book.value == nil { book = .loading }
            while !Task.isCancelled {
                await load()
                do { try await Task.sleep(for: Self.refreshInterval) } catch { return }
            }
        }
        .accountPrompts(actions: actions, client: store.client, reload: reload)
    }

    private func load() async {
        do {
            let loaded = try await AccountsBook.load(from: store.client)
            book = .loaded(loaded)
            if !loaded.providers.claude.isEmpty {
                store.claudeRotation = !loaded.providers.claudeRotating.isDisjoint(with: loaded.providers.claude)
            }
        } catch {
            // Keep showing the last good list through a transient failure.
            if book.value == nil { book = .failed(error.asAdminError) }
        }
    }

    /// After a change: re-read this pane and the popover's account rows.
    private func reload() async {
        await load()
        await store.reloadAccounts()
    }
}

/// What the pane shows, read in one pass.
struct AccountsBook {
    let providers: AccountProviders
    let claude: ClaudeAccountsResponse?
    let chatgpt: [(provider: String, accounts: [ChatGptAccount])]

    static func load(from client: AdminClient) async throws -> AccountsBook {
        // The config carries credentials: only the provider names and flags leave this function.
        let providers = AccountProviders(config: try await client.config())
        let claude = providers.claude.isEmpty ? nil : try await client.claudeAccounts()
        var chatgpt: [(String, [ChatGptAccount])] = []
        for name in providers.chatgpt {
            chatgpt.append((name, try await client.chatgptAccounts(provider: name).accounts))
        }
        return AccountsBook(providers: providers, claude: claude, chatgpt: chatgpt)
    }
}
