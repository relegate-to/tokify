package io.github.finchett.tokify.argon2

import com.lambdapioneer.argon2kt.Argon2Kt
import com.lambdapioneer.argon2kt.Argon2Mode
import com.lambdapioneer.argon2kt.Argon2Version
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

@OptIn(ExperimentalStdlibApi::class)
class TokifyArgon2Module : Module() {
  override fun definition() = ModuleDefinition {
    Name("TokifyArgon2")

    AsyncFunction("hashHex") { passwordHex: String, saltHex: String, iterations: Int, memoryKiB: Int, parallelism: Int, length: Int ->
      Argon2Kt().hash(
        mode = Argon2Mode.ARGON2_ID,
        password = passwordHex.hexToByteArray(),
        salt = saltHex.hexToByteArray(),
        tCostInIterations = iterations,
        mCostInKibibyte = memoryKiB,
        parallelism = parallelism,
        hashLengthInBytes = length,
        version = Argon2Version.V13,
      ).rawHashAsHexadecimal()
    }
  }
}
