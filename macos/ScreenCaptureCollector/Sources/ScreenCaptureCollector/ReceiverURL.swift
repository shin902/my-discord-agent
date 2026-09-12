import Foundation

/// The receiver URL contract shared with scripts/capture-screen.sh.
enum ReceiverURLValidator {
  static let capturePath = "/v1/screen-captures"

  private static let pattern = #"^https://[A-Za-z0-9.-]+\.ts\.net(?::[0-9]+)?/v1/screen-captures\z"#

  static func validate(_ value: String) -> URL? {
    guard value.range(of: pattern, options: .regularExpression) != nil,
      let components = URLComponents(string: value),
      components.scheme == "https",
      components.host?.range(of: #"^[A-Za-z0-9.-]+\.ts\.net\z"#, options: .regularExpression)
        != nil,
      components.path == capturePath,
      components.query == nil,
      components.fragment == nil,
      components.user == nil,
      components.password == nil,
      let url = components.url,
      url.absoluteString == value
    else {
      return nil
    }

    let authority = value.dropFirst("https://".count)
      .dropLast(capturePath.count)
    if let separator = authority.lastIndex(of: ":") {
      let portText = authority[authority.index(after: separator)...]
      guard portText.count <= 5,
        let port = Int(portText),
        (1...65_535).contains(port)
      else {
        return nil
      }
    }
    return url
  }
}
