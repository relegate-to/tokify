Pod::Spec.new do |s|
  s.name           = 'TokifyArgon2'
  s.version        = '0.1.0'
  s.summary        = 'Argon2id for Tokify'
  s.description    = 'Argon2id over raw bytes, matching the desktop sync key derivation.'
  s.license        = 'GPL-3.0-or-later'
  s.author         = 'Tokify'
  s.homepage       = 'https://github.com/finchett/tokify'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'Argon2Swift', '~> 1.0'

  s.source_files = "**/*.{h,m,swift}"
end
