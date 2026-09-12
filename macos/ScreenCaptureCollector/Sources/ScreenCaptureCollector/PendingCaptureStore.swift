import Foundation

struct PendingCapture: Identifiable, Equatable {
  let id: UUID
  let url: URL

  var filename: String { url.lastPathComponent }
}

enum PendingCaptureStoreError: LocalizedError {
  case emptyImage

  var errorDescription: String? {
    switch self {
    case .emptyImage:
      "The captured PNG was empty."
    }
  }
}

final class PendingCaptureStore {
  let directoryURL: URL
  private let fileManager: FileManager

  init(
    directoryURL: URL = PendingCaptureStore.defaultDirectoryURL,
    fileManager: FileManager = .default
  ) {
    self.directoryURL = directoryURL
    self.fileManager = fileManager
  }

  static var defaultDirectoryURL: URL {
    let applicationSupport =
      FileManager.default.urls(
        for: .applicationSupportDirectory,
        in: .userDomainMask
      ).first ?? FileManager.default.homeDirectoryForCurrentUser
    return
      applicationSupport
      .appendingPathComponent("my-discord-agent", isDirectory: true)
      .appendingPathComponent("screen-captures", isDirectory: true)
  }

  func enqueue(_ image: Data, id: UUID = UUID()) throws -> PendingCapture {
    guard !image.isEmpty else { throw PendingCaptureStoreError.emptyImage }
    try ensureDirectory()
    let capture = PendingCapture(id: id, url: fileURL(for: id))
    try image.write(to: capture.url, options: .atomic)
    try fileManager.setAttributes(
      [.posixPermissions: NSNumber(value: 0o600)],
      ofItemAtPath: capture.url.path
    )
    return capture
  }

  func pendingCaptures() throws -> [PendingCapture] {
    try ensureDirectory()
    return try fileManager.contentsOfDirectory(
      at: directoryURL,
      includingPropertiesForKeys: nil,
      options: [.skipsHiddenFiles]
    )
    .compactMap { url in
      guard url.pathExtension.lowercased() == "png",
        let id = UUID(uuidString: url.deletingPathExtension().lastPathComponent)
      else {
        return nil
      }
      return PendingCapture(id: id, url: url)
    }
    .sorted { $0.filename < $1.filename }
  }

  func remove(_ capture: PendingCapture) throws {
    try fileManager.removeItem(at: capture.url)
  }

  private func fileURL(for id: UUID) -> URL {
    directoryURL.appendingPathComponent("\(id.uuidString.lowercased()).png")
  }

  private func ensureDirectory() throws {
    try fileManager.createDirectory(
      at: directoryURL,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: NSNumber(value: 0o700)]
    )
    try fileManager.setAttributes(
      [.posixPermissions: NSNumber(value: 0o700)],
      ofItemAtPath: directoryURL.path
    )
  }
}
