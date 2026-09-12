import Foundation
import XCTest

@testable import ScreenCaptureCollector

private final class StubCaptureSource: ScreenCaptureSource {
  let image: Data
  private(set) var captureCount = 0

  init(image: Data = Data("png".utf8)) {
    self.image = image
  }

  func capturePNG() throws -> Data {
    captureCount += 1
    return image
  }
}

private actor StubUploadTransport: CaptureUploadTransport {
  private var statuses: [Int]
  private(set) var requests: [URLRequest] = []

  init(statuses: [Int]) {
    self.statuses = statuses
  }

  func send(_ request: URLRequest) async throws -> Int {
    requests.append(request)
    return statuses.isEmpty ? 200 : statuses.removeFirst()
  }
}

@MainActor
final class CollectorTests: XCTestCase {
  func testReceiverURLValidationMatchesTheShellContract() throws {
    XCTAssertNotNil(
      ReceiverURLValidator.validate(
        "https://bot.example.ts.net/v1/screen-captures"
      )
    )
    XCTAssertNotNil(
      ReceiverURLValidator.validate(
        "https://bot.example.ts.net:8444/v1/screen-captures"
      )
    )
    XCTAssertNotNil(
      ReceiverURLValidator.validate(
        "https://BOT.Example.ts.net:65535/v1/screen-captures"
      )
    )
    XCTAssertNotNil(
      ReceiverURLValidator.validate(
        "https://bot.example.ts.net:00001/v1/screen-captures"
      )
    )

    for value in [
      "",
      "http://bot.example.ts.net/v1/screen-captures",
      "https://bot.example.com/v1/screen-captures",
      "https://ts.net/v1/screen-captures",
      "https://bot.example.ts.net:0/v1/screen-captures",
      "https://bot.example.ts.net:65536/v1/screen-captures",
      "https://bot.example.ts.net:0000001/v1/screen-captures",
      "https://bot.example.ts.net/v1/screen-captures?x=1",
      "https://user@bot.example.ts.net/v1/screen-captures",
      "https://bot.example.ts.net/other",
    ] {
      XCTAssertNil(ReceiverURLValidator.validate(value), value)
    }

    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let defaults = makeDefaults()
    let model = CollectorModel(
      defaults: defaults,
      pendingStore: PendingCaptureStore(directoryURL: directory),
      captureSource: StubCaptureSource()
    )
    XCTAssertFalse(model.saveReceiverURL("https://public.example/v1/screen-captures"))
    XCTAssertNil(defaults.string(forKey: CollectorModel.DefaultsKey.receiverURL))
    XCTAssertTrue(model.saveReceiverURL("https://bot.example.ts.net/v1/screen-captures"))
    let restored = CollectorModel(
      defaults: defaults,
      pendingStore: PendingCaptureStore(directoryURL: directory),
      captureSource: StubCaptureSource()
    )
    XCTAssertEqual(restored.receiverURLString, "https://bot.example.ts.net/v1/screen-captures")
  }

  func testOnlyHTTP200AcknowledgesAndPendingPNGIsRetainedUntilRetrySucceeds() async throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = PendingCaptureStore(directoryURL: directory)
    let source = StubCaptureSource()
    let transport = StubUploadTransport(statuses: [201, 302, 500, 200])
    let defaults = makeDefaults()
    let model = CollectorModel(
      defaults: defaults,
      pendingStore: store,
      captureSource: source,
      uploader: CaptureUploader(transport: transport)
    )
    XCTAssertTrue(model.saveReceiverURL("https://bot.example.ts.net:8444/v1/screen-captures"))

    XCTAssertTrue(CaptureUploader.isAcknowledged(statusCode: 200))
    XCTAssertFalse(CaptureUploader.isAcknowledged(statusCode: 201))
    XCTAssertFalse(CaptureUploader.isAcknowledged(statusCode: 204))
    XCTAssertFalse(CaptureUploader.isAcknowledged(statusCode: 302))

    await model.captureNow()
    var pending = try store.pendingCaptures()
    XCTAssertEqual(pending.count, 1)
    let original = try XCTUnwrap(pending.first)
    XCTAssertEqual(model.pendingCount, 1)
    XCTAssertTrue(model.statusDescription.hasPrefix("Failure:"))

    for status in [302, 500] {
      await model.retryPending()
      pending = try store.pendingCaptures()
      XCTAssertEqual(pending.map(\.id), [original.id], "HTTP \(status) must retain the PNG")
    }

    await model.retryPending()
    XCTAssertTrue(try store.pendingCaptures().isEmpty)
    XCTAssertEqual(model.pendingCount, 0)
    XCTAssertEqual(model.statusDescription, "Recording")
    XCTAssertNotNil(model.lastUploadAt)
    XCTAssertEqual(
      defaults.object(forKey: CollectorModel.DefaultsKey.lastUploadAt) as? Date, model.lastUploadAt)

    let requests = await transport.requests
    XCTAssertEqual(requests.count, 4)
    XCTAssertEqual(
      requests.map { $0.value(forHTTPHeaderField: "X-Capture-Id") },
      Array(repeating: original.id.uuidString.lowercased(), count: 4)
    )
  }

  func testIntervalAndPauseArePersistedAndPauseSkipsAutomaticCapture() async throws {
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let defaults = makeDefaults()
    let source = StubCaptureSource()
    let model = CollectorModel(
      defaults: defaults,
      pendingStore: PendingCaptureStore(directoryURL: directory),
      captureSource: source
    )

    XCTAssertEqual(CaptureInterval.allCases.map(\.rawValue), [30, 60, 300])
    XCTAssertEqual(model.interval, .oneMinute)
    XCTAssertEqual(model.automaticCaptureInterval, 60)
    XCTAssertEqual(model.statusDescription, "Recording")
    model.setInterval(.fiveMinutes)
    XCTAssertEqual(model.automaticCaptureInterval, 300)
    model.setPaused(true)
    XCTAssertNil(model.automaticCaptureInterval)
    XCTAssertEqual(model.statusDescription, "Paused")
    await model.performAutomaticCapture()
    XCTAssertEqual(source.captureCount, 0)

    let restored = CollectorModel(
      defaults: defaults,
      pendingStore: PendingCaptureStore(directoryURL: directory),
      captureSource: StubCaptureSource()
    )
    XCTAssertEqual(restored.interval, .fiveMinutes)
    XCTAssertTrue(restored.isPaused)
    XCTAssertEqual(restored.statusDescription, "Paused")
  }

  private func makeDefaults() -> UserDefaults {
    let suite = "ScreenCaptureCollectorTests.\(UUID().uuidString)"
    let defaults = try! XCTUnwrap(UserDefaults(suiteName: suite))
    defaults.removePersistentDomain(forName: suite)
    return defaults
  }

  private func makeTemporaryDirectory() throws -> URL {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("screen-capture-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true,
      attributes: nil
    )
    return directory
  }
}
