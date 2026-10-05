import Argon2Swift
import ExpoModulesCore

public class TokifyArgon2Module: Module {
  public func definition() -> ModuleDefinition {
    Name("TokifyArgon2")

    AsyncFunction("hashHex") { (passwordHex: String, saltHex: String, iterations: Int, memoryKiB: Int, parallelism: Int, length: Int) throws -> String in
      let result = try Argon2Swift.hashPasswordBytes(
        password: try bytes(passwordHex),
        salt: Salt(bytes: try bytes(saltHex)),
        iterations: iterations,
        memory: memoryKiB,
        parallelism: parallelism,
        length: length,
        type: .id,
        version: .V13
      )
      return result.hashData().map { String(format: "%02x", $0) }.joined()
    }
  }
}

private struct InvalidHexException: Error {}

private func bytes(_ hex: String) throws -> Data {
  guard hex.count % 2 == 0 else { throw InvalidHexException() }
  var data = Data(capacity: hex.count / 2)
  var i = hex.startIndex
  while i < hex.endIndex {
    let j = hex.index(i, offsetBy: 2)
    guard let b = UInt8(hex[i..<j], radix: 16) else { throw InvalidHexException() }
    data.append(b)
    i = j
  }
  return data
}
