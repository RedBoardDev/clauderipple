import RippleKit
import SwiftUI

struct OverviewPane: View {
    let app: AppController
    @Environment(RouterStore.self) private var store
    @State private var router: Loadable<RouterStatus> = .loading
    @State private var recovery = RecoveryModel.shared
    @State private var confirmation: RecoveryModel.Action?
    @State private var logs: Loadable<String> = .loading

    var body: some View {
        Form {
            Section("Router") {
                LoadableView(router, retry: { Task { await loadRouter() } }) { status in
                    routerRows(status)
                }
            }
            recoverySection
            Section("Providers") {
                if let status = router.value {
                    if status.providers.isEmpty { FormNote("No providers are configured.") }
                    ForEach(status.providers) { provider in
                        ProviderOverviewRow(provider: provider)
                    }
                } else { FormNote("Provider status is available when the router answers.") }
                Button("Edit providers on the web dashboard", systemImage: "arrow.up.forward.app") { app.openWebDashboard() }
                    .buttonStyle(.glass)
            }
            Section("Recent router log") {
                LoadableView(logs, retry: { Task { await loadLogs() } }) { text in
                    DisclosureGroup("Last \(AdminClient.recoveryLogLines) lines") {
                        Text(text.isEmpty ? "No log lines yet." : text)
                            .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                FormNote("Logs are read from the admin API and are unavailable while the router is down. Recovery above uses the CLI independently.")
            }
        }
        .formStyle(.grouped)
        .task {
            await recovery.refreshDoctor()
            while !Task.isCancelled {
                do { try await Task.sleep(for: RecoveryModel.doctorInterval) } catch { return }
                await recovery.refreshDoctor()
            }
        }
        .task {
            while !Task.isCancelled {
                async let status: Void = loadRouter()
                async let log: Void = loadLogs()
                _ = await (status, log)
                do { try await Task.sleep(for: AdminClient.powerPollInterval) } catch { return }
            }
        }
        .confirmationDialog(confirmation?.title ?? "Confirm action", isPresented: Binding(
            get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }
        ), presenting: confirmation) { action in
            Button(action.title, role: .destructive) { Task { await recovery.run(action) } }
            Button("Cancel", role: .cancel) {}
        } message: { action in Text(action.confirmation) }
    }

    @ViewBuilder
    private func routerRows(_ status: RouterStatus) -> some View {
        LabeledContent("Version", value: status.version)
        if let started = status.startedAt {
            TimelineView(.periodic(from: .now, by: Self.uptimeInterval)) { context in
                LabeledContent("Uptime", value: Self.uptime(since: started, now: context.date))
            }
        }
        if let ready = status.readiness {
            Label(ready.ready ? "Ready" : "Needs attention", systemImage: ready.ready ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(ready.ready ? Theme.ok : Theme.warn)
            ForEach(ready.problems, id: \.self) { FormNote($0) }
        }
        if let stats = status.stats {
            LabeledContent("In flight", value: String(stats.inFlight))
            LabeledContent("Started / completed / failed", value: "\(stats.started.map(String.init) ?? "—") / \(stats.completed.map(String.init) ?? "—") / \(stats.failed.map(String.init) ?? "—")")
        }
        LabeledContent("Consecutive upstream failures", value: status.consecutiveUpstreamFailures.map(String.init) ?? "Unknown")
        LabeledContent("Routes", value: status.routes.map(String.init) ?? "Unknown")
        LabeledContent("Proxy settings point at router", value: Self.yesNo(status.settings?.pointsAtRouter))
        LabeledContent("Model picker", value: Self.onOff(status.picker?.enabled))
        LabeledContent("Status mod", value: Self.onOff(status.statusMod))
    }

    private var recoverySection: some View {
        Section("Connection and recovery") {
            if recovery.checking { ProgressView("Checking connection…").controlSize(.small) }
            if let doctor = recovery.doctor {
                LabeledContent("Connection mode", value: doctor.mode?.capitalized ?? "Unknown")
                LabeledContent("Router", value: doctor.router?.responding == true ? "Responding" : "Not responding")
                LabeledContent("Supervisor", value: "\(doctor.supervisor?.registered == true ? "Registered" : "Not registered") · \(doctor.supervisor?.state ?? "Unknown")")
                if doctor.supervisor?.programExists == false { InlineError("The supervisor's program is missing.") }
                LabeledContent("Desktop proxy", value: doctor.desktop?.proxy ?? "Unknown")
                LabeledContent("CLI proxy", value: doctor.cli?.proxy ?? "Unknown")
                ForEach(Array((doctor.problems ?? []).enumerated()), id: \.offset) { _, problem in
                    Label(problem.message ?? problem.code ?? "Unknown problem", systemImage: "exclamationmark.circle")
                        .foregroundStyle(Theme.warn).fixedSize(horizontal: false, vertical: true)
                }
                if doctor.mode == "direct" { FormNote("Direct mode is intentional: Claude bypasses ClaudeRipple even if the router is running.") }
            } else if !recovery.checking {
                FormNote("The CLI connection check is unavailable. Repair and direct mode do not require the admin API.")
            }
            HStack {
                Button("Repair", systemImage: "wrench.and.screwdriver") { confirmation = .repair }.buttonStyle(.glassProminent)
                if recovery.doctor?.mode == "direct" {
                    Button("Direct mode off", systemImage: "arrow.triangle.branch") { confirmation = .directOff }.buttonStyle(.glass)
                } else {
                    Button("Direct mode on", systemImage: "arrow.right") { confirmation = .directOn }.buttonStyle(.glass)
                    if recovery.doctor?.mode == "mixed" {
                        Button("Use ClaudeRipple") { confirmation = .directOff }.buttonStyle(.glass)
                    }
                }
                Button("Check", systemImage: "arrow.clockwise") { Task { await recovery.refreshDoctor() } }.buttonStyle(.glass)
            }.disabled(recovery.busy || recovery.checking)
            if recovery.busy { ProgressView("Running action…").controlSize(.small) }
            if let result = recovery.result { FormNote(result) }
            InlineError(recovery.error)
            InlineError(recovery.doctorError)
            if recovery.restartClaude {
                FormNote("Restart Claude Desktop and start new Claude Code sessions to apply the connection change.")
                Button("Restart Claude", systemImage: "arrow.clockwise.circle") { confirmation = .restart }
                    .buttonStyle(.glassProminent).disabled(recovery.busy || recovery.checking)
            }
            DisclosureGroup("Details") {
                if let doctor = recovery.doctor {
                    if let path = doctor.supervisor?.program { LabeledContent("Supervisor program", value: path) }
                    if let url = doctor.desktop?.url { LabeledContent("Desktop proxy URL", value: url) }
                    if let url = doctor.cli?.url { LabeledContent("CLI proxy URL", value: url) }
                }
                Text(recovery.details.isEmpty ? "No action output yet." : recovery.details)
                    .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                if recovery.doctorError != nil, !recovery.doctorDetails.isEmpty {
                    Text(recovery.doctorDetails).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                }
            }
        }
    }

    /// Uptime only needs minute resolution; seconds would cause needless redraws.
    private static let uptimeInterval: TimeInterval = 60
    private static let secondsPerMinute: TimeInterval = 60
    private static let minutesPerHour = 60
    private static func uptime(since: Date, now: Date) -> String {
        let minutes = max(0, Int(now.timeIntervalSince(since) / secondsPerMinute))
        return "\(minutes / minutesPerHour)h \(minutes % minutesPerHour)m"
    }
    private static func yesNo(_ value: Bool?) -> String { value.map { $0 ? "Yes" : "No" } ?? "Unknown" }
    private static func onOff(_ value: Bool?) -> String { value.map { $0 ? "On" : "Off" } ?? "Unknown" }

    private func loadRouter() async {
        do {
            let status = try await store.client.status()
            if !Task.isCancelled { router = .loaded(status) }
        } catch { if !Task.isCancelled { router = .failed(error.asAdminError) } }
    }
    private func loadLogs() async {
        do {
            let text = try await store.client.recentRouterLogs()
            if !Task.isCancelled { logs = .loaded(text) }
        } catch { if !Task.isCancelled { logs = .failed(error.asAdminError) } }
    }
}
