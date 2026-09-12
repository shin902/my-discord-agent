import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum ScreenRecordingPermissionStatus: Equatable {
  case granted
  case required

  var title: String {
    switch self {
    case .granted:
      "Screen Recording: Allowed"
    case .required:
      "Screen Recording: Required"
    }
  }

  var symbolName: String {
    switch self {
    case .granted:
      "checkmark.shield"
    case .required:
      "exclamationmark.shield"
    }
  }
}

enum ScreenCaptureError: LocalizedError {
  case screenRecordingPermission
  case encodingFailed

  var errorDescription: String? {
    switch self {
    case .screenRecordingPermission:
      "Screen Recording permission is required. Allow this app in System Settings > Privacy & Security > Screen Recording, then try again."
    case .encodingFailed:
      "The main display image could not be encoded as PNG."
    }
  }
}

protocol ScreenCaptureSource {
  func capturePNG() throws -> Data
}

struct MainDisplayCaptureSource: ScreenCaptureSource {
  static var screenRecordingPermissionStatus: ScreenRecordingPermissionStatus {
    CGPreflightScreenCaptureAccess() ? .granted : .required
  }

  func capturePNG() throws -> Data {
    guard Self.screenRecordingPermissionStatus == .granted else {
      _ = CGRequestScreenCaptureAccess()
      throw ScreenCaptureError.screenRecordingPermission
    }
    guard let image = CGDisplayCreateImage(CGMainDisplayID()) else {
      throw ScreenCaptureError.screenRecordingPermission
    }

    let data = NSMutableData()
    guard
      let destination = CGImageDestinationCreateWithData(
        data,
        UTType.png.identifier as CFString,
        1,
        nil
      )
    else {
      throw ScreenCaptureError.encodingFailed
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
      throw ScreenCaptureError.encodingFailed
    }
    return data as Data
  }
}
