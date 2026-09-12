import Foundation

enum CaptureInterval: Int, CaseIterable, Identifiable {
  case thirtySeconds = 30
  case oneMinute = 60
  case fiveMinutes = 300

  var id: Int { rawValue }
  var seconds: TimeInterval { TimeInterval(rawValue) }

  var title: String {
    switch self {
    case .thirtySeconds:
      "30 seconds"
    case .oneMinute:
      "1 minute"
    case .fiveMinutes:
      "5 minutes"
    }
  }
}
