import AppKit
import SwiftUI

struct CollectorMenuView: View {
  @ObservedObject var model: CollectorModel
  @State private var receiverDraft: String

  init(model: CollectorModel) {
    self.model = model
    _receiverDraft = State(initialValue: model.receiverURLString)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Label(model.statusDescription, systemImage: model.statusSymbolName)
        .font(.headline)
        .lineLimit(2)

      Label(
        model.screenRecordingPermissionStatus.title,
        systemImage: model.screenRecordingPermissionStatus.symbolName
      )
      .font(.caption)
      .foregroundStyle(
        model.screenRecordingPermissionStatus == .granted
          ? Color.secondary
          : Color.orange
      )

      HStack {
        Text("Last upload")
        Spacer()
        Text(model.lastUploadDescription)
          .foregroundStyle(.secondary)
      }
      .font(.caption)

      HStack {
        Text("Pending")
        Spacer()
        Text("\(model.pendingCount)")
          .foregroundStyle(.secondary)
      }
      .font(.caption)

      HStack {
        Button(model.isPaused ? "Resume" : "Pause") {
          model.setPaused(!model.isPaused)
        }

        Button("Capture Now") {
          Task { await model.captureNow() }
        }
        .disabled(model.isBusy)
      }

      Picker(
        "Automatic capture",
        selection: Binding(
          get: { model.interval },
          set: { model.setInterval($0) }
        )
      ) {
        ForEach(CaptureInterval.allCases) { interval in
          Text(interval.title).tag(interval)
        }
      }

      Divider()

      Text("Receiver URL")
        .font(.subheadline.weight(.semibold))
      TextField(
        "https://host.tailnet.ts.net/v1/screen-captures",
        text: $receiverDraft
      )
      .textFieldStyle(.roundedBorder)
      Button("Save Receiver URL") {
        if model.saveReceiverURL(receiverDraft) {
          receiverDraft = model.receiverURLString
        }
      }
      if let message = model.receiverValidationMessage {
        Text(message)
          .font(.caption)
          .foregroundStyle(.red)
      }

      if model.pendingCount > 0 {
        Button("Retry Pending (\(model.pendingCount))") {
          Task { await model.retryPending() }
        }
        .disabled(model.isBusy)
      }

      HStack {
        if #available(macOS 14.0, *) {
          SettingsLink {
            Text("Settings…")
          }
        } else {
          Text("Settings are available in this menu")
            .foregroundStyle(.secondary)
        }
        Spacer()
        Button("Quit") {
          NSApplication.shared.terminate(nil)
        }
      }
      .font(.caption)
    }
    .onAppear {
      receiverDraft = model.receiverURLString
      model.refreshScreenRecordingPermission()
    }
    .padding(16)
    .frame(width: 340)
  }
}

struct CollectorSettingsView: View {
  @ObservedObject var model: CollectorModel
  @State private var receiverDraft: String

  init(model: CollectorModel) {
    self.model = model
    _receiverDraft = State(initialValue: model.receiverURLString)
  }

  var body: some View {
    Form {
      Section("Capture") {
        Picker(
          "Automatic capture",
          selection: Binding(
            get: { model.interval },
            set: { model.setInterval($0) }
          )
        ) {
          ForEach(CaptureInterval.allCases) { interval in
            Text(interval.title).tag(interval)
          }
        }
        Toggle(
          "Pause automatic captures",
          isOn: Binding(
            get: { model.isPaused },
            set: { model.setPaused($0) }
          ))
        Label(
          model.screenRecordingPermissionStatus.title,
          systemImage: model.screenRecordingPermissionStatus.symbolName
        )
        .font(.caption)
        .foregroundStyle(
          model.screenRecordingPermissionStatus == .granted
            ? Color.secondary
            : Color.orange
        )
        Text("Only the main display is captured. Capture Now remains available while paused.")
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      Section("Receiver") {
        TextField("Receiver URL", text: $receiverDraft)
          .textFieldStyle(.roundedBorder)
        Button("Save") {
          if model.saveReceiverURL(receiverDraft) {
            receiverDraft = model.receiverURLString
          }
        }
        if let message = model.receiverValidationMessage {
          Text(message)
            .font(.caption)
            .foregroundStyle(.red)
        }
        Text("HTTPS .ts.net URLs only; an optional port and /v1/screen-captures are required.")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .onAppear {
      receiverDraft = model.receiverURLString
      model.refreshScreenRecordingPermission()
    }
    .formStyle(.grouped)
    .padding()
    .frame(width: 460)
  }
}
