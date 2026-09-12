import Combine
import Foundation

@MainActor
enum CollectorStatus: Equatable {
  case ready
  case recording
  case uploading
  case pending(Int)
  case failure(String)
}

@MainActor
final class CollectorModel: ObservableObject {
  enum DefaultsKey {
    static let paused = "screenCaptureCollector.paused"
    static let interval = "screenCaptureCollector.interval"
    static let receiverURL = "screenCaptureCollector.receiverURL"
    static let lastUploadAt = "screenCaptureCollector.lastUploadAt"
  }

  @Published private(set) var status: CollectorStatus = .ready
  @Published private(set) var pendingCount = 0
  @Published private(set) var isPaused: Bool
  @Published private(set) var interval: CaptureInterval
  @Published private(set) var receiverURLString: String
  @Published private(set) var receiverValidationMessage: String?
  @Published private(set) var screenRecordingPermissionStatus: ScreenRecordingPermissionStatus
  @Published private(set) var lastUploadAt: Date?
  @Published private(set) var isBusy = false

  private let defaults: UserDefaults
  private let pendingStore: PendingCaptureStore
  private let captureSource: any ScreenCaptureSource
  private let uploader: CaptureUploader
  private var timer: Timer?
  private var started = false

  init(
    defaults: UserDefaults = .standard,
    pendingStore: PendingCaptureStore = PendingCaptureStore(),
    captureSource: any ScreenCaptureSource = MainDisplayCaptureSource(),
    uploader: CaptureUploader = CaptureUploader()
  ) {
    self.defaults = defaults
    self.pendingStore = pendingStore
    self.captureSource = captureSource
    self.uploader = uploader
    self.isPaused = defaults.bool(forKey: DefaultsKey.paused)

    let storedInterval = defaults.object(forKey: DefaultsKey.interval) as? Int
    self.interval =
      CaptureInterval(rawValue: storedInterval ?? CaptureInterval.oneMinute.rawValue)
      ?? .oneMinute

    let storedURL = defaults.string(forKey: DefaultsKey.receiverURL) ?? ""
    if ReceiverURLValidator.validate(storedURL) != nil {
      self.receiverURLString = storedURL
    } else {
      self.receiverURLString = ""
      if !storedURL.isEmpty {
        defaults.removeObject(forKey: DefaultsKey.receiverURL)
      }
    }
    self.receiverValidationMessage = nil
    self.screenRecordingPermissionStatus = MainDisplayCaptureSource.screenRecordingPermissionStatus
    self.lastUploadAt = defaults.object(forKey: DefaultsKey.lastUploadAt) as? Date
    refreshPending()
  }

  deinit {
    timer?.invalidate()
  }

  var receiverURL: URL? {
    ReceiverURLValidator.validate(receiverURLString)
  }

  var automaticCaptureInterval: TimeInterval? {
    isPaused ? nil : interval.seconds
  }

  var lastUploadDescription: String {
    lastUploadAt?.formatted(date: .omitted, time: .shortened) ?? "Never"
  }

  func refreshScreenRecordingPermission() {
    screenRecordingPermissionStatus = MainDisplayCaptureSource.screenRecordingPermissionStatus
  }

  var statusDescription: String {
    switch status {
    case .recording:
      return "Recording…"
    case .uploading:
      return "Uploading…"
    case .failure(let message):
      return pendingCount > 0
        ? "Failure: \(message) · \(pendingCount) pending"
        : "Failure: \(message)"
    case .ready:
      if isPaused { return "Paused" }
      return pendingCount > 0 ? "Recording · \(pendingCount) pending" : "Recording"
    case .pending(let count):
      return isPaused ? "Paused · \(count) pending" : "Recording · \(count) pending"
    }
  }

  var statusSymbolName: String {
    switch status {
    case .recording:
      return "record.circle.fill"
    case .uploading:
      return "arrow.up.circle"
    case .failure:
      return "exclamationmark.triangle"
    case .ready, .pending:
      return isPaused ? "pause.circle" : "record.circle"
    }
  }

  func start() {
    guard !started else { return }
    started = true
    scheduleTimer()
    if !isPaused {
      Task { [weak self] in
        await self?.retryPending()
      }
    }
  }

  func stop() {
    timer?.invalidate()
    timer = nil
    started = false
  }

  func setPaused(_ paused: Bool) {
    guard isPaused != paused else { return }
    isPaused = paused
    defaults.set(paused, forKey: DefaultsKey.paused)
    scheduleTimer()
    if !paused {
      Task { [weak self] in
        await self?.retryPending()
      }
    }
  }

  func setInterval(_ interval: CaptureInterval) {
    guard self.interval != interval else { return }
    self.interval = interval
    defaults.set(interval.rawValue, forKey: DefaultsKey.interval)
    scheduleTimer()
  }

  @discardableResult
  func saveReceiverURL(_ value: String) -> Bool {
    guard ReceiverURLValidator.validate(value) != nil else {
      receiverValidationMessage = "Use https://<host>.<tailnet>.ts.net[:port]/v1/screen-captures."
      return false
    }
    defaults.set(value, forKey: DefaultsKey.receiverURL)
    receiverURLString = value
    receiverValidationMessage = nil
    if pendingCount > 0 && !isPaused {
      Task { [weak self] in
        await self?.retryPending()
      }
    }
    return true
  }

  func captureNow() async {
    guard !isBusy else { return }
    refreshScreenRecordingPermission()
    isBusy = true
    status = .recording
    await Task.yield()
    defer { isBusy = false }

    do {
      let image = try captureSource.capturePNG()
      _ = try pendingStore.enqueue(image)
      refreshPending()
      await uploadPending()
    } catch {
      refreshPending()
      reportFailure(error)
    }
  }

  func retryPending() async {
    guard !isBusy else { return }
    isBusy = true
    defer { isBusy = false }
    await uploadPending()
  }

  func performAutomaticCapture() async {
    guard !isPaused else { return }
    await captureNow()
  }

  private func scheduleTimer() {
    timer?.invalidate()
    timer = nil
    guard started, !isPaused else { return }
    timer = Timer.scheduledTimer(
      withTimeInterval: interval.seconds,
      repeats: true
    ) { [weak self] _ in
      Task { @MainActor [weak self] in
        await self?.performAutomaticCapture()
      }
    }
  }

  private func uploadPending() async {
    refreshPending()
    guard pendingCount > 0 else {
      clearFailure()
      updateCompletedStatus()
      return
    }
    guard let receiverURL else {
      reportFailureMessage("Set a valid receiver URL in Settings before uploading.")
      return
    }

    do {
      for capture in try pendingStore.pendingCaptures() {
        status = .uploading
        do {
          try await uploader.upload(capture, to: receiverURL)
          recordUploadSuccess()
          try pendingStore.remove(capture)
        } catch {
          refreshPending()
          reportFailure(error)
          return
        }
        refreshPending()
      }
      clearFailure()
      updateCompletedStatus()
    } catch {
      refreshPending()
      reportFailure(error)
    }
  }

  private func refreshPending() {
    do {
      pendingCount = try pendingStore.pendingCaptures().count
      if pendingCount > 0, status == .ready {
        status = .pending(pendingCount)
      } else if pendingCount == 0, status == .pending(0) {
        status = .ready
      }
    } catch {
      reportFailure(error)
    }
  }

  private func updateCompletedStatus() {
    status = pendingCount > 0 ? .pending(pendingCount) : .ready
  }

  private func clearFailure() {
    if case .failure = status {
      status = pendingCount > 0 ? .pending(pendingCount) : .ready
    }
  }

  private func recordUploadSuccess() {
    let now = Date()
    lastUploadAt = now
    defaults.set(now, forKey: DefaultsKey.lastUploadAt)
  }

  private func reportFailure(_ error: Error) {
    refreshScreenRecordingPermission()
    reportFailureMessage(error.localizedDescription)
  }

  private func reportFailureMessage(_ message: String) {
    status = .failure(message)
  }
}
