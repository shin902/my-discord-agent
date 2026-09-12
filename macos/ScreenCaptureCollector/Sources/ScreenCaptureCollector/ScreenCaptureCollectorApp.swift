import SwiftUI

@main
struct ScreenCaptureCollectorApp: App {
  @StateObject private var model: CollectorModel

  init() {
    let model = CollectorModel()
    _model = StateObject(wrappedValue: model)
    model.start()
  }

  var body: some Scene {
    MenuBarExtra {
      CollectorMenuView(model: model)
    } label: {
      Label("Screen Capture", systemImage: model.statusSymbolName)
    }
    .menuBarExtraStyle(.window)

    Settings {
      CollectorSettingsView(model: model)
    }
  }
}
