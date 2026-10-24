import RippleKit
import SwiftUI

struct LaptopPane: View {
    let app: AppController
    @Environment(RouterStore.self) private var store
    @State private var power: Loadable<PowerStatus> = .loading
    @State private var busy = false
    @State private var actionError: String?
    @State private var deadline = Date().addingTimeInterval(Self.defaultDeadline)
    @State private var ssid = ""
    @State private var setup: JobState?
    @State private var setupRunning = false
    @State private var confirmSetup = false
    /// A convenient initial deadline; only saved by the explicit Apply button.
    private static let defaultDeadline: TimeInterval = 60 * 60

    var body: some View {
        Form {
            if case .failed(.routeMissing) = power {
                unavailable
            } else if case .failed(.http(status: 501, _)) = power {
                unavailable
            } else {
                LoadableView(power, retry: { Task { await load() } }) { status in
                    awakeSection(status.awake)
                    tetherSection(status.tether)
                    if status.awake.setup == "needs-setup" || status.tether.needsSetup {
                        setupSection
                    }
                    if setupRunning || setup?.output != nil || setup?.ok != nil {
                        Section("Setup progress") {
                            if setupRunning {
                                ProgressView("Waiting for setup…").controlSize(.small)
                                FormNote("macOS may be showing its password dialog. ClaudeRipple does not see your password.")
                            } else if let ok = setup?.ok {
                                Label(ok ? "Setup completed" : "Setup did not complete", systemImage: ok ? "checkmark.circle" : "exclamationmark.circle")
                                    .foregroundStyle(ok ? Theme.ok : Theme.bad)
                            }
                            if let output = setup?.output, !output.isEmpty {
                                DisclosureGroup("Output") { Text(output).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                            }
                        }
                    }
                }
            }
            if busy { ProgressView("Applying…").controlSize(.small) }
            InlineError(actionError)
        }
        .formStyle(.grouped)
        .task {
            await load()
            while !Task.isCancelled {
                do { try await Task.sleep(for: AdminClient.powerPollInterval) } catch { return }
                await load()
            }
        }
        .task(id: setupRunning) {
            guard setupRunning else { return }
            do {
                _ = try await store.client.pollPowerSetup { job in
                    await MainActor.run { setup = job }
                }
                setupRunning = false
                await load()
            } catch is CancellationError {
                // A hidden pane stops observing, not the OS job. Reopening adopts it again.
            } catch {
                setupRunning = false
                actionError = error.asAdminError.userMessage
            }
        }
        .confirmationDialog("Run laptop setup?", isPresented: $confirmSetup) {
            Button("Run setup") { Task { await startSetup() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("macOS will ask for your password to allow lid-closed keep-awake and joining the named hotspot. Setup also removes Insomnia if installed. Your password stays in the macOS dialog.")
        }
    }

    private var unavailable: some View {
        Section {
            ContentUnavailableView("Update the router to use this", systemImage: "laptopcomputer", description: Text("This router version does not support laptop controls. Check for updates in About."))
        }
    }

    @ViewBuilder
    private func awakeSection(_ awake: AwakeStatus) -> some View {
        Section("Keep awake") {
            if awake.setup == "unsupported" {
                FormNote("Keep-awake is not supported on the router's platform.")
            }
            Picker("Mode", selection: Binding(get: { awake.mode }, set: { mode in
                Task { await setAwake(mode, until: nil) }
            })) {
                ForEach(AwakeStatus.Mode.allCases) { mode in Text(mode.title).tag(mode) }
            }
            .pickerStyle(.segmented).disabled(busy || setupRunning || awake.setup != "ok")
            FormNote("Working keeps the laptop awake during model calls and briefly afterwards. On keeps it awake until you turn it off or its deadline passes. Battery and thermal safeguards still apply.")
            if awake.mode == .on {
                if let until = awake.untilDate {
                    LabeledContent("Until", value: until.formatted(date: .abbreviated, time: .shortened))
                    Button("Clear deadline", systemImage: "xmark.circle") { Task { await setAwake(awake.mode, until: nil) } }
                        .buttonStyle(.glass).disabled(busy || setupRunning)
                }
                DatePicker("New deadline", selection: $deadline, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                Button("Apply deadline") { Task { await setAwake(awake.mode, until: deadline) } }
                    .buttonStyle(.glass).disabled(busy || setupRunning || deadline <= Date())
            }
            LabeledContent("Applied", value: awake.applied ? "Yes" : "No")
            LabeledContent("Reason", value: awake.reason)
            if let battery = awake.battery {
                LabeledContent("Battery", value: battery.percent.map { "\($0.formatted(.number.precision(.fractionLength(0))))%" } ?? "Unknown")
                LabeledContent("Power source", value: battery.onBattery ? "Battery" : "External power")
            }
            LabeledContent("Lid", value: awake.lidClosed.map { $0 ? "Closed" : "Open" } ?? "Unknown")
            LabeledContent("Thermal state", value: awake.thermal ?? "Unknown")
        }
    }

    @ViewBuilder
    private func tetherSection(_ tether: TetherStatus) -> some View {
        Section("Phone hotspot failover") {
            Toggle("Enable hotspot failover", isOn: Binding(get: { tether.enabled }, set: { enabled in
                Task {
                    await apply { try await store.client.setTetherEnabled(enabled) }
                }
            })).disabled(busy || setupRunning || tether.state == "unsupported")
            LabeledContent("Network", value: tether.networkTitle)
            LabeledContent("State", value: tether.stateTitle)
            LabeledContent("Pinned", value: tether.pinned ? "Yes — automatic switching paused" : "No")
            LabeledContent("Hotspot name", value: tether.hotspotSsid.isEmpty ? "Not set" : tether.hotspotSsid)
            if let change = tether.lastSwitch {
                LabeledContent("Last switch", value: "\(change.to) · \(change.ok ? "Succeeded" : "Failed") · \(change.at)")
                FormNote(change.reason)
            }
            if let probe = tether.lastProbe {
                LabeledContent("Last probe", value: "\(probe.network) · \(probe.ok ? "Internet reachable" : "No internet") · \(probe.at)")
            }
            if let hint = tether.hint { FormNote(hint) }
        }
    }

    private var setupSection: some View {
        Section("Laptop setup") {
            FormNote("Allow keep-awake with the lid closed and automatic hotspot connections. The hotspot name is optional; it must match your phone's Wi-Fi name.")
            TextField("Hotspot name (optional)", text: $ssid).disabled(busy || setupRunning)
            Button("Run setup", systemImage: "lock.open") { confirmSetup = true }
                .buttonStyle(.glassProminent).disabled(busy || setupRunning)
        }
    }

    private func load() async {
        guard !busy else { return }
        do {
            let status = try await store.client.power()
            guard !Task.isCancelled else { return }
            power = .loaded(status)
            if !setupRunning {
                if let job = try? await store.client.powerSetup() {
                    setup = job
                    setupRunning = job.running
                }
            }
        } catch {
            guard !Task.isCancelled else { return }
            power = .failed(error.asAdminError)
        }
    }

    private func apply(_ operation: () async throws -> PowerStatus) async {
        guard !busy else { return }
        busy = true
        actionError = nil
        defer { busy = false }
        do { power = .loaded(try await operation()) }
        catch { actionError = error.asAdminError.userMessage }
    }

    private func setAwake(_ mode: AwakeStatus.Mode, until: Date?) async {
        await apply { try await store.client.setAwakeMode(mode, until: until) }
    }

    private func startSetup() async {
        guard !setupRunning, !busy else { return }
        busy = true
        actionError = nil
        defer { busy = false }
        let name = ssid.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            try await store.client.startPowerSetup(ssid: name.isEmpty ? nil : name)
            setup = nil
            setupRunning = true
        } catch AdminError.http(status: 409, _) {
            // Another window may already have started the same OS dialog.
            setupRunning = true
        } catch { actionError = error.asAdminError.userMessage }
    }
}
