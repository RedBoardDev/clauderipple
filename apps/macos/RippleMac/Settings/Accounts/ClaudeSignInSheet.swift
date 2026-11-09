import RippleKit
import SwiftUI

/// Adds (or re-signs) a Claude account through the router's own PKCE OAuth: a consent step, then the
/// browser, then either the router's loopback callback or a pasted code. Closing the sheet while an
/// attempt runs cancels it. Tokens never reach the app; the router stores them.
struct ClaudeSignInSheet: View {
    let client: AdminClient
    let onDone: () async -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    private enum Step: Equatable {
        case consent
        case starting
        case waiting(url: URL?, manual: Bool)
        case failed(String?)
    }

    @State private var step: Step = .consent
    @State private var accepted = false
    @State private var code = ""
    @State private var submitting = false
    @State private var attempt = 0

    /// The dashboard's poll cadence for a running attempt.
    private static let pollInterval: Duration = .seconds(2)
    private static let width: CGFloat = 460

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Add Claude account", systemImage: "person.crop.circle.badge.plus")
                .font(.title3.weight(.semibold))
            content
        }
        .padding(20)
        .frame(width: Self.width)
        .task(id: attempt) { await poll() }
        // However the sheet goes away (Cancel, Esc, the window closing), a running attempt is cancelled.
        .onDisappear { if isRunning { Task { [client] in try? await client.cancelClaudeOAuth() } } }
    }

    @ViewBuilder
    private var content: some View {
        switch step {
        case .consent:
            Label {
                Text("Using a Claude subscription through a third-party proxy is not an Anthropic-supported integration and may be subject to terms or account restrictions. Use only your own accounts for authorized purposes.")
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.warn)
            }
            .font(.callout)
            Toggle("I understand the risk and want to continue.", isOn: $accepted)
                .toggleStyle(.checkbox)
            buttons {
                Button("Continue in browser") { start(manual: false) }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!accepted)
            }
        case .starting:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Starting sign-in…").foregroundStyle(.secondary)
            }
            buttons { EmptyView() }
        case let .waiting(url, manual):
            Text(manual ? "After signing in, paste the code the page shows." : "Sign in to Claude in your browser. If no window opened, open the sign-in page.")
                .fixedSize(horizontal: false, vertical: true)
            if let url {
                Button("Open the sign-in page", systemImage: "safari") { openURL(url) }
                    .buttonStyle(.link)
            }
            if manual {
                HStack {
                    TextField("code#state", text: $code)
                        .textFieldStyle(.roundedBorder)
                        .autocorrectionDisabled()
                        .onSubmit(submit)
                    Button("Submit code", action: submit)
                        .disabled(code.trimmingCharacters(in: .whitespaces).isEmpty || submitting)
                }
            } else {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Waiting for the browser… (up to 5 minutes)").font(.callout).foregroundStyle(.secondary)
                }
            }
            buttons {
                if !manual { Button("Paste a code instead") { start(manual: true) } }
            }
        case let .failed(message):
            Label("Sign-in failed", systemImage: "xmark.octagon.fill")
                .foregroundStyle(Theme.bad)
            if let message { Text(message).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            buttons {
                Button("Try again by pasting a code") { start(manual: true) }
                    .keyboardShortcut(.defaultAction)
            }
        }
    }

    private func buttons(@ViewBuilder _ trailing: () -> some View) -> some View {
        HStack {
            Spacer()
            Button("Cancel", role: .cancel) { close() }
                .keyboardShortcut(.cancelAction)
            trailing()
        }
        .padding(.top, 4)
    }

    private var isRunning: Bool {
        switch step {
        case .starting, .waiting: true
        case .consent, .failed: false
        }
    }

    private func start(manual: Bool) {
        step = .starting
        code = ""
        Task {
            do {
                let state = try await client.startClaudeOAuth(manual: manual)
                step = .waiting(url: state.url.flatMap(URL.init(string:)), manual: state.manual ?? manual)
                attempt += 1
            } catch {
                step = .failed(error.asAdminError.userMessage)
            }
        }
    }

    /// Polls the running attempt until the router reports it finished.
    private func poll() async {
        guard case .waiting = step else { return }
        while !Task.isCancelled {
            do { try await Task.sleep(for: Self.pollInterval) } catch { return }
            // A transient failure keeps the last state: the router may be busy refreshing quotas.
            guard let state = try? await client.claudeOAuthState(), !state.running else { continue }
            await finish(state)
            return
        }
    }

    private func submit() {
        let value = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !submitting else { return }
        submitting = true
        Task {
            defer { submitting = false }
            do {
                await finish(try await client.submitClaudeOAuthCode(value))
            } catch {
                step = .failed(error.asAdminError.userMessage)
            }
        }
    }

    private func finish(_ state: ClaudeOAuthState) async {
        guard state.ok == true else {
            step = .failed(state.error)
            return
        }
        step = .consent
        await onDone()
        dismiss()
    }

    private func close() { dismiss() }
}
