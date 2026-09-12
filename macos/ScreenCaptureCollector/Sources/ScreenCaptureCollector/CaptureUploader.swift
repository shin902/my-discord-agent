import Foundation

enum CaptureUploadError: LocalizedError {
  case invalidReceiverURL
  case unreadableCapture
  case invalidResponse
  case unexpectedStatus(Int)

  var errorDescription: String? {
    switch self {
    case .invalidReceiverURL:
      "The receiver URL is not a valid HTTPS .ts.net endpoint."
    case .unreadableCapture:
      "A pending PNG could not be read."
    case .invalidResponse:
      "The receiver returned an invalid response."
    case .unexpectedStatus(let status):
      "The receiver did not acknowledge the capture (HTTP \(status))."
    }
  }
}

protocol CaptureUploadTransport {
  func send(_ request: URLRequest) async throws -> Int
}

private final class NoRedirectURLSessionDelegate: NSObject, URLSessionTaskDelegate {
  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}

private final class URLSessionCaptureUploadTransport: CaptureUploadTransport {
  private let session: URLSession
  private let delegate: NoRedirectURLSessionDelegate

  init() {
    let delegate = NoRedirectURLSessionDelegate()
    self.delegate = delegate
    self.session = URLSession(
      configuration: .ephemeral,
      delegate: delegate,
      delegateQueue: nil
    )
  }

  func send(_ request: URLRequest) async throws -> Int {
    let (_, response) = try await session.data(for: request)
    guard let response = response as? HTTPURLResponse else {
      throw CaptureUploadError.invalidResponse
    }
    return response.statusCode
  }
}

final class CaptureUploader {
  private let transport: any CaptureUploadTransport

  init(transport: any CaptureUploadTransport = URLSessionCaptureUploadTransport()) {
    self.transport = transport
  }

  static func isAcknowledged(statusCode: Int) -> Bool {
    statusCode == 200
  }

  func upload(_ capture: PendingCapture, to receiverURL: URL) async throws {
    guard ReceiverURLValidator.validate(receiverURL.absoluteString) != nil else {
      throw CaptureUploadError.invalidReceiverURL
    }
    let image: Data
    do {
      image = try Data(contentsOf: capture.url)
    } catch {
      throw CaptureUploadError.unreadableCapture
    }

    var request = URLRequest(url: receiverURL)
    request.httpMethod = "POST"
    request.setValue("image/png", forHTTPHeaderField: "Content-Type")
    request.setValue(
      capture.id.uuidString.lowercased(),
      forHTTPHeaderField: "X-Capture-Id"
    )
    request.httpBody = image

    let statusCode = try await transport.send(request)
    guard Self.isAcknowledged(statusCode: statusCode) else {
      throw CaptureUploadError.unexpectedStatus(statusCode)
    }
  }
}
