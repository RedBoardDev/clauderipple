import RippleKit
import SwiftUI

/// State shared by the Accounts pane's rows: which row is busy, the rename / remove prompts, the
/// sign-in flows, and the last error. One object so every row disables the same way and one
/// prompt is open at a time.
@MainActor
@Observable
final class AccountActions {
    enum Kind: Sendable { case claude, chatgpt }

    struct Target: Identifiable, Equatable {
        let kind: Kind
        let id: String
        let label: String
        var key: String { AccountActions.key(kind, id) }
    }

    var error: String?
    private(set) var busy: Set<String> = []
    var renaming: Target?
    var renameDraft = ""
    var removing: Target?
    var removingAllClaude = false
    var signingInClaude = false
    /// The router runs one ChatGPT login at a time; while it runs this holds what to tell the user.
    private(set) var chatgptLoginMessage: String?

    /// How often a running ChatGPT login is polled, and how long before the app stops waiting
    /// (the dashboard's values: the CLI login itself times out a little earlier).
    static let loginPollInterval: Duration = .seconds(2)
    static let loginDeadline: TimeInterval = 6 * 60

    nonisolated static func key(_ kind: Kind, _ id: String) -> String { "\(kind):\(id)" }

    func isBusy(_ kind: Kind, _ id: String) -> Bool { busy.contains(Self.key(kind, id)) }

    func rename(_ target: Target) {
        renameDraft = target.label
        renaming = target
    }

    /// Runs one change for one row, then reloads; a failure lands in `error` in the router's words.
    func perform(_ kind: Kind, _ id: String, reload: @escaping () async -> Void, _ work: @escaping () async throws -> Void) async {
        let key = Self.key(kind, id)
        guard !busy.contains(key) else { return }
        busy.insert(key)
        error = nil
        defer { busy.remove(key) }
        do {
            try await work()
        } catch {
            self.error = error.asAdminError.userMessage
        }
        await reload()
    }

    /// Starts the router's ChatGPT browser login and waits for it, as the dashboard does.
    func signInChatGpt(client: AdminClient, adding: Bool, reload: @escaping () async -> Void) async {
        guard chatgptLoginMessage == nil else { return }
        error = nil
        chatgptLoginMessage = adding
            ? "Sign in with the account to add in your browser. If it shows an account you already added, pick another."
            : "Finish signing in in your browser. This updates when it is done."
        defer { chatgptLoginMessage = nil }
        do {
            _ = try await client.startChatGptLogin()
            let deadline = Date().addingTimeInterval(Self.loginDeadline)
            while Date() < deadline {
                try await Task.sleep(for: Self.loginPollInterval)
                let state = try await client.chatgptLoginState()
                guard state.running == false else { continue }
                if state.ok == false { error = Self.lastLine(of: state.output) ?? "ChatGPT sign-in failed." }
                break
            }
        } catch is CancellationError {
            return
        } catch {
            self.error = error.asAdminError.userMessage
        }
        await reload()
    }

    /// The CLI's last meaningful line: its output can run long, the reason is at the end.
    private static func lastLine(of output: String?) -> String? {
        output?.split(whereSeparator: \.isNewline).last { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.map(String.init)
    }
}

/// The pane's prompts: rename, remove, remove all, and the Claude sign-in sheet.
private struct AccountPrompts: ViewModifier {
    @Bindable var actions: AccountActions
    let client: AdminClient
    let reload: () async -> Void

    func body(content: Content) -> some View {
        content
            .alert("Rename account", isPresented: presence($actions.renaming), presenting: actions.renaming) { target in
                TextField("Name", text: $actions.renameDraft)
                Button("Rename") { apply(rename: target) }
                Button("Cancel", role: .cancel) {}
            } message: { target in
                Text("The name ClaudeRipple shows for \(target.label).")
            }
            .confirmationDialog(removeTitle, isPresented: presence($actions.removing), titleVisibility: .visible,
                                presenting: actions.removing) { target in
                Button("Remove", role: .destructive) { apply(remove: target) }
            } message: { target in
                Text(target.kind == .claude
                     ? "Its sign-in is deleted from this Mac. Claude Code and Claude Desktop keep their own login."
                     : "Its sign-in is deleted from this Mac.")
            }
            .confirmationDialog("Remove every Claude account added to ClaudeRipple?", isPresented: $actions.removingAllClaude,
                                titleVisibility: .visible) {
                Button("Remove all", role: .destructive) { removeAll() }
            } message: {
                Text("The current Claude Code and Claude Desktop login is not changed.")
            }
            .sheet(isPresented: $actions.signingInClaude) {
                ClaudeSignInSheet(client: client) { await reload() }
            }
    }

    private var removeTitle: String {
        guard let target = actions.removing else { return "Remove account?" }
        return "Remove \(target.kind == .claude ? "Claude" : "ChatGPT") account \(target.label) from ClaudeRipple?"
    }

    private func presence<T>(_ binding: Binding<T?>) -> Binding<Bool> {
        Binding(get: { binding.wrappedValue != nil }, set: { if !$0 { binding.wrappedValue = nil } })
    }

    private func apply(rename target: AccountActions.Target) {
        let label = actions.renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !label.isEmpty, label != target.label else { return }
        Task {
            await actions.perform(target.kind, target.id, reload: reload) {
                switch target.kind {
                case .claude: try await client.renameClaudeAccount(target.id, label: label)
                case .chatgpt: try await client.updateChatGptAccount(target.id, label: label)
                }
            }
        }
    }

    private func apply(remove target: AccountActions.Target) {
        Task {
            await actions.perform(target.kind, target.id, reload: reload) {
                switch target.kind {
                case .claude: try await client.removeClaudeAccount(target.id)
                case .chatgpt: try await client.removeChatGptAccount(target.id)
                }
            }
        }
    }

    private func removeAll() {
        Task {
            await actions.perform(.claude, "*", reload: reload) {
                _ = try await client.removeAllClaudeAccounts()
            }
        }
    }
}

extension View {
    func accountPrompts(actions: AccountActions, client: AdminClient, reload: @escaping () async -> Void) -> some View {
        modifier(AccountPrompts(actions: actions, client: client, reload: reload))
    }
}
